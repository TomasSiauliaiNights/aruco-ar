/**
 * Loads opencv.js on the main thread, for the pages that are not the AR view.
 *
 * The AR view deliberately does NOT use this: there, OpenCV lives in a worker so
 * detection cannot block a paint. The calibration page is different -- it has no
 * render loop to protect, and is far simpler with direct access to `cv`.
 *
 * Uses a <script> tag rather than fetch + blob so the browser's own HTTP cache
 * and the service worker serve it, which makes a second visit instant.
 */

import type { OpenCV } from './opencv-types';

/**
 * The module is handed back inside a wrapper, and that is not stylistic.
 *
 * opencv.js defines `Module.then`:
 *   function(func){ if(calledRun){func(Module)} else {...} return Module }
 *
 * so it is a thenable whose `then` returns itself. Resolving a promise with it
 * -- `resolve(mod)`, `return mod` from an async function, or `await mod` --
 * sends the promise resolution procedure into endless recursion. The failure is
 * silent and very hard to place: in a worker the thread is killed outright with
 * no error event; in Node the process stops dead, with even setTimeout no
 * longer firing. Wrapping it in an ordinary object keeps it out of the promise
 * machinery entirely.
 */
export interface OpenCvHandle {
  cv: OpenCV;
}

let loading: Promise<OpenCvHandle> | null = null;

declare global {
  interface Window {
    cv?: OpenCV;
  }
}

export function openCvUrl(): string {
  return new URL('vendor/opencv.js', document.baseURI).href;
}

/**
 * Polls for the runtime instead of using `onRuntimeInitialized`.
 *
 * Presetting `window.cv = { onRuntimeInitialized }` before the script loads
 * gets silently dropped, and assigning it afterwards overwrites the handler
 * opencv.js installed for its own binding generation. Polling observes the
 * result without interfering with either.
 */
function waitForRuntime(mod: OpenCV, timeoutMs = 60_000): Promise<void> {
  if (mod.Mat) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const poll = window.setInterval(() => {
      if (mod.Mat) {
        window.clearInterval(poll);
        resolve();
        return;
      }
      if (performance.now() - started > timeoutMs) {
        window.clearInterval(poll);
        reject(new Error(`opencv.js runtime did not initialise within ${timeoutMs / 1000}s`));
      }
    }, 50);
  });
}

export function loadOpenCvOnMainThread(url = openCvUrl()): Promise<OpenCvHandle> {
  if (loading) return loading;

  loading = new Promise<OpenCvHandle>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onerror = () => reject(new Error(`failed to load ${url}`));
    script.onload = () => {
      const mod = window.cv;
      if (!mod) {
        reject(new Error('opencv.js loaded but defined no module'));
        return;
      }
      waitForRuntime(mod).then(() => resolve({ cv: mod }), reject);
    };
    document.head.appendChild(script);
  });

  return loading;
}
