/**
 * Minimal ISOBMFF (HEIC/HEIF/AVIF) box walker.
 * Parses the box tree down to where metadata lives: meta > iinf > infe (item
 * info), meta > iloc (item locations), and the actual Exif/XMP item payloads.
 * Returns the raw payload buffers for the Exif and XMP items.
 */

export interface IsoBox {
  type: string;
  /** Absolute byte offset of the box header in the file. */
  start: number;
  /** Total box size (header + payload) as declared. */
  size: number;
  /** Payload bytes (container boxes get parsed recursively, leaves sliced lazily). */
  payload: Buffer;
}

export interface IsoWalkResult {
  boxes: IsoBox[];
  /** All top-level and nested boxes flattened with type+size (for MediaMeta.boxes). */
  flat: { type: string; size: number }[];
}

/** Full-boxes have a 4-byte version/flags field before their payload payload. */
const FULL_BOXES = new Set(['meta', 'iloc', 'iinf', 'infe']);

export function parseBoxes(buf: Buffer, start: number, end: number, depth = 0): IsoBox[] {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const big = buf.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset; // extends to end of enclosing box
    }
    if (size < headerSize || offset + size > end) break;
    const payloadStart = offset + headerSize;
    const payloadEnd = offset + size;
    boxes.push({
      type,
      start: offset,
      size,
      payload: buf.subarray(payloadStart, payloadEnd),
    });
    offset += size;
    if (depth > 8) break;
  }
  return boxes;
}

function childPayload(box: IsoBox): { start: number; end: number } {
  // full box: skip 4-byte version/flags
  return FULL_BOXES.has(box.type)
    ? { start: 4, end: box.payload.length }
    : { start: 0, end: box.payload.length };
}

/** Find a box of the given type among parsed children, first match. */
export function findBox(boxes: IsoBox[], type: string): IsoBox | undefined {
  return boxes.find((b) => b.type === type);
}

export interface ItemInfoEntry {
  itemId: number;
  itemType: string;
  itemName?: string;
}

/** Parse meta > iinf > infe[] entries: item id, type (Exif / mime ...), name. */
export function parseItemInfos(metaBox: IsoBox): ItemInfoEntry[] {
  const { start, end } = childPayload(metaBox);
  const metaChildren = parseBoxes(metaBox.payload, start, end, 1);
  const iinf = findBox(metaChildren, 'iinf');
  if (!iinf) return [];
  const iinfRange = childPayload(iinf);
  // iinf (full box, version>=1): entry_count is u16 (v0) or u32 (v1+)
  let off = iinfRange.start;
  const version = iinf.payload[0];
  let count: number;
  if (version >= 1) {
    count = iinf.payload.readUInt32BE(off);
    off += 4;
  } else {
    count = iinf.payload.readUInt16BE(off);
    off += 2;
  }
  const entries: ItemInfoEntry[] = [];
  const infeBoxes = parseBoxes(iinf.payload, off, iinfRange.end, 2);
  for (const infe of infeBoxes) {
    if (infe.type !== 'infe') continue;
    const v = infe.payload[0];
    let p = 4; // skip version/flags
    let itemId: number;
    if (v >= 2) {
      itemId = infe.payload.readUInt16BE(p);
      p += 2;
    } else {
      itemId = infe.payload.readUInt16BE(p);
      p += 2;
    }
    let itemType = '';
    if (v >= 2) {
      // v2/3: item_type is a 4cc; then string name
      itemType = infe.payload.toString('latin1', p, p + 4);
      p += 4;
    } else {
      // v0/1: legacy — two null-terminated strings then 1 byte protection; type unknown
      itemType = 'unknown';
    }
    // item name: null-terminated UTF-8 (best-effort)
    const nameEnd = infe.payload.indexOf(0, p);
    const itemName = nameEnd > p ? infe.payload.toString('utf8', p, nameEnd) : undefined;
    entries.push({ itemId, itemType, itemName });
    if (entries.length > 256) break; // sanity cap
  }
  void count;
  return entries;
}

export interface ItemLocation {
  itemId: number;
  /** Absolute file offsets and lengths of the item's extents. */
  extents: { offset: number; length: number }[];
}

/** Parse meta > iloc into item id → extent list. */
export function parseItemLocations(metaBox: IsoBox, fileLength: number): Map<number, ItemLocation> {
  const map = new Map<number, ItemLocation>();
  const { start, end } = childPayload(metaBox);
  const metaChildren = parseBoxes(metaBox.payload, start, end, 1);
  const iloc = findBox(metaChildren, 'iloc');
  if (!iloc) return map;
  const p = iloc.payload;
  const version = p[0];
  let off = 4; // skip version/flags
  const offsetSize = p[off] >> 4;
  const lengthSize = p[off] & 0x0f;
  const baseOffsetSize = p[off + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? p[off + 1] & 0x0f : 0;
  off += 2;

  const readUint = (buf: Buffer, at: number, byteCount: number): number => {
    let v = 0;
    for (let i = 0; i < byteCount; i++) v = v * 256 + buf[at + i];
    return v;
  };

  const itemCount = version < 2 ? p.readUInt16BE(off) : p.readUInt32BE(off);
  off += version < 2 ? 2 : 4;

  for (let i = 0; i < itemCount && off < p.length; i++) {
    let itemId: number;
    if (version < 2) {
      itemId = p.readUInt16BE(off);
      off += 2;
    } else {
      itemId = p.readUInt32BE(off);
      off += 4;
    }
    if (version === 1 || version === 2) {
      off += 2; // construction_method (u16)
    }
    const dataReferenceIndex = p.readUInt16BE(off);
    off += 2;
    const baseOffset = readUint(p, off, baseOffsetSize);
    off += baseOffsetSize;
    const extentCount = p.readUInt16BE(off);
    off += 2;
    const extents: { offset: number; length: number }[] = [];
    for (let e = 0; e < extentCount; e++) {
      if (indexSize > 0) off += indexSize;
      const extentOffset = readUint(p, off, offsetSize);
      off += offsetSize;
      const extentLength = readUint(p, off, lengthSize);
      off += lengthSize;
      const abs = dataReferenceIndex === 0 ? baseOffset + extentOffset : -1;
      if (abs >= 0 && abs + extentLength <= fileLength) {
        extents.push({ offset: abs, length: extentLength });
      }
    }
    if (extents.length > 0) map.set(itemId, { itemId, extents });
    if (map.size > 512) break; // sanity cap
  }
  return map;
}
