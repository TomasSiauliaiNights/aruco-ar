/**
 * Writes a Y4M clip of a moving ArUco marker, for Chromium's fake camera
 * (--use-file-for-fake-video-capture).
 *
 * Y4M is written by hand because it is trivial (a text header, then raw planes)
 * and pulling in ffmpeg would make the test suite depend on a system binary
 * that CI might not have. Using the same syntheticScene generator as the
 * benchmark also means the E2E test and the benchmark are looking at the same
 * marker motion.
 *
 * The clip loops in Chromium, so a short one is enough for a long test.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderFrame } from '../../src/bench/syntheticScene';

export interface Y4mOptions {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  markerId?: number;
}

export function writeY4m(path: string, opts: Y4mOptions = {}): void {
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  const fps = opts.fps ?? 30;
  const frames = opts.frames ?? 90;
  const markerId = opts.markerId ?? 0;

  mkdirSync(dirname(path), { recursive: true });

  const header = Buffer.from(
    `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`,
    'ascii',
  );
  const frameMarker = Buffer.from('FRAME\n', 'ascii');

  const ySize = width * height;
  const cW = width >> 1;
  const cH = height >> 1;
  const cSize = cW * cH;

  const chunks: Buffer[] = [header];

  for (let i = 0; i < frames; i++) {
    const frame = renderFrame({ width, height, markerId, seed: 2024 }, i, fps);

    const y = Buffer.alloc(ySize);
    for (let p = 0; p < ySize; p++) {
      // The scene is greyscale, so the red channel is the luma.
      y[p] = frame.data[p * 4] as number;
    }
    // Neutral chroma: 128 is "no colour" in 8-bit Y'CbCr.
    const u = Buffer.alloc(cSize, 128);
    const v = Buffer.alloc(cSize, 128);

    chunks.push(frameMarker, y, u, v);
  }

  writeFileSync(path, Buffer.concat(chunks));
}
