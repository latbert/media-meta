import { describe, expect, it } from 'vitest';
import {
  readMetaBuffer,
  buildHeicFixture,
  buildAvifFixture,
  buildHeifXmpOnlyFixture,
  buildWebp,
  buildExifPayload,
  parseExif,
  detectContainer,
  MediaMetaError,
} from '../index.js';

describe('fixture builders produce parseable files (zero downloaded samples)', () => {
  it('buildExifPayload round-trips through parseExif (little-endian TIFF)', () => {
    const payload = buildExifPayload(
      [
        [0x010f, 'TestCam'],
        [0x0110, 'Model X'],
        [0x0112, 6],
        [0x0132, '2026:11:15 10:00:00'],
      ],
      [
        [0x829a, 0.01],
        [0x8827, 200],
        [0xa002, 4032],
      ],
      [
        [0x0001, 'N'],
        [0x0002, [37, 30, 0]],
      ],
    );
    const parsed = parseExif(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.bigEndian).toBe(false);
    expect(parsed!.ifd0.Make).toBe('TestCam');
    expect(parsed!.ifd0.Model).toBe('Model X');
    expect(parsed!.ifd0.Orientation).toBe(6);
    expect(parsed!.ifd0.DateTime).toBe('2026:11:15 10:00:00');
    expect(parsed!.exif.ISOSpeedRatings).toBe(200);
    expect(parsed!.exif.PixelXDimension).toBe(4032);
    // ExposureTime stored as rational num/den = 10/1000 = 0.01
    expect(parsed!.exif.ExposureTime).toBeCloseTo(0.01, 6);
    expect(parsed!.gps.GPSLatitudeRef).toBe('N');
    expect(parsed!.gps.GPSLatitude).toEqual([37, 30, 0]);
  });

  it('HEIC fixture parses: container/brand/EXIF groups/XMP all present', () => {
    const buf = buildHeicFixture();
    const meta = readMetaBuffer(buf);
    expect(meta.container).toBe('heic');
    expect(meta.brand).toBe('heic');
    expect(meta.exif!.IFD0.Make).toBe('TestCam');
    expect(meta.exif!.IFD0.Orientation).toBe(6);
    expect(meta.exif!.Exif.ISOSpeedRatings).toBe(200);
    expect(meta.exif!.GPS.GPSLatitude).toEqual([37, 30, 0]);
    expect(meta.xmp).toContain('<x:xmpmeta');
    expect(meta.warnings).toEqual([]);
    const types = meta.boxes.map((b) => b.type);
    expect(types).toContain('ftyp');
    expect(types).toContain('meta');
    expect(types).toContain('iinf');
    expect(types).toContain('iloc');
    expect(types).toContain('mdat');
  });

  it('AVIF fixture parses with avif brand', () => {
    const meta = readMetaBuffer(buildAvifFixture());
    expect(meta.container).toBe('avif');
    expect(meta.brand).toBe('avif');
    expect(meta.exif!.IFD0.Make).toBe('AVIFCam');
    expect(meta.xmp).toBeUndefined();
  });

  it('HEIF (mif1) XMP-only fixture has no exif but carries xmp', () => {
    const meta = readMetaBuffer(buildHeifXmpOnlyFixture());
    expect(meta.container).toBe('heif');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBe('<x:xmpmeta/>');
  });

  it('WebP fixture: EXIF with 4-byte prefix + XMP chunk', () => {
    const exif = buildExifPayload([[0x010f, 'WebCam'], [0x0112, 8]]);
    const buf = buildWebp(exif, '<?xpacket?><x:xmpmeta/>');
    const meta = readMetaBuffer(buf);
    expect(meta.container).toBe('webp');
    expect(meta.exif!.IFD0.Make).toBe('WebCam');
    expect(meta.exif!.IFD0.Orientation).toBe(8);
    expect(meta.xmp).toContain('x:xmpmeta');
  });
});

describe('container detection', () => {
  it('classifies known ISOBMFF brands and WebP', () => {
    expect(detectContainer(buildHeicFixture()).kind).toBe('heic');
    expect(detectContainer(buildAvifFixture()).kind).toBe('avif');
    expect(detectContainer(buildWebp(null, null)).kind).toBe('webp');
  });

  it('throws typed errors for unrecognized content', () => {
    expect(() => detectContainer(Buffer.from('GIF89a....'))).toThrow(MediaMetaError);
    expect(() => detectContainer(Buffer.alloc(4))).toThrow(MediaMetaError);
    // ftyp with unknown brand
    const mp4 = Buffer.alloc(16);
    mp4.writeUInt32BE(16, 0);
    mp4.write('ftyp', 4, 'latin1');
    mp4.write('isom', 8, 'latin1');
    expect(() => detectContainer(mp4)).toThrow(MediaMetaError);
    try {
      detectContainer(mp4);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as MediaMetaError).code).toBe('unsupported_brand');
    }
  });
});

describe('determinism', () => {
  it('fixtures are byte-reproducible and reads are byte-stable', () => {
    const a1 = buildHeicFixture();
    const a2 = buildHeicFixture();
    expect(a1.equals(a2)).toBe(true);
    const b1 = buildWebp(buildExifPayload([[0x0112, 3]]), null);
    const b2 = buildWebp(buildExifPayload([[0x0112, 3]]), null);
    expect(b1.equals(b2)).toBe(true);

    const r1 = JSON.stringify(readMetaBuffer(a1));
    const r2 = JSON.stringify(readMetaBuffer(a2));
    expect(r1).toBe(r2);
  });

  it('readMetaBuffer on odd-sized payloads does not mutate the input', () => {
    const buf = Buffer.from(buildWebp(buildExifPayload([[0x010f, 'x']]), null)); // copy
    const before = Buffer.from(buf);
    readMetaBuffer(buf);
    expect(buf.equals(before)).toBe(true);
  });
});

describe('edge cases', () => {
  it('meta-less ISOBMFF yields a warning, not a crash', () => {
    const ftypOnly = Buffer.alloc(16);
    ftypOnly.writeUInt32BE(16, 0);
    ftypOnly.write('ftyp', 4, 'latin1');
    ftypOnly.write('heic', 8, 'latin1');
    const meta = readMetaBuffer(ftypOnly);
    expect(meta.container).toBe('heic');
    expect(meta.warnings.join(' ')).toContain('no meta box');
  });

  it('truncated EXIF payloads are reported, not thrown', () => {
    // WebP with an EXIF chunk that has no TIFF magic
    const bad = buildWebp(Buffer.from('nonsense-not-tiff'), null);
    const meta = readMetaBuffer(bad);
    expect(meta.warnings.join(' ')).toContain('did not parse');
  });
});
