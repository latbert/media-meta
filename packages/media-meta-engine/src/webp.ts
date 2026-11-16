/**
 * WebP (RIFF container) chunk walker.
 * Extracts EXIF and XMP chunks. The EXIF chunk payload may carry a 4-byte
 * TIFF-header-offset prefix (per the WebP container spec, "ALPH"-era writers
 * vary); both forms are handled.
 */

export interface RiffChunk {
  fourcc: string;
  payload: Buffer;
}

/** Parse RIFF container; returns [] when the signature is not RIFF....WEBP. */
export function parseWebp(buf: Buffer): RiffChunk[] {
  if (buf.length < 12) return [];
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return [];
  }
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length && chunks.length < 256) {
    const fourcc = buf.toString('latin1', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    let payloadStart = offset + 8;
    if (size > buf.length - payloadStart) {
      // truncated final chunk: clamp
      size = buf.length - payloadStart;
    }
    chunks.push({ fourcc, payload: buf.subarray(payloadStart, payloadStart + size) });
    // chunks are padded to even sizes
    const padded = size + (size % 2);
    payloadStart += padded;
    offset += 8 + padded;
  }
  return chunks;
}

export interface WebpExifPayload {
  exif?: Buffer;
  xmp?: Buffer;
}

/**
 * Pull the EXIF and XMP chunk payloads out of parsed WebP chunks.
 * The EXIF chunk starts with a 4-byte offset-to-TIFF-header when nonzero;
 * a leading "II"/"MM" at byte 0 means no prefix is present.
 */
export function extractWebpMetadata(chunks: RiffChunk[]): WebpExifPayload {
  const out: WebpExifPayload = {};
  for (const chunk of chunks) {
    if (chunk.fourcc === 'EXIF' && !out.exif) {
      const head = chunk.payload.toString('latin1', 0, 2);
      out.exif =
        head === 'II' || head === 'MM'
          ? Buffer.from(chunk.payload) // no prefix
          : Buffer.from(chunk.payload.subarray(4)); // skip 4-byte offset prefix
    } else if (chunk.fourcc === 'XMP ' && !out.xmp) {
      out.xmp = Buffer.from(chunk.payload);
    }
  }
  return out;
}

/** Build a minimal valid RIFF/WEBP file with the given VP8L/VP8/ALPH-less body plus EXIF/XMP chunks. Test fixture use. */
export function buildWebp(exif: Buffer | null, xmp: string | null): Buffer {
  const chunks: Buffer[] = [];
  // minimal VP8L chunk: 1 byte signature 0x2f + a lossless bitstream stub (14 bytes)
  const vp8l = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  pushChunk(chunks, 'VP8L', vp8l);
  if (exif) {
    // spec form: 4-byte offset (0) then TIFF payload
    pushChunk(chunks, 'EXIF', Buffer.concat([Buffer.from([0, 0, 0, 0]), exif]));
  }
  if (xmp) {
    pushChunk(chunks, 'XMP ', Buffer.from(xmp, 'utf8'));
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

function pushChunk(chunks: Buffer[], fourcc: string, payload: Buffer): void {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  const pad = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  chunks.push(head, payload, pad);
}
