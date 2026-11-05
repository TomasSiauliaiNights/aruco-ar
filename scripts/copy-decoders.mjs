#!/usr/bin/env node
/**
 * Copies three.js's Draco and Basis/KTX2 decoders into public/decoders/.
 *
 * Serving them from this origin rather than a CDN means: they are cached by the
 * service worker (so the app works offline after first load), their versions
 * cannot drift from the installed three, and no third-party request is made at
 * runtime -- which matters for an app whose selling point is that nothing leaves
 * the device.
 *
 * Draco's glTF-specific decoder lives in draco/gltf/, which is what
 * DRACOLoader.setDecoderPath('.../draco/') actually looks in.
 */

import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const libs = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs');
const out = join(root, 'public', 'decoders');

const jobs = [
  { from: join(libs, 'draco'), to: join(out, 'draco') },
  { from: join(libs, 'basis'), to: join(out, 'basis') },
];

for (const { from, to } of jobs) {
  if (!existsSync(from)) {
    console.error(`missing ${from} -- is three installed?`);
    process.exit(1);
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`  -> ${to.replace(root, '.')}`);
}

console.log('decoders copied');
