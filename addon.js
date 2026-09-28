'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

if (typeof fetch !== 'function') {
  throw new Error('Node.js 18+ is required (global fetch).');
}

const PORT = Number(process.env.PORT || 7000);
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_SOURCES = 10;
const DEFAULT_TORRENTIO = 'https://torrentio.strem.fun/sort=seeders';
const ADDON_VERSION = '1.4.0';
const CACHE_MAX_AGE_S = 900;

// Opt-in SSRF guard. Set BLOCK_PRIVATE_SOURCES=1 if this addon is reachable
// by people you don't trust. Leave it off if your sources run on your LAN.
const BLOCK_PRIVATE_SOURCES = process.env.BLOCK_PRIVATE_SOURCES === '1';

const manifest = {
  id: 'com.example.stremio.magnetextractor',
  version: ADDON_VERSION,
  name: 'Magnet Extractor',
  description: 'Extracts torrent hashes and magnet links from configured Stremio addon stream endpoints.',
  resources: [
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
    p2p: true
  },
  config: [
    {
      key: 'sources',
      type: 'text',
      title: 'Addon base URLs (separate with spaces)',
      default: DEFAULT_TORRENTIO,
      required: false
    },
    {
      key: 'timeout',
      type: 'number',
      title: 'Timeout per source (ms)',
      default: String(DEFAULT_TIMEOUT_MS),
      required: false
    }
  ]
};

const builder = new addonBuilder(manifest);

/* ---------- sources ---------- */

// Split on whitespace, or on a comma that is followed by another URL.
// Commas *inside* a URL (e.g. Torrentio's providers=yts,eztv) are preserved.
function normalizeSources(raw) {
  return String(raw || '')
    .split(/\s+|,(?=https?:\/\/)/i)
    .map(s => s.trim().replace(/,+$/, ''))
    .filter(Boolean)
    .slice(0, MAX_SOURCES);
}

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Log only the host: source URLs often embed API keys (e.g. debrid tokens).
function safeHost(value) {
  try {
    return new URL(value).host;
  } catch (_) {
    return 'invalid-url';
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) {
      return isPrivateIp(v.slice(7));
    }
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }

  return false;
}

async function isBlockedHost(url) {
  if (!BLOCK_PRIVATE_SOURCES) return false;

  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host)
      ? [{ address: host }]
      : await dns.lookup(host, { all: true });

    return addrs.some(a => isPrivateIp(a.address));
  } catch (_) {
    return true; // fail closed
  }
}

function buildStreamUrl(baseOrTemplate, type, id) {
  const source = String(baseOrTemplate).trim().replace(/\/$/, '');
  const encodedType = encodeURIComponent(type);
  const encodedId = encodeURIComponent(id);

  if (source.includes('{type}') || source.includes('{id}')) {
    return source
      .replaceAll('{type}', encodedType)
      .replaceAll('{id}', encodedId);
  }

  return `${source}/stream/${encodedType}/${encodedId}.json`;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // Redirects could point at private addresses, so refuse them when the guard is on.
      redirect: BLOCK_PRIVATE_SOURCES ? 'error' : 'follow',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
      }
    });

    if (!response.ok) {
      // Host only: the full redirect URL can contain tokens.
      const redirected = response.url && response.url !== url
        ? ` -> ${safeHost(response.url)}`
        : '';
      throw new Error(`HTTP ${response.status}${redirected}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- stream parsing ---------- */

function trackerUrls(sources) {
  if (!Array.isArray(sources)) return [];

  return sources
    .filter(x => typeof x === 'string')
    .filter(x => x.startsWith('tracker:'))
    .map(x => x.slice('tracker:'.length))
    .filter(Boolean);
}

function firstLine(value) {
  if (typeof value !== 'string') return '';
  return value.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
}

// Prefer the torrent title over the file name: for season packs the file
// name would label the whole magnet with a single episode.
function magnetName(stream) {
  return (
    firstLine(stream?.title) ||
    firstLine(stream?.description) ||
    firstLine(stream?.behaviorHints?.filename)
  );
}

function streamText(stream) {
  return [stream?.title, stream?.description]
    .filter(x => typeof x === 'string')
    .join('\n');
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(i < 2 ? 0 : 2)} ${units[i]}`;
}

// videoSize is a number of bytes in most addons; some only put size in the text.
function streamSize(stream) {
  const raw = stream?.behaviorHints?.videoSize ?? stream?.videoSize;
  const bytes = Number(raw);

  if (Number.isFinite(bytes) && bytes > 0) return formatBytes(bytes);

  const m = streamText(stream).match(/💾\s*([\d.,]+\s*[KMGT]?i?B)/iu);
  return m ? m[1].trim() : '';
}

function streamSeeders(stream) {
  const raw = stream?.seeders ?? stream?.behaviorHints?.seeders;

  if (raw != null && raw !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }

  const m = streamText(stream).match(/👤\s*(\d+)/u);
  return m ? Number(m[1]) : null;
}

/* ---------- hashes & magnets ---------- */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 32-char base32 btih -> 40-char hex. Input must already match /^[A-Z2-7]{32}$/i.
function base32ToHex(input) {
  let bits = '';

  for (const ch of input.toUpperCase()) {
    bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  }

  let hex = '';

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return hex;
}

// Returns a lowercase 40-char hex info hash, or null.
// (64-char v2 hashes are rejected: Stremio's infoHash expects a v1 hash.)
function normalizeHash(value) {
  if (typeof value !== 'string') return null;

  let hash = value.trim();

  if (/^magnet:\?/i.test(hash)) {
    try {
      const xt = new URL(hash).searchParams
        .getAll('xt')
        .find(x => /^urn:btih:/i.test(x)) || '';

      hash = xt.replace(/^urn:btih:/i, '');
    } catch (_) {
      return null;
    }
  }

  hash = hash
    .replace(/^torrent:\/\//i, '')
    .split(/[?#&]/, 1)[0]
    .trim();

  if (/^[a-f0-9]{40}$/i.test(hash)) return hash.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(hash)) return base32ToHex(hash);

  return null;
}

// Debrid-configured addons return a resolve URL instead of an infoHash, with
// the hash as a path segment. The hash comes after the API key, so scan from the end.
function hashFromUrlPath(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;

  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);

    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^[a-f0-9]{40}$/i.test(segments[i])) return segments[i].toLowerCase();
    }
  } catch (_) {}

  return null;
}

