/**
 * Minimal TIFF/EXIF (little- or big-endian) IFD walker for the payloads we
 * extract from HEIC/AVIF Exif items and WebP EXIF chunks.
 * Decodes the common value types (byte/ascii/short/long/rational/srational)
 * and maps a practical subset of well-known tags (no full EXIF spec dump).
 */

export interface ExifResult {
  /** true = big-endian ("MM"), false = little-endian ("II"). */
  bigEndian: boolean;
  /** IFD0 tags (ImageWidth, Make, Model, Orientation, DateTime, ...). */
  ifd0: Record<string, unknown>;
  /** Exif sub-IFD tags (ExposureTime, FNumber, ISO, ...). */
  exif: Record<string, unknown>;
  /** GPS sub-IFD tags. */
  gps: Record<string, unknown>;
}

const TAGS_IFD0: Record<number, string> = {
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013c: 'HostComputer',
  0x8298: 'Copyright',
};

const TAGS_EXIF: Record<number, string> = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISOSpeedRatings',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0x9286: 'UserComment',
  0xa430: 'CameraOwnerName',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
};

const TAGS_GPS: Record<number, string> = {
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x0012: 'GPSMapDatum',
};

const SUB_IFD_OFFSET_TAG = 0x8769; // Exif IFD pointer (in IFD0)
const GPS_IFD_OFFSET_TAG = 0x8825; // GPS IFD pointer (in IFD0)

function readU16(buf: Buffer, at: number, bigEndian: boolean): number {
  return bigEndian ? buf.readUInt16BE(at) : buf.readUInt16LE(at);
}
function readU32(buf: Buffer, at: number, bigEndian: boolean): number {
  return bigEndian ? buf.readUInt32BE(at) : buf.readUInt32LE(at);
}
function readI32(buf: Buffer, at: number, bigEndian: boolean): number {
  return bigEndian ? buf.readInt32BE(at) : buf.readInt32LE(at);
}

function readValue(
  buf: Buffer,
  entryOffset: number,
  bigEndian: boolean,
): { tag: number; value: unknown } {
  const tag = readU16(buf, entryOffset, bigEndian);
  const type = readU16(buf, entryOffset + 2, bigEndian);
  const count = readU32(buf, entryOffset + 4, bigEndian);

  const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const size = typeSizes[type] ?? 1;
  const totalBytes = size * count;
  const valueOffset =
    totalBytes <= 4 ? entryOffset + 8 : readU32(buf, entryOffset + 8, bigEndian);
  if (valueOffset + Math.min(totalBytes, 8) > buf.length) return { tag, value: undefined };

  switch (type) {
    case 2: {
      // ASCII, null-terminated
      const slice = buf.subarray(valueOffset, valueOffset + count);
      const end = slice.indexOf(0);
      return { tag, value: slice.toString('latin1', 0, end === -1 ? count : end) };
    }
    case 1:
    case 7: {
      if (count === 1) return { tag, value: buf[valueOffset] };
      return { tag, value: Array.from(buf.subarray(valueOffset, valueOffset + count)) };
    }
    case 3: {
      const out = Array.from({ length: count }, (_, i) => readU16(buf, valueOffset + i * 2, bigEndian));
      return { tag, value: count === 1 ? out[0] : out };
    }
    case 4: {
      const out = Array.from({ length: count }, (_, i) => readU32(buf, valueOffset + i * 4, bigEndian));
      return { tag, value: count === 1 ? out[0] : out };
    }
    case 9: {
      const out = Array.from({ length: count }, (_, i) => readI32(buf, valueOffset + i * 4, bigEndian));
      return { tag, value: count === 1 ? out[0] : out };
    }
    case 5: {
      // unsigned rational
      const out = Array.from(
        { length: count },
        (_, i) =>
          readU32(buf, valueOffset + i * 8, bigEndian) /
          Math.max(1, readU32(buf, valueOffset + i * 8 + 4, bigEndian)),
      );
      return { tag, value: count === 1 ? out[0] : out };
    }
    case 10: {
      // signed rational
      const out = Array.from(
        { length: count },
        (_, i) =>
          readI32(buf, valueOffset + i * 8, bigEndian) /
          (() => {
            const d = readI32(buf, valueOffset + i * 8 + 4, bigEndian);
            return d === 0 ? 1 : d;
          })(),
      );
      return { tag, value: count === 1 ? out[0] : out };
    }
    default:
      return { tag, value: undefined };
  }
}

