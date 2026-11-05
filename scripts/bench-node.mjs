#!/usr/bin/env node
/**
 * Headless detector benchmark.
 *
 * Measures the same thing the in-browser /bench page measures, on the same
 * synthetic clip, so the desktop baseline and the on-device numbers are
 * comparable. Run with:
 *
 *   npm run bench:node
 *   npm run bench:node -- --frames 200 --widths 320,480,640
 *
 * It also reports corner error against ground truth, because a configuration
 * that is faster and less accurate should not be able to look like a win.
 *
 * This is NOT a substitute for the on-device numbers. A desktop CPU is several
 * times faster than a phone and this build has neither SIMD nor threads, so
 * treat these as a relative baseline only.
 */

import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPENCV_PATH = join(root, 'public', 'vendor', 'opencv.js');
const CACHE_DIR = join(root, 'node_modules', '.cache', 'opencv');
const CJS_PATH = join(CACHE_DIR, 'opencv.cjs');

const CORNER_REFINE_NONE = 0;
const CORNER_REFINE_SUBPIX = 1;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FRAMES = Number.parseInt(arg('frames', '120'), 10);
const WIDTHS = arg('widths', '320,480,640,960')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter(Number.isFinite);
const MARKER_ID = Number.parseInt(arg('marker', '0'), 10);

function loadOpenCvSync() {
  let stale = true;
  const source = statSync(OPENCV_PATH);
  try {
    const existing = statSync(CJS_PATH);
    stale = existing.size !== source.size || existing.mtimeMs < source.mtimeMs;
  } catch {
    stale = true;
  }
  if (stale) {
    mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(OPENCV_PATH, CJS_PATH);
  }
  return createRequire(import.meta.url)(CJS_PATH);
}

try {
  statSync(OPENCV_PATH);
} catch {
  console.error('public/vendor/opencv.js is missing. Run "npm run assets" first.');
  process.exit(1);
}

const cv = loadOpenCvSync();
await new Promise((resolve, reject) => {
  if (cv.Mat) return resolve();
  cv.onRuntimeInitialized = resolve;
  setTimeout(() => reject(new Error('opencv.js did not initialise within 120s')), 120_000);
});

// Imported after OpenCV is up: see the note in tests/integration/opencv.test.mjs
// about requiring opencv from a type-stripped module.
const scene = await import(pathToFileURL(join(root, 'src/bench/syntheticScene.ts')).href);

const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);

function makeDetector(refine) {
  const params = new cv.aruco_DetectorParameters();
  params.cornerRefinementMethod = refine;
  return new cv.aruco_ArucoDetector(dict, params, new cv.aruco_RefineParameters(10, 3, true));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}

const rows = [];

for (const width of WIDTHS) {
  const height = Math.round((width * 3) / 4);

  // Generate up front so generation never lands inside a measurement.
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    frames.push(scene.renderFrame({ width, height, markerId: MARKER_ID, seed: 7777 }, i));
  }

  for (const refine of [true, false]) {
    const detector = makeDetector(refine ? CORNER_REFINE_SUBPIX : CORNER_REFINE_NONE);

    const rgba = new cv.Mat(height, width, cv.CV_8UC4);
    const gray = new cv.Mat(height, width, cv.CV_8UC1);
    const corners = new cv.MatVector();
    const ids = new cv.Mat();
    const rejected = new cv.MatVector();

    const runOne = (frame) => {
      rgba.data.set(frame.data);
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const t0 = performance.now();
      detector.detectMarkers(gray, corners, ids, rejected);
      const ms = performance.now() - t0;

      let found = null;
      for (let i = 0; i < ids.rows; i++) {
        if (ids.data32S[i] === MARKER_ID) {
          found = Array.from(corners.get(i).data32F.slice(0, 8));
          break;
        }
      }
      return { ms, found };
    };

    // Warm-up: the first calls pay for WASM memory growth and JIT.
    for (let i = 0; i < 5; i++) runOne(frames[i % frames.length]);

    const times = [];
    let hits = 0;
    let errSum = 0;
    const wallStart = performance.now();
    for (const frame of frames) {
      const { ms, found } = runOne(frame);
      times.push(ms);
      if (found) {
        hits++;
        errSum += scene.meanCornerError(found, frame.truth.corners);
      }
    }
    const wallMs = performance.now() - wallStart;

    times.sort((a, b) => a - b);
    rows.push({
      size: `${width}x${height}`,
      refine: refine ? 'on' : 'off',
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      max: times[times.length - 1],
      perSecond: (frames.length / wallMs) * 1000,
      found: `${hits}/${frames.length}`,
      cornerErr: hits > 0 ? errSum / hits : NaN,
    });

    for (const m of [rgba, gray, ids]) m.delete();
    corners.delete();
    rejected.delete();
    detector.delete();
  }
}

const header = ['Processing size', 'Sub-pixel', 'p50 ms', 'p95 ms', 'max ms', 'det/s', 'found', 'corner err px'];
console.log(`| ${header.join(' | ')} |`);
console.log(`| ${header.map(() => '---').join(' | ')} |`);
for (const r of rows) {
  console.log(
    `| ${r.size} | ${r.refine} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ` +
      `${r.max.toFixed(2)} | ${r.perSecond.toFixed(1)} | ${r.found} | ` +
      `${Number.isNaN(r.cornerErr) ? '-' : r.cornerErr.toFixed(3)} |`,
  );
}

console.log('');
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`${FRAMES} frames per configuration, synthetic clip, marker id ${MARKER_ID}.`);
console.log('OpenCV.js build: stock, no SIMD, no threads.');

// Emscripten keeps the event loop alive; exit explicitly.
process.exit(0);
