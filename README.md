# media-meta

Deterministic modern-image metadata reader: **EXIF + XMP from HEIC / HEIF / AVIF / WebP**, as a zero-dependency npm engine (`@nopilot/media-meta-engine`) plus a local-first MCP server (`@nopilot/media-meta-mcp`).

**Why this exists:** the JS ecosystem's EXIF workhorses are frozen in the JPEG/TIFF era — `exif-parser` (~4.7M weekly downloads) last shipped in **2017**, and the actively maintained `exif-reader` (~500k weekly) still takes a raw TIFF buffer and leaves container decoding (where modern formats actually keep their metadata) to someone else. Phones default to HEIC; the modern web runs on WebP/AVIF. Reading their metadata in Node today means gluing together container parsers and EXIF decoders yourself — this package is that, done once, tested, and MIT.

**Verified gap (2026-11-15):** `exif-reader@2.0.3` (latest) source declares a single `exif(buffer)` entry that parses a TIFF header at offset 0 (`index.js`; types `Exif = { bigEndian, Image?, Photo?, Iop?, GPSInfo?, Thumbnail? }`); its README documents JPEG usage via the separate `jpg-stream` package. There is **no** HEIC/HEIF/AVIF/WebP container support — no ISOBMFF box walking, no RIFF chunk parsing, zero occurrences of `heic|heif|avif|webp|ftyp` in the package. The differentiation stands.

## The local-first difference

Online EXIF viewers and hosted metadata APIs want your photos uploaded. Location history, device fingerprints, timestamps — exactly the metadata you should not paste into a web form.

`media-meta` runs **entirely on your machine**:

| | hosted EXIF websites / APIs | media-meta |
|---|---|---|
| Where your photos go | uploaded to their server | never leave the process |
| Works offline | no | yes |
| HEIC / AVIF / WebP | rarely (JPEG-era mostly) | first-class |
| Dependencies | — | engine has **zero** runtime deps |
| Source available | mostly closed | MIT, full tests |

Three hard guarantees (enforced by design and tests):

1. **Deterministic action tools, not AI wrappers** — no LLM calls anywhere; identical input produces identical output.
2. **Pure local computation** — zero network requests; even the test fixtures are **programmatically generated** minimal HEIC/AVIF/WebP files (no downloaded binaries — the fixture builders ship in the package).
3. **Runs locally, no hosted gateway** — stdio or localhost HTTP, bind 127.0.0.1 by default.

## What it reads

- **HEIC / HEIF / AVIF**: ISOBMFF `meta` box → `iinf` item info + `iloc` item locations → `Exif` item (TIFF payload, incl. the 4-byte offset prefix per ISO 23008-12) and XMP (`mime` item). Both endian-ness TIFF.
- **WebP**: RIFF container → `EXIF` chunk (with or without the 4-byte TIFF-offset prefix) and `XMP ` chunk.
- **EXIF groups**: IFD0 (Make, Model, Orientation, DateTime, ...), Exif sub-IFD (ExposureTime, FNumber, ISO, PixelXDimension, ...), GPS sub-IFD (lat/lon refs + rationals, altitude, ...).
- Container box/chunk listing, brand detection (`heic/heix/mif1/msf1/avif/avis/...`), structured warnings for truncated/dangling payloads (reported, never thrown mid-parse).

Not covered (by design): pixel decoding, ICC profiles, thumbnail bitmaps. This is a metadata reader.

## Tools (MCP)

### `image_metadata_read`

One local file in → `{ container, brand, exif: { bigEndian, IFD0, Exif?, GPS? }, xmp?, boxes?, warnings }` out. Options to trim `xmp`/`boxes` from the response.

## Install & run

```bash
npm install -g @nopilot/media-meta-mcp
media-meta-mcp                          # stdio (default)
media-meta-mcp --transport http --port 9440   # stateless Streamable HTTP on 127.0.0.1
```

MCP client config (stdio):

```json
{
  "mcpServers": {
    "media-meta": { "command": "media-meta-mcp" }
  }
}
```

## Engine usage (npm)

```js
import { readMetaFile, readMetaBuffer } from '@nopilot/media-meta-engine';

const meta = await readMetaFile('IMG_0001.heic');
// → { container: 'heic', brand: 'heic',
//     exif: { bigEndian: true, IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro', Orientation: 6, ... },
//             Exif: { ISOSpeedRatings: 200, ... }, GPS: { GPSLatitude: [37, 30, 0], ... } },
//     xmp: '<?xpacket ...', boxes: [...], warnings: [] }
```

Fixture builders (also exported — generate legal minimal files with zero network):

```js
import { buildHeicFixture, buildWebp, buildExifPayload } from '@nopilot/media-meta-engine';
const bytes = buildHeicFixture(); // ftyp+meta(iinf/iloc)+mdat with EXIF+XMP items
```

## Development

```bash
npm install
npm test              # build + typecheck + 16 vitest tests + determinism harness
npm run determinism   # byte-equality spot checks only
npm run publish:dry   # npm publish --dry-run for both packages
```

## Dependencies & licenses

Runtime dependencies:

| package | version | license | role |
|---|---|---|---|
| *(engine)* | — | — | **zero runtime dependencies** — pure first-party byte parsing |
| @modelcontextprotocol/sdk | ^1.32.2 | MIT | official MCP TypeScript SDK (server package only) |
| zod | ^4.6.7 | MIT | tool input schema |
| express | ^5.2.1 | MIT | HTTP transport host |

All transitive runtime dependencies (server package) are MIT/Apache-2.0/BSD/ISC — no GPL/AGPL anywhere in the tree. No image decoders (libheif/mozjpeg/etc.) are used or bundled: metadata boxes are parsed directly, which is exactly why the engine can stay dependency-free.

License of this project: **MIT** (see [LICENSE](./LICENSE)).

## Publishing

This repo ships to **zero** registries by itself. See [PUBLISH.md](./PUBLISH.md) for the manual npm publish + MCP registry submission steps.
