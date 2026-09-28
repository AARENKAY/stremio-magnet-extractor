# Stremio Universal Magnet Extractor

A small Stremio addon that queries configured Stremio addon stream endpoints and extracts torrent hashes/magnets from their results.

## Supported torrent forms

- `infoHash` (40-character BitTorrent v1 or 64-character hash)
- `magnet:?xt=urn:btih:...` in `url`, `externalUrl`, or `playbackUrl`
- `torrent://...` in those fields

The addon deduplicates by hash + `fileIdx`, preserves `fileIdx`, `sources`, and `behaviorHints`, and shows the generated/extracted magnet in the stream description.

## Default source

Torrentio:
`https://torrentio.strem.fun/sort=seeders`

Additional source addons can be entered as comma-separated base URLs. A source may also be a template containing `{type}` and `{id}`.

## Termux

Keep the project under `~/`, not `/storage/emulated/0/`.

```sh
cd ~/stremio-magnet-extractor
npm install
npm start
```

The server listens on `0.0.0.0:7000`.

To launch Stremio from Termux while the server is running:

```sh
npm run stremio-install
```

For LAN installation from another device on the same network:

```sh
LOCAL_IP=192.168.0.151 npm run stremio-install-lan
```

Replace the IP with the phone's current LAN address.

## Browser checks

```text
http://127.0.0.1:7000/manifest.json
http://127.0.0.1:7000/configure
```
