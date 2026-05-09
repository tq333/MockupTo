#!/usr/bin/env node
/**
 * Mockup Sync · Chrome Extension build
 *
 * Single-step pipeline:
 *   src/capture.src.js  +  ../mockup-kit.mapping.json   →  lib/capture.bundle.js
 *
 * Replaces the marker `/* @inject:mapping *\/ null` in the source with the
 * stringified mapping JSON, so the runtime bundle is fully self-contained
 * (no fetch, no chrome.storage, no extra files to ship).
 *
 * Also generates placeholder toolbar icons (16/48/128) the first time so
 * `manifest.json` references resolve.
 *
 * Zero runtime deps. Uses only Node stdlib.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EXT_ROOT  = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXT_ROOT, '..');

const SRC_PATH     = path.join(EXT_ROOT, 'src', 'capture.src.js');
const MAPPING_PATH = path.join(REPO_ROOT, 'mockup-kit.mapping.json');
const LIB_DIR      = path.join(EXT_ROOT, 'lib');
const BUNDLE_PATH  = path.join(LIB_DIR, 'capture.bundle.js');
const ICONS_DIR    = path.join(EXT_ROOT, 'icons');

const MARKER = '/* @inject:mapping */ null';

function step(msg) { console.log('· ' + msg); }
function ok(msg)   { console.log('✓ ' + msg); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

function main() {
  // ─── 1. Build capture bundle ─────────────────────────────────────────────
  step('Building capture bundle…');

  if (!fs.existsSync(SRC_PATH))     fail('Source not found: ' + SRC_PATH);
  if (!fs.existsSync(MAPPING_PATH)) fail('Mapping not found: ' + MAPPING_PATH);

  const src = fs.readFileSync(SRC_PATH, 'utf8');
  if (!src.includes(MARKER)) {
    fail('Source missing injection marker "' + MARKER + '" — did you delete it?');
  }

  const mappingJson = fs.readFileSync(MAPPING_PATH, 'utf8');
  let mapping;
  try { mapping = JSON.parse(mappingJson); }
  catch (e) { fail('mapping.json is not valid JSON: ' + e.message); }

  // Inject as a JSON literal (safe against accidental JS tokenization).
  const injected = src.replace(MARKER, JSON.stringify(mapping));

  const header = [
    '// Mockup Sync · capture bundle',
    '// Generated: ' + new Date().toISOString(),
    '// Source: chrome-extension/src/capture.src.js',
    '// Mapping: mockup-kit.mapping.json (v' + ((mapping.spec && mapping.spec.version) || 'unknown') + ')',
    '// DO NOT EDIT — regenerate with `npm run build`',
    '',
  ].join('\n');

  fs.mkdirSync(LIB_DIR, { recursive: true });
  fs.writeFileSync(BUNDLE_PATH, header + injected);
  const bytes = fs.statSync(BUNDLE_PATH).size;
  ok('Wrote ' + path.relative(EXT_ROOT, BUNDLE_PATH) + '  (' + (bytes / 1024).toFixed(1) + ' KB)');

  // ─── 2. Generate placeholder icons if missing ────────────────────────────
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  for (const size of [16, 48, 128]) {
    const file = path.join(ICONS_DIR, `icon-${size}.png`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, buildYellowSquarePng(size));
    ok(`Generated placeholder icon-${size}.png`);
  }

  // ─── 3. Friendly instructions ────────────────────────────────────────────
  console.log('');
  ok('Build complete. To load the unpacked extension:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable "Developer mode" (top right)');
  console.log('  3. Click "Load unpacked" and select:');
  console.log('     ' + EXT_ROOT);
}

// ────────────────────────────────────────────────────────────────────────────
// Tiny PNG generator — yellow rounded square ("M·S" brand mark) of NxN pixels.
// Generates an indexed-color PNG with a CRC-correct chunk stream. Avoids any
// native deps; ~150 LOC total.
// ────────────────────────────────────────────────────────────────────────────
function buildYellowSquarePng(size) {
  const W = size, H = size;
  const PALETTE = Buffer.from([0xff,0xd4,0x00,  0x1a,0x1a,0x1a]);

  const rows = [];
  const border = Math.max(1, Math.round(size * 0.08));
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(W + 1);
    row[0] = 0; // filter type: None
    for (let x = 0; x < W; x++) {
      let idx = 0; // yellow
      if (x < border || y < border || x >= W - border || y >= H - border) idx = 1; // border ink
      const inset = Math.round(size * 0.28);
      const insetW = Math.round(size * 0.05);
      const inX = (x >= inset && x < W - inset);
      const inY = (y >= inset && y < H - inset);
      const onMarkBorder =
        (inY && (x === inset || x === W - inset - 1 || (x >= inset && x < inset + insetW) || (x < W - inset && x >= W - inset - insetW))) ||
        (inX && (y === inset || y === H - inset - 1 || (y >= inset && y < inset + insetW) || (y < H - inset && y >= H - inset - insetW)));
      if (inX && inY && onMarkBorder) idx = 1;
      row[x + 1] = idx;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const idatRaw = zlib.deflateSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihd = Buffer.alloc(13);
  ihd.writeUInt32BE(W, 0);
  ihd.writeUInt32BE(H, 4);
  ihd[8] = 8;        // bit depth
  ihd[9] = 3;        // color type: indexed
  ihd[10] = 0; ihd[11] = 0; ihd[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihd),
    chunk('PLTE', PALETTE),
    chunk('IDAT', idatRaw),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC-32 (PNG) — lazy-init so we don't hit TDZ from earlier top-level callers.
let _crcTable = null;
function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}
function crc32(buf) {
  const T = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
