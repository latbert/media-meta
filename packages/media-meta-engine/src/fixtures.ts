/**
 * Programmatically generated minimal HEIC/AVIF (ISOBMFF) fixtures.
 * Structure: ftyp + meta(iinf[infe Exif, infe mime XMP], iloc[offsets]) + mdat(payloads).
 * Everything is built from bytes in code — zero downloaded binary samples.
 */

import { buildExifPayload } from './exif.js';

export interface BuildHeicOptions {
  brand: string; // e.g. 'heic', 'heix', 'avif', 'mif1'
  compatible?: string[];
  exif: Buffer | null; // raw TIFF payload
  xmp: string | null;
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function fullBox(type: string, version: number, flags: number, rest: Buffer): Buffer {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([vf, rest]));
}

function infeV2(itemId: number, itemType: string, name: string): Buffer {
  const nameBuf = Buffer.from(`${name}\0`, 'utf8');
  const rest = Buffer.alloc(6);
  rest.writeUInt16BE(itemId, 0);
  rest.write(itemType, 2, 'latin1');
  // after item_type: item_name (null-terminated), then content_type etc. — name only is fine
  return fullBox('infe', 2, 0, Buffer.concat([rest, nameBuf]));
}

export function buildIsobmffMedia(options: BuildHeicOptions): Buffer {
  const items: { id: number; type: string; payload: Buffer }[] = [];
  let nextId = 1;
  if (options.exif) {
    // HEIF Exif item payload: 4-byte offset-to-TIFF-header (0) + TIFF payload
    items.push({ id: nextId++, type: 'Exif', payload: Buffer.concat([Buffer.alloc(4), options.exif]) });
  }
  if (options.xmp) {
    items.push({ id: nextId++, type: 'mime', payload: Buffer.from(options.xmp, 'utf8') });
  }

  // ftyp
  const brands = [options.brand, ...(options.compatible ?? ['mif1', 'miaf'])];
  const ftypRest = Buffer.alloc(8 + brands.length * 4);
  ftypRest.write(options.brand, 0, 'latin1');
  ftypRest.writeUInt32BE(0, 4); // minor version
  brands.forEach((b, i) => ftypRest.write(b, 8 + i * 4, 'latin1'));
  const ftyp = box('ftyp', ftypRest);

  // iinf with infe entries
  const infes = items.map((it) =>
    infeV2(it.id, it.type, it.type === 'Exif' ? 'Exif' : 'XMP metadata'),
  );
  const iinfRest = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(items.length);
      return b;
    })(),
    ...infes,
  ]);
  const iinf = fullBox('iinf', 1, 0, iinfRest);

  // mdat starts after ftyp + meta; we compute meta size first via a two-pass build
  const buildMeta = (mdatStart: number): Buffer => {
    // iloc v1 entries: per item — u16 id, u16 construction_method(0), u16 data_ref(0),
    // base_offset(0 bytes), u16 extent_count=1, extent offset u32, length u32
    const entries = items.map((it) => {
      const full = Buffer.alloc(16);
      const extentOffset =
        mdatStart + items.slice(0, it.id - 1).reduce((s, x) => s + x.payload.length, 0);
      full.writeUInt16BE(it.id, 0);
      full.writeUInt16BE(0, 2); // construction_method
      full.writeUInt16BE(0, 4); // data_reference_index
      full.writeUInt16BE(1, 6); // extent_count
      full.writeUInt32BE(extentOffset, 8);
      full.writeUInt32BE(it.payload.length, 12);
      return full;
    });
    // iloc header: offsetSize=4 lengthSize=4 baseOffsetSize=0 indexSize=0 (v1)
    const head = Buffer.from([0x44, 0x00]);
    const iloc = fullBox('iloc', 1, 0, Buffer.concat([head, (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(items.length);
      return b;
    })(), ...entries]));
    // hdlr is required by spec readers for meta; include a minimal pict handler
    const hdlrRest = Buffer.alloc(24);
    hdlrRest.write('pict', 8, 'latin1');
    const hdlr = fullBox('hdlr', 0, 0, hdlrRest);
    return fullBox('meta', 0, 0, Buffer.concat([hdlr, iinf, iloc]));
  };

  // pass 1: compute sizes
  const metaProbe = buildMeta(0);
  const mdatStart = ftyp.length + metaProbe.length + 8 /* mdat header */;
  const meta = buildMeta(mdatStart);
  const mdat = box('mdat', Buffer.concat(items.map((it) => it.payload)));

  return Buffer.concat([ftyp, meta, mdat]);
}

/** Convenience: HEIC fixture carrying EXIF (make/model/orientation + Exif sub-IFD + GPS). */
export function buildHeicFixture(): Buffer {
  const exif = buildExifPayload(
    [
      [0x010f, 'TestCam'],
      [0x0110, 'Model X'],
      [0x0112, 6],
      [0x0132, '2026:11:15 10:00:00'],
    ],
    [
      [0x829a, 0.01], // ExposureTime rational
      [0x8827, 200], // ISO
      [0xa002, 4032],
    ],
    [
      [0x0001, 'N'],
      [0x0002, [37, 30, 0]],
    ],
  );
  return buildIsobmffMedia({
    brand: 'heic',
    exif,
    xmp: '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/heic"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
  });
}

/** Convenience: AVIF fixture (avif brand) with EXIF only. */
export function buildAvifFixture(): Buffer {
  const exif = buildExifPayload([[0x010f, 'AVIFCam'], [0x0112, 1]]);
  return buildIsobmffMedia({ brand: 'avif', compatible: ['avif', 'mif1', 'miaf'], exif, xmp: null });
}

/** Convenience: HEIF generic (mif1) with XMP only. */
export function buildHeifXmpOnlyFixture(): Buffer {
  return buildIsobmffMedia({ brand: 'mif1', exif: null, xmp: '<x:xmpmeta/>' });
}
