import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

// GitHub Pages serves from /<repo>/, so the base path is injected by CI.
// Locally and on root-served hosts it stays '/'.
const base = process.env.BASE_PATH ?? '/';

// This file is ESM (package.json has "type": "module"), so __dirname does not exist.
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base,
  // HTTPS + LAN exposure so a phone on the same network can open the dev server.
  // getUserMedia requires a secure context, so plain http://<lan-ip> will not work.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  plugins: [basicSsl()],
  worker: {
    // The detector worker calls importScripts() to pull in opencv.js (a UMD
    // bundle with base64-embedded WASM). importScripts does not exist in module
    // workers, so the worker must be emitted as a classic/IIFE script.
    format: 'iife',
  },
  build: {
    target: ['es2022', 'safari15'],
    sourcemap: true,
    rollupOptions: {
      input: {
        main: dir('./index.html'),
        marker: dir('./marker.html'),
        calibrate: dir('./calibrate.html'),
        bench: dir('./bench.html'),
      },
    },
  },
});
