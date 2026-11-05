#!/usr/bin/env node
/**
 * Downloads the official OpenCV.js build into public/vendor/.
 *
 * It is fetched rather than committed because it is ~11 MB; git-ignoring it keeps
 * the repo small, and CI runs this script before building.
 *
 * Why the stock build and not a custom one: it already exposes the whole surface
 * this project needs, verified by calling it --
 *   cv.getPredefinedDictionary(cv.DICT_4X4_50)
 *   cv.aruco_ArucoDetector / aruco_DetectorParameters / aruco_RefineParameters
 *   cv.solvePnP with cv.SOLVEPNP_IPPE_SQUARE, cv.solvePnPRefineLM
 * The binding names carry an `aruco_` prefix, which is why grepping the file for
 * "ArucoDetector" finds nothing (the WASM is base64-embedded) and why the usual
 * advice is to build it yourself. You do not need to.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OPENCV_VERSION = '4.13.0';
const URL_JS = `https://docs.opencv.org/${OPENCV_VERSION}/opencv.js`;
const LICENSE_URL =
  'https://raw.githubusercontent.com/opencv/opencv/4.x/LICENSE';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'public', 'vendor');
const target = join(vendorDir, 'opencv.js');

const NOTICE = `OpenCV.js
=========

This directory contains an unmodified copy of the official OpenCV.js build
(version ${OPENCV_VERSION}), downloaded by scripts/fetch-opencv.mjs from:

  ${URL_JS}

OpenCV is distributed under the Apache License 2.0; see LICENSE-Apache-2.0.txt
in this directory. OpenCV is Copyright (c) the OpenCV contributors.

No OpenCV source was modified. The file is loaded at runtime by the detector
web worker (src/detect/worker.ts) and is not bundled into the application code.
`;

async function fileExistsWithSize(path) {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  await mkdir(vendorDir, { recursive: true });

  const existing = await fileExistsWithSize(target);
  if (existing > 1_000_000 && !process.argv.includes('--force')) {
    const hash = createHash('sha256').update(await readFile(target)).digest('hex');
    console.log(`opencv.js already present (${existing} bytes, sha256 ${hash.slice(0, 16)}...)`);
  } else {
    console.log(`Downloading OpenCV.js ${OPENCV_VERSION} ...`);
    await download(URL_JS, target);
    const buf = await readFile(target);
    const hash = createHash('sha256').update(buf).digest('hex');
    console.log(`  -> public/vendor/opencv.js  ${buf.length} bytes`);
    console.log(`  -> sha256 ${hash}`);
    if (buf.length < 1_000_000) {
      throw new Error('downloaded opencv.js is implausibly small; aborting');
    }
  }

  const licensePath = join(vendorDir, 'LICENSE-Apache-2.0.txt');
  if (!(await fileExistsWithSize(licensePath))) {
    try {
      await download(LICENSE_URL, licensePath);
      console.log('  -> public/vendor/LICENSE-Apache-2.0.txt');
    } catch (err) {
      console.warn(`  !! could not fetch the OpenCV LICENSE: ${err.message}`);
      console.warn('     Add it manually before shipping: Apache-2.0 requires it.');
    }
  }

  await writeFile(join(vendorDir, 'NOTICE.txt'), NOTICE, 'utf8');
  console.log('  -> public/vendor/NOTICE.txt');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
