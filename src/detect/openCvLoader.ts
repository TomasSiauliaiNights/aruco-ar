/**
 * Loads opencv.js on the main thread, for the pages that are not the AR view.
 *
 * The AR view deliberately does NOT use this: there, OpenCV lives in a worker so
 * detection cannot block a paint. The calibration and benchmark pages are
 * different -- neither has a render loop to protect, and both are simpler with
 * synchronous access to `cv`.
 *
 * Uses a <script> tag rather than fetch + blob so the browser's own HTTP cache
 * and the service worker serve it, which makes a second visit instant.
 */

import type { OpenCV } from './opencv-types';

let loading: Promise<OpenCV> | null = null;

declare global {
  interface Window {
    cv?: OpenCV;
  }
}

export function openCvUrl(): string {
  return new URL('vendor/opencv.js', document.baseURI).href;
}

export function loadOpenCvOnMainThread(url = openCvUrl()): Promise<OpenCV> {
  if (loading) return loading;

  loading = new Promise<OpenCV>((resolve, reject) => {
    // Pre-creating window.cv means the Emscripten module adopts this object
    // (`var Module = typeof cv !== "undefined" ? cv : {}`), so the
    // onRuntimeInitialized hook is registered before it could possibly fire.
    const stub = {
      onRuntimeInitialized: () => {
        const mod = window.cv;
        if (mod?.Mat) resolve(mod);
        else reject(new Error('opencv.js initialised without a Mat constructor'));
      },
    } as unknown as OpenCV;
    window.cv = stub;

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(script);

    window.setTimeout(() => {
      if (!window.cv?.Mat) reject(new Error('opencv.js did not initialise within 60s'));
    }, 60_000);
  });

  return loading;
}
