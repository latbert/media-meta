import type { MediaMeta, MediaKind, ExifGroups } from './types.js';
import { MediaMetaError } from './types.js';
import { parseBoxes, findBox, parseItemInfos, parseItemLocations } from './isobmff.js';
import { parseExif } from './exif.js';
import { parseWebp, extractWebpMetadata } from './webp.js';

export { MediaMetaError } from './types.js';
export type { MediaMeta, MediaKind, BoxRecord } from './types.js';
export { parseExif, buildExifPayload } from './exif.js';
export { parseWebp, extractWebpMetadata, buildWebp } from './webp.js';
export {
  buildIsobmffMedia,
  buildHeicFixture,
  buildAvifFixture,
  buildHeifXmpOnlyFixture,
} from './fixtures.js';

const ISOBMFF_EXIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'avio',
]);

const BRAND_TO_KIND: Record<string, MediaKind> = {
  heic: 'heic',
  heix: 'heic',
  hevc: 'heic',
  hevm: 'heic',
  hevs: 'heic',
  mif1: 'heif',
  msf1: 'heif',
  avif: 'avif',
  avis: 'avif',
  avio: 'avif',
};

/** Detect container kind from a buffer's signature. Throws when unrecognized. */
export function detectContainer(buf: Buffer): { kind: MediaKind; brand: string } {
  if (buf.length < 12) {
    throw new MediaMetaError('file_too_small', `File is ${buf.length} bytes; need at least 12`);
  }
  const riff = buf.toString('latin1', 0, 4);
  if (riff === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'webp', brand: 'WEBP' };
  }
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const major = buf.toString('latin1', 8, 12);
    if (ISOBMFF_EXIF_BRANDS.has(major)) {
      return { kind: BRAND_TO_KIND[major] ?? 'heif', brand: major };
    }
    throw new MediaMetaError(
      'unsupported_brand',
      `ftyp major brand "${major}" is not a HEIC/HEIF/AVIF brand`,
    );
  }
  throw new MediaMetaError('unknown_container', 'Not an ISOBMFF (HEIC/HEIF/AVIF) or RIFF/WebP file');
}

function flatBoxes(buf: Buffer, start: number, end: number, acc: { type: string; size: number }[], depth = 0): void {
  const boxes = parseBoxes(buf, start, end, depth);
  for (const b of boxes) {
    acc.push({ type: b.type, size: b.size });
    // recurse into the standard container boxes we care about
    if (b.type === 'meta') {
      const fullBoxSkip = 4;
      flatBoxes(b.payload, fullBoxSkip, b.payload.length, acc, depth + 1);
    }
  }
}

/**
 * Read metadata from an image buffer: HEIC/HEIF/AVIF via ISOBMFF item metadata,
 * WebP via RIFF EXIF/XMP chunks. Pure local byte parsing; deterministic.
 */
export function readMetaBuffer(buf: Buffer): MediaMeta {
  const { kind, brand } = detectContainer(buf);
  const warnings: string[] = [];
  const boxes: { type: string; size: number }[] = [];

  if (kind === 'webp') {
    const chunks = parseWebp(buf);
    for (const c of chunks) boxes.push({ type: c.fourcc, size: c.payload.length + 8 });
    const { exif, xmp } = extractWebpMetadata(chunks);
    let exifOut: ExifGroups | undefined;
    if (exif) {
      const parsed = parseExif(exif);
      if (parsed) {
        exifOut = groupExif(parsed);
      } else {
        warnings.push('EXIF chunk present but TIFF header did not parse');
      }
    }
    return {
      container: 'webp',
      brand,
      boxes,
      warnings,
      ...(exifOut ? { exif: exifOut } : {}),
      ...(xmp ? { xmp: xmp.toString('utf8') } : {}),
    };
  }

  // ISOBMFF path
  const top = parseBoxes(buf, 0, buf.length, 0);
  for (const b of top) boxes.push({ type: b.type, size: b.size });
  const meta = findBox(top, 'meta');
  if (!meta) {
    return { container: kind, brand, boxes, warnings: ['no meta box found — file carries no item metadata'] };
  }
  flatBoxes(buf, meta.start + 8 + 4, meta.start + meta.size, boxes, 1);

  const itemInfos = parseItemInfos(meta);
  const locations = parseItemLocations(meta, buf.length);

  let exifOut: ExifGroups | undefined;
  let xmp: string | undefined;

  for (const info of itemInfos) {
    const loc = locations.get(info.itemId);
    if (!loc) {
      warnings.push(`item ${info.itemId} (${info.itemType}) has no locatable extents`);
      continue;
    }
    const payload = loc.extents.map((e) => buf.subarray(e.offset, e.offset + e.length));
    const joined = payload.length === 1 ? payload[0] : Buffer.concat(payload);
    if (info.itemType === 'Exif') {
      // HEIF Exif item: 4-byte offset-to-TIFF-header prefix
      const tiff = joined.subarray(4);
      const parsed = parseExif(tiff);
      if (parsed) {
        exifOut = groupExif(parsed);
      } else {
        warnings.push('Exif item present but TIFF header did not parse');
      }
    } else if (info.itemType === 'mime') {
      const text = joined.toString('utf8');
      if (text.includes('<x:xmpmeta') || text.includes('<x:XMP') || text.includes('xpacket')) {
        xmp = text;
      }
    }
  }

  return {
    container: kind,
    brand,
    boxes,
    warnings,
    ...(exifOut ? { exif: exifOut } : {}),
    ...(xmp ? { xmp } : {}),
  };
}

function groupExif(parsed: {
  bigEndian: boolean;
  ifd0: Record<string, unknown>;
  exif: Record<string, unknown>;
  gps: Record<string, unknown>;
}): ExifGroups {
  const out: ExifGroups = {
    bigEndian: parsed.bigEndian,
    IFD0: parsed.ifd0,
  };
  if (Object.keys(parsed.exif).length > 0) out.Exif = parsed.exif;
  if (Object.keys(parsed.gps).length > 0) out.GPS = parsed.gps;
  return out;
}

/** File-path convenience wrapper. */
export async function readMetaFile(path: string): Promise<MediaMeta> {
  const { readFile } = await import('node:fs/promises');
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    throw new MediaMetaError(
      'file_unreadable',
      `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return readMetaBuffer(buf);
}

export { detectContainer as detectImageContainer };
