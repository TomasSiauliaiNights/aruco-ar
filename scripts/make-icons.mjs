#!/usr/bin/env node
/**
 * Generates the PWA icons: public/icons/icon-{180,192,512}.png plus a maskable
 * variant.
 *
 * Written by hand (zlib + CRC32, which is all a PNG needs) rather than pulling
 * in an image library, and generated rather than committed, so there is no
 * binary blob in the repo and no extra dependency for a handful of squares.
 *
 * The glyph is a real ArUco 4x4_50 marker (id 0), which is the honest icon for
 * this app: it is literally what you point the camera at.
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

/**
 * ArUco 4x4_50 id 0, as a 6x6 grid including the black border.
 * '#' = black. Matches src/marker/markerSvg.ts and OpenCV's own render.
 */
const MARKER = ['######', '#.#..#', '##.#.#', '###..#', '###.##', '######'];

const BG = [11, 13, 16];
const PAPER = [242, 244, 247];
const INK = [16, 18, 22];
const ACCENT = [90, 209, 160];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** Encodes RGBA pixel rows as a PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param size   square side in px
 * @param inset  fraction of the side left as background around the paper.
 *               Maskable icons need a generous safe area because the launcher
 *               may crop to a circle.
 */
function renderIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4);
  const paperStart = Math.round(size * inset);
  const paperSize = size - paperStart * 2;
  const corner = Math.round(paperSize * 0.16);

  // The marker itself fills most of the paper, leaving a quiet zone.
  const quiet = Math.round(paperSize * 0.13);
  const markerStart = paperStart + quiet;
  const markerSize = paperSize - quiet * 2;
  const cell = markerSize / 6;

  const put = (x, y, [r, g, b], a = 255) => {
    const o = (y * size + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-rect paper over a flat background.
      const inPaperBox =
        x >= paperStart && x < paperStart + paperSize && y >= paperStart && y < paperStart + paperSize;
      let onPaper = inPaperBox;
      if (inPaperBox && corner > 0) {
        const lx = x - paperStart;
        const ly = y - paperStart;
        const nearLeft = lx < corner;
        const nearRight = lx >= paperSize - corner;
        const nearTop = ly < corner;
        const nearBottom = ly >= paperSize - corner;
        if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
          const cxc = nearLeft ? corner : paperSize - corner - 1;
          const cyc = nearTop ? corner : paperSize - corner - 1;
          onPaper = Math.hypot(lx - cxc, ly - cyc) <= corner;
        }
      }

      if (!onPaper) {
        put(x, y, BG);
        continue;
      }

      const inMarker =
        x >= markerStart && x < markerStart + markerSize && y >= markerStart && y < markerStart + markerSize;
      if (!inMarker) {
        put(x, y, PAPER);
        continue;
      }

      const col = Math.min(5, Math.floor((x - markerStart) / cell));
      const row = Math.min(5, Math.floor((y - markerStart) / cell));
      const black = MARKER[row][col] === '#';
      put(x, y, black ? INK : PAPER);
    }
  }

  // An accent notch in the bottom-right of the background, so the icon is not
  // mistaken for a plain QR code at a glance.
  const notch = Math.max(2, Math.round(size * 0.055));
  for (let y = size - notch * 2; y < size - notch; y++) {
    for (let x = size - notch * 2; x < size - notch; x++) {
      if (x >= 0 && y >= 0) put(x, y, ACCENT);
    }
  }

  return encodePng(size, size, rgba);
}

await mkdir(outDir, { recursive: true });

const jobs = [
  { name: 'icon-180.png', size: 180, inset: 0.06 },
  { name: 'icon-192.png', size: 192, inset: 0.06 },
  { name: 'icon-512.png', size: 512, inset: 0.06 },
  // Maskable: more padding, because launchers crop aggressively.
  { name: 'icon-maskable-512.png', size: 512, inset: 0.18 },
];

for (const job of jobs) {
  const png = renderIcon(job.size, job.inset);
  await writeFile(join(outDir, job.name), png);
  console.log(`  -> public/icons/${job.name}  ${png.length} bytes`);
}

console.log('icons generated');