function extractHash(stream) {
  const urls = [stream?.url, stream?.externalUrl, stream?.playbackUrl];

  for (const candidate of [stream?.infoHash, ...urls]) {
    const hash = normalizeHash(candidate);
    if (hash) return hash;
  }

  for (const candidate of urls) {
    const hash = hashFromUrlPath(candidate);
    if (hash) return hash;
  }

  return null;
}

function extractMagnet(stream, hash) {
  const candidates = [stream?.url, stream?.externalUrl, stream?.playbackUrl];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !/^magnet:\?/i.test(candidate.trim())) {
      continue;
    }

    try {
      const url = new URL(candidate.trim());
      if (!url.searchParams.get('xt')) continue;
      return candidate.trim();
    } catch (_) {}
  }

  if (!hash) return null;

  const parts = [`xt=urn:btih:${hash}`];
  const name = magnetName(stream);

  if (name) parts.push(`dn=${encodeURIComponent(name)}`);

  for (const tracker of new Set(trackerUrls(stream?.sources))) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }

  return `magnet:?${parts.join('&')}`;
}

/* ---------- handler ---------- */

builder.defineStreamHandler(async args => {
  const config = args.config || {};

  const sources = normalizeSources(config.sources || DEFAULT_TORRENTIO);

  const timeout = Math.max(
    1000,
    Math.min(30000, Number(config.timeout) || DEFAULT_TIMEOUT_MS)
  );

  let validSources = sources.filter(validHttpUrl);

  if (BLOCK_PRIVATE_SOURCES) {
    const blocked = await Promise.all(validSources.map(s => isBlockedHost(s)));
    validSources = validSources.filter((_, i) => !blocked[i]);
  }

  if (!validSources.length) {
    return { streams: [], cacheMaxAge: 60 };
  }

  console.log(`[request] ${args.type}/${args.id} -> ${validSources.length} source(s)`);

  const results = await Promise.all(
    validSources.map(async source => {
      const url = buildStreamUrl(source, args.type, args.id);

      try {
        const data = await fetchJson(url, timeout);
        return Array.isArray(data?.streams) ? data.streams : [];
      } catch (error) {
        console.warn(`[source failed] ${safeHost(url)} :: ${error.message}`);
        return [];
      }
    })
  );

  const streams = [];
  const seen = new Set();

  for (let sourceIndex = 0; sourceIndex < results.length; sourceIndex++) {
    const sourceName = safeHost(validSources[sourceIndex]);

    for (const sourceStream of results[sourceIndex]) {
      const hash = extractHash(sourceStream);
      if (!hash) continue;

      const magnet = extractMagnet(sourceStream, hash);
      if (!magnet) continue;

      const fileIdx = Number.isInteger(sourceStream.fileIdx)
        ? sourceStream.fileIdx
        : null;

      const key = `${hash}:${fileIdx ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const quality = sourceStream?.name ? String(sourceStream.name) : 'Torrent';
      const filename = firstLine(sourceStream?.behaviorHints?.filename);
      const size = streamSize(sourceStream);
      const seeders = streamSeeders(sourceStream);

      const details = [
        quality,
        filename && filename !== quality ? filename : '',
        size ? `Size: ${size}` : '',
        seeders != null ? `Seeders: ${seeders}` : '',
        `Source: ${sourceName}`
      ].filter(Boolean);

      streams.push({
        name: `🧲 ${quality}`,
        description: `${details.join(' • ')}\n${magnet}`,
        infoHash: hash,
        ...(fileIdx !== null ? { fileIdx } : {}),
        ...(Array.isArray(sourceStream.sources)
          ? { sources: sourceStream.sources }
          : {}),
        ...(sourceStream.behaviorHints
          ? { behaviorHints: sourceStream.behaviorHints }
          : {})
      });
    }
  }

  console.log(`[result] ${args.type}/${args.id}: ${streams.length} torrent stream(s)`);

  // Cache hits for a while, but retry empty/failed lookups quickly.
  return {
    streams,
    cacheMaxAge: streams.length ? CACHE_MAX_AGE_S : 60
  };
});

serveHTTP(builder.getInterface(), { port: PORT, host: '0.0.0.0' });

const LOCAL_IP = process.env.LOCAL_IP || '127.0.0.1';

console.log('');
console.log('Magnet Extractor is running.');
console.log(`Manifest:  http://${LOCAL_IP}:${PORT}/manifest.json`);
console.log(`Install:   stremio://${LOCAL_IP}:${PORT}/manifest.json`);
console.log(`Configure: http://${LOCAL_IP}:${PORT}/configure`);
console.log(`LAN bind:  0.0.0.0:${PORT}`);
console.log(`Default source: ${DEFAULT_TORRENTIO}`);
console.log(`Private-host blocking: ${BLOCK_PRIVATE_SOURCES ? 'on' : 'off'}`);
console.log('');
