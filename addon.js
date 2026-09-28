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
const DEFAULT_SOURCES = [
  'https://comet.elfhosted.com'
];
const ADDON_VERSION = '1.5.0';
const CACHE_MAX_AGE_S = 900;
const ENABLE_1337X = process.env.ENABLE_1337X !== '0';
const X1337_BASE = 'https://1337x.to';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const MAX_1337X_RESULTS = 10;

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
      default: DEFAULT_SOURCES,
      required: false
    },
    {
      key: 'enable1337x',
      type: 'checkbox',
      title: 'Search 1337x',
      default: ENABLE_1337X,
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

/* ---------- 1337x search ---------- */

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: BLOCK_PRIVATE_SOURCES ? 'error' : 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
      }
    });

    if (!response.ok) {
      const redirected = response.url && response.url !== url
        ? ` -> ${safeHost(response.url)}`
        : '';
      throw new Error(`HTTP ${response.status}${redirected}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function htmlToText(value) {
  return decodeHtml(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function absolute1337xUrl(href) {
  try {
    return new URL(href, X1337_BASE).href;
  } catch (_) {
    return null;
  }
}

function extract1337xLinks(html) {
  const links = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"']*\/torrent\/[^"']+)["']/gi;
  let match;

  while ((match = re.exec(html))) {
    const url = absolute1337xUrl(decodeHtml(match[1]));
    if (!url || !/^https?:\/\/[^/]*1337x\.to\/torrent\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
    if (links.length >= MAX_1337X_RESULTS) break;
  }

  return links;
}

function extract1337xMagnet(html) {
  const match = String(html || '').match(/magnet:\?[^"'<>\s]+/i);
  return match ? decodeHtml(match[0]) : null;
}

function extract1337xTitle(html) {
  const match = String(html || '').match(
    /<div[^>]*class=["'][^"']*box-info-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  return match ? htmlToText(match[1]) : '';
}

async function getCinemetaMeta(type, id, timeoutMs) {
  const imdbId = String(id).split(':', 1)[0];
  const url = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(imdbId)}.json`;
  const data = await fetchJson(url, timeoutMs);
  const meta = data?.meta;

  if (!meta?.name) throw new Error(`No Cinemeta metadata for ${imdbId}`);

  return {
    name: String(meta.name),
    year: meta.year ? String(meta.year).slice(0, 4) : ''
  };
}

function build1337xQuery(type, id, meta) {
  const name = meta?.name || String(id).split(':', 1)[0];

  if (type === 'series') {
    const parts = String(id).split(':');
    const season = Number(parts[1]);
    const episode = Number(parts[2]);

    if (Number.isInteger(season) && Number.isInteger(episode)) {
      return `${name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }
  }

  return meta?.year ? `${name} ${meta.year}` : name;
}

async function search1337x(type, id, timeoutMs) {
  const meta = await getCinemetaMeta(type, id, timeoutMs);
  const query = build1337xQuery(type, id, meta);
  const searchUrl = `${X1337_BASE}/search/${encodeURIComponent(query)}/1/`;
  const searchHtml = await fetchText(searchUrl, timeoutMs);
  const links = extract1337xLinks(searchHtml);

  if (!links.length) return [];

  const results = await Promise.all(
    links.map(async url => {
      try {
        const html = await fetchText(url, timeoutMs);
        const magnet = extract1337xMagnet(html);
        if (!magnet) return null;

        const title = extract1337xTitle(html) || query;

        return {
          name: '1337x',
          title,
          url: magnet,
          description: `1337x • ${title}`
        };
      } catch (error) {
        console.warn(`[1337x item failed] ${safeHost(url)} :: ${error.message}`);
        return null;
      }
    })
  );

  return results.filter(Boolean);
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

  const sources = normalizeSources(config.sources || DEFAULT_SOURCES);
  const enable1337x = config.enable1337x === undefined
    ? ENABLE_1337X
    : String(config.enable1337x).toLowerCase() === 'true';

  const timeout = Math.max(
    1000,
    Math.min(30000, Number(config.timeout) || DEFAULT_TIMEOUT_MS)
  );

  let validSources = sources.filter(validHttpUrl);

  if (BLOCK_PRIVATE_SOURCES) {
    const blocked = await Promise.all(validSources.map(s => isBlockedHost(s)));
    validSources = validSources.filter((_, i) => !blocked[i]);
  }

  const sourceCount = validSources.length + (enable1337x ? 1 : 0);

  if (!sourceCount) {
    return { streams: [], cacheMaxAge: 60 };
  }

  console.log(`[request] ${args.type}/${args.id} -> ${sourceCount} source(s)`);

  const results = await Promise.all([
    ...(enable1337x
      ? [search1337x(args.type, args.id, timeout).catch(error => {
          console.warn(`[source failed] 1337x.to :: ${error.message}`);
          return [];
        })]
      : []),
    ...validSources.map(async source => {
      const url = buildStreamUrl(source, args.type, args.id);

      try {
        const data = await fetchJson(url, timeout);
        return Array.isArray(data?.streams) ? data.streams : [];
      } catch (error) {
        console.warn(`[source failed] ${safeHost(url)} :: ${error.message}`);
        return [];
      }
    })
  ]);

  const streams = [];
  const seen = new Set();

  for (let sourceIndex = 0; sourceIndex < results.length; sourceIndex++) {
    const sourceName = enable1337x && sourceIndex === 0
      ? '1337x.to'
      : safeHost(validSources[enable1337x ? sourceIndex - 1 : sourceIndex]);

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
console.log(`Default source(s): ${DEFAULT_SOURCES.join(', ') || 'none'}`);
console.log(`1337x search: ${ENABLE_1337X ? 'on' : 'off'}`);
console.log(`Private-host blocking: ${BLOCK_PRIVATE_SOURCES ? 'on' : 'off'}`);
console.log('');
