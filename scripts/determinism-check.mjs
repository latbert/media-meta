#!/usr/bin/env node
// Determinism harness: fixtures are byte-reproducible and reads byte-stable.
// Runs fully offline; exits non-zero on any mismatch.
import {
  buildHeicFixture,
  buildAvifFixture,
  buildHeifXmpOnlyFixture,
  buildWebp,
  buildExifPayload,
  readMetaBuffer,
} from '../packages/media-meta-engine/dist/index.js';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`);
}

const heicA = buildHeicFixture();
const heicB = buildHeicFixture();
check('HEIC fixture byte-reproducible', heicA.equals(heicB));

const avifA = buildAvifFixture();
const avifB = buildAvifFixture();
check('AVIF fixture byte-reproducible', avifA.equals(avifB));

const heifA = buildHeifXmpOnlyFixture();
const heifB = buildHeifXmpOnlyFixture();
check('HEIF-XMP fixture byte-reproducible', heifA.equals(heifB));

const exif = buildExifPayload([[0x010f, 'Determinism'], [0x0112, 6], [0x829a, 0.02]]);
const webpA = buildWebp(exif, '<x:xmpmeta><determinism/></x:xmpmeta>');
const webpB = buildWebp(buildExifPayload([[0x010f, 'Determinism'], [0x0112, 6], [0x829a, 0.02]]), '<x:xmpmeta><determinism/></x:xmpmeta>');
check('WebP fixture byte-reproducible', webpA.equals(webpB));

const r1 = JSON.stringify(readMetaBuffer(heicA));
const r2 = JSON.stringify(readMetaBuffer(heicB));
check('HEIC read byte-stable', r1 === r2);

const w1 = JSON.stringify(readMetaBuffer(webpA));
const w2 = JSON.stringify(readMetaBuffer(webpB));
check('WebP read byte-stable', w1 === w2);

console.log(failures === 0 ? 'determinism: ALL PASS' : `determinism: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