function walkIfd(
  buf: Buffer,
  ifdOffset: number,
  bigEndian: boolean,
  tagNames: Record<number, string>,
  into: Record<string, unknown>,
): { exifIfdOffset?: number; gpsIfdOffset?: number } {
  if (ifdOffset + 2 > buf.length) return {};
  const entryCount = readU16(buf, ifdOffset, bigEndian);
  if (entryCount > 512) return {}; // sanity cap
  let exifIfdOffset: number | undefined;
  let gpsIfdOffset: number | undefined;
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > buf.length) break;
    const { tag, value } = readValue(buf, entryOffset, bigEndian);
    if (value === undefined) continue;
    if (tag === SUB_IFD_OFFSET_TAG && typeof value === 'number') {
      exifIfdOffset = value;
      continue;
    }
    if (tag === GPS_IFD_OFFSET_TAG && typeof value === 'number') {
      gpsIfdOffset = value;
      continue;
    }
    const name = tagNames[tag];
    if (name) into[name] = value;
  }
  return { exifIfdOffset, gpsIfdOffset };
}

/**
 * Parse a raw EXIF payload (TIFF header at offset 0). HEIC/AVIF Exif items
 * carry a 4-byte TIFF-header-offset prefix (usually 0) — strip it before here.
 */
export function parseExif(buf: Buffer): ExifResult | null {
  if (buf.length < 8) return null;
  const byteOrder = buf.toString('latin1', 0, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') return null;
  const bigEndian = byteOrder === 'MM';
  const magic = readU16(buf, 2, bigEndian);
  if (magic !== 42) return null;
  const ifd0Offset = readU32(buf, 4, bigEndian);

  const ifd0: Record<string, unknown> = {};
  const exif: Record<string, unknown> = {};
  const gps: Record<string, unknown> = {};

  const { exifIfdOffset, gpsIfdOffset } = walkIfd(buf, ifd0Offset, bigEndian, TAGS_IFD0, ifd0);
  if (exifIfdOffset !== undefined) walkIfd(buf, exifIfdOffset, bigEndian, TAGS_EXIF, exif);
  if (gpsIfdOffset !== undefined) walkIfd(buf, gpsIfdOffset, bigEndian, TAGS_GPS, gps);

  return { bigEndian, ifd0, exif, gps };
}

/** Build a minimal little-endian TIFF/EXIF payload with the given tags. Test/fixture use. */
export function buildExifPayload(
  ifd0Tags: Array<[number, unknown]>,
  exifTags: Array<[number, unknown]> = [],
  gpsTags: Array<[number, unknown]> = [],
): Buffer {
  // Layout: header(8) + IFD0 + entries + next(4) + [ExifIFD] + [GPSIFD] + out-of-line data
  // We keep every value <= 4 bytes inline; rationals (8 bytes) go out-of-line.
  interface Pending {
    tag: number;
    type: number;
    count: number;
    value: number | string | number[];
    outOfLine?: Buffer;
  }
  const toPending = ([tag, value]: [number, unknown]): Pending => {
    if (typeof value === 'string') return { tag, type: 2, count: value.length + 1, value };
    if (Array.isArray(value)) {
      if (value.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff)) {
        return { tag, type: 3, count: value.length, value };
      }
      return { tag, type: 4, count: value.length, value };
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0) {
        return value <= 0xffff ? { tag, type: 3, count: 1, value } : { tag, type: 4, count: 1, value };
      }
      // rational: store as [num, den]
      return { tag, type: 5, count: 1, value: [Math.round(value * 1000), 1000] as number[] };
    }
    throw new Error('unsupported fixture value');
  };

  const ifd0: Pending[] = ifd0Tags.map(toPending);
  const exif: Pending[] = exifTags.map(toPending);
  const gps: Pending[] = gpsTags.map(toPending);

  const hasExif = exif.length > 0;
  const hasGps = gps.length > 0;
  const ifd0EntryCount = ifd0.length + (hasExif ? 1 : 0) + (hasGps ? 1 : 0);

  const ifd0Start = 8;
  const ifd0Size = 2 + ifd0EntryCount * 12 + 4;
  const exifStart = ifd0Start + ifd0Size;
  const exifSize = hasExif ? 2 + exif.length * 12 + 4 : 0;
  const gpsStart = exifStart + exifSize;
  const gpsSize = hasGps ? 2 + gps.length * 12 + 4 : 0;
  let dataStart = gpsStart + gpsSize;

  // Pre-compute out-of-line payloads to know sizes (not needed for offsets — appended sequentially)
  const outOfLine: Buffer[] = [];
  const encodeEntry = (p: Pending): Buffer => {
    const entry = Buffer.alloc(12);
    entry.writeUInt16LE(p.tag, 0);
    entry.writeUInt16LE(p.type, 2);
    entry.writeUInt32LE(p.count, 4);
    let inline: Buffer;
    if (p.type === 2) {
      const b = Buffer.from(`${p.value as string}\0`, 'latin1');
      if (b.length <= 4) {
        inline = Buffer.concat([b, Buffer.alloc(4 - b.length)]);
      } else {
        entry.writeUInt32LE(dataStart, 8);
        outOfLine.push(b);
        dataStart += b.length;
        return entry;
      }
    } else if (p.type === 3) {
      const vals = Array.isArray(p.value) ? p.value : [p.value as number];
      const b = Buffer.alloc(vals.length * 2);
      vals.forEach((v, i) => b.writeUInt16LE(v, i * 2));
      if (b.length <= 4) {
        inline = Buffer.concat([b, Buffer.alloc(4 - b.length)]);
      } else {
        entry.writeUInt32LE(dataStart, 8);
        outOfLine.push(b);
        dataStart += b.length;
        return entry;
      }
    } else if (p.type === 4) {
      const vals = Array.isArray(p.value) ? p.value : [p.value as number];
      const b = Buffer.alloc(vals.length * 4);
      vals.forEach((v, i) => b.writeUInt32LE(v, i * 4));
      if (b.length <= 4) {
        inline = b;
      } else {
        entry.writeUInt32LE(dataStart, 8);
        outOfLine.push(b);
        dataStart += b.length;
        return entry;
      }
    } else if (p.type === 5) {
      // rational: value is a flat [num, den, num, den, ...] u32 list, 8 bytes per pair
      const vals = (Array.isArray(p.value) ? p.value : [p.value as number, 1]) as number[];
      const b = Buffer.alloc(vals.length * 4);
      vals.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
      entry.writeUInt32LE(dataStart, 8);
      outOfLine.push(b);
      dataStart += b.length;
      return entry;
    } else {
      throw new Error('unsupported fixture type');
    }
    inline.copy(entry, 8);
    return entry;
  };

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifd0Start, 4);

  const ifd0Buf = Buffer.alloc(ifd0Size);
  ifd0Buf.writeUInt16LE(ifd0EntryCount, 0);
  let cursor = 2;
  for (const p of ifd0) {
    encodeEntry(p).copy(ifd0Buf, cursor);
    cursor += 12;
  }
  if (hasExif) {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(SUB_IFD_OFFSET_TAG, 0);
    e.writeUInt16LE(4, 2);
    e.writeUInt32LE(1, 4);
    e.writeUInt32LE(exifStart, 8);
    e.copy(ifd0Buf, cursor);
    cursor += 12;
  }
  if (hasGps) {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(GPS_IFD_OFFSET_TAG, 0);
    e.writeUInt16LE(4, 2);
    e.writeUInt32LE(1, 4);
    e.writeUInt32LE(gpsStart, 8);
    e.copy(ifd0Buf, cursor);
    cursor += 12;
  }
  ifd0Buf.writeUInt32LE(0, cursor); // no next IFD

  const exifBuf = Buffer.alloc(exifSize);
  if (hasExif) {
    exifBuf.writeUInt16LE(exif.length, 0);
    let c = 2;
    for (const p of exif) {
      encodeEntry(p).copy(exifBuf, c);
      c += 12;
    }
    exifBuf.writeUInt32LE(0, c);
  }

  const gpsBuf = Buffer.alloc(gpsSize);
  if (hasGps) {
    gpsBuf.writeUInt16LE(gps.length, 0);
    let c = 2;
    for (const p of gps) {
      encodeEntry(p).copy(gpsBuf, c);
      c += 12;
    }
    gpsBuf.writeUInt32LE(0, c);
  }

  return Buffer.concat([header, ifd0Buf, exifBuf, gpsBuf, ...outOfLine]);
}
