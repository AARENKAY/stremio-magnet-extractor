const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const PORT = Number(process.env.PORT || 7000);
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_SOURCES = 10;
const DEFAULT_TORRENTIO = 'https://torrentio.strem.fun/sort=seeders';
const ADDON_VERSION = '1.3.0';

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
      title: 'Addon base URLs (comma-separated)',
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

function normalizeSources(raw) {
  return String(raw || '')
    .split(/\r?\n|\s*,\s*/)
    .map(s => s.trim())
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
      redirect: 'follow',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
      }
    });

    if (!response.ok) {
      const location = response.url && response.url !== url
        ? ` -> ${response.url}`
        : '';
      throw new Error(`HTTP ${response.status}${location}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

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

function magnetName(stream) {
  return (
    firstLine(stream?.behaviorHints?.filename) ||
    firstLine(stream?.description) ||
    firstLine(stream?.title) ||
    firstLine(stream?.name)
  );
}

function normalizeHash(value) {
  if (typeof value !== 'string') return null;

  let hash = value.trim();

  if (/^magnet:\?/i.test(hash)) {
    try {
      const xt = new URL(hash).searchParams.get('xt') || '';
      hash = xt.replace(/^urn:btih:/i, '');
    } catch (_) {
      return null;
    }
  }

  hash = hash
    .replace(/^torrent:\/\//i, '')
    .split(/[?#&]/, 1)[0]
    .trim();

  if (/^[a-fA-F0-9]{40}$/.test(hash)) return hash;
  if (/^[a-fA-F0-9]{64}$/.test(hash)) return hash;

  return null;
}

function extractHash(stream) {
  const candidates = [
    stream?.infoHash,
    stream?.url,
    stream?.externalUrl,
    stream?.playbackUrl
  ];

  for (const candidate of candidates) {
    const hash = normalizeHash(candidate);
    if (hash) return hash;
  }

  return null;
}

function extractMagnet(stream, hash) {
  const candidates = [
    stream?.url,
    stream?.externalUrl,
    stream?.playbackUrl
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate !== 'string' ||
      !/^magnet:\?/i.test(candidate.trim())
    ) {
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

  if (name) {
    parts.push(`dn=${encodeURIComponent(name)}`);
  }

  for (const tracker of trackerUrls(stream.sources)) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }

  return `magnet:?${parts.join('&')}`;
}

function streamLabel(stream) {
  const quality = stream?.name ? String(stream.name) : 'Torrent';
  const hash = String(stream.infoHash).slice(0, 8);

  return `🧲 ${quality} | ${hash}`;
}

builder.defineStreamHandler(async args => {
  const config = args.config || {};

  const sources = normalizeSources(
    config.sources || DEFAULT_TORRENTIO
  );

  const timeout = Math.max(
    1000,
    Math.min(
      30000,
      Number(config.timeout) || DEFAULT_TIMEOUT_MS
    )
  );

  const validSources = sources.filter(validHttpUrl);

  if (!validSources.length) {
    return { streams: [] };
  }

  console.log(
    `[request] ${args.type}/${args.id} -> ${validSources.length} source(s)`
  );

  const results = await Promise.all(
    validSources.map(async source => {
      const url = buildStreamUrl(
        source,
        args.type,
        args.id
      );

      try {
        const data = await fetchJson(url, timeout);

        return Array.isArray(data?.streams)
          ? data.streams
          : [];
      } catch (error) {
        console.warn(
          `[source failed] ${safeHost(url)} :: ${error.message}`
        );

        return [];
      }
    })
  );

  const streams = [];
  const seen = new Set();

  for (
    let sourceIndex = 0;
    sourceIndex < results.length;
    sourceIndex++
  ) {
    const group = results[sourceIndex];

    const sourceName = safeHost(
      validSources[sourceIndex]
    );

    for (const sourceStream of group) {
      const hash = extractHash(sourceStream);

      if (!hash) continue;

      const magnet = extractMagnet(
        sourceStream,
        hash
      );

      if (!magnet) continue;

      const normalizedHash = hash.toLowerCase();

      const fileIdx = Number.isInteger(
        sourceStream.fileIdx
      )
        ? sourceStream.fileIdx
        : null;

      const key = `${normalizedHash}:${fileIdx ?? ''}`;

      if (seen.has(key)) continue;

      seen.add(key);

      const quality = sourceStream?.name
        ? String(sourceStream.name)
        : 'Torrent';

      const filename = firstLine(
        sourceStream?.behaviorHints?.filename
      );

      const size =
        firstLine(
          sourceStream?.behaviorHints?.videoSize
        ) ||
        firstLine(sourceStream?.videoSize);

      const seeders =
        sourceStream?.seeders ??
        sourceStream?.behaviorHints?.seeders;

      const details = [
        quality,
        filename && filename !== quality
          ? filename
          : '',
        size ? `Size: ${size}` : '',
        seeders != null
          ? `Seeders: ${seeders}`
          : '',
        `Source: ${sourceName}`
      ].filter(Boolean);

      streams.push({
        name: `🧲 ${quality}`,
        description:
          `${details.join(' • ')}\n${magnet}`,

        infoHash: hash,

        ...(fileIdx !== null
          ? { fileIdx }
          : {}),

        ...(Array.isArray(sourceStream.sources)
          ? {
              sources: sourceStream.sources
            }
          : {}),

        ...(sourceStream.behaviorHints
          ? {
              behaviorHints:
                sourceStream.behaviorHints
            }
          }
          : {})
      });
    }
  }

  console.log(
    `[result] ${args.type}/${args.id}: ${streams.length} torrent stream(s)`
  );

  return { streams };
});

serveHTTP(
  builder.getInterface(),
  {
    port: PORT,
    host: '0.0.0.0'
  }
);

console.log('');
console.log('Magnet Extractor is running.');

const LOCAL_IP =
  process.env.LOCAL_IP || '127.0.0.1';

console.log(
  `Manifest: http://${LOCAL_IP}:${PORT}/manifest.json`
);

console.log(
  `Install:  stremio://${LOCAL_IP}:${PORT}/manifest.json`
);

console.log(
  `Configure: http://${LOCAL_IP}:${PORT}/configure`
);

console.log(
  `LAN bind:  0.0.0.0:${PORT}`
);

console.log(
  `Default source: ${DEFAULT_TORRENTIO}`
);

console.log('');
