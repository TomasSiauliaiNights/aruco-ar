/// <reference lib="webworker" />
/**
 * Detector worker: ArUco detection plus planar pose, off the main thread.
 *
 * Emitted as a classic (IIFE) worker, because opencv.js is a UMD bundle loaded
 * with importScripts(), which does not exist in module workers.
 *
 * Steady state makes no allocations: every Mat, the detector, the dictionary and
 * the rasterising canvas are created once and reused, and only their contents
 * are rewritten per frame.
 */

import type { DetectParams, FromWorker, Intrinsics, MarkerResult, ToWorker } from './protocol';
import { CORNER_REFINE_NONE, CORNER_REFINE_SUBPIX } from './opencv-types';
import type { CvMat, CvMatVector, ArucoDetector, ArucoDetectorParameters, ArucoDictionary, OpenCV } from './opencv-types';

const ctx = self as unknown as {
  postMessage: (msg: FromWorker, transfer?: Transferable[]) => void;
  importScripts: (...urls: string[]) => void;
  cv?: OpenCV;
  OffscreenCanvas?: typeof OffscreenCanvas;
  addEventListener: (type: 'message', cb: (ev: MessageEvent<ToWorker>) => void) => void;
};

function post(msg: FromWorker, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
}

/** OffscreenCanvas is how a transferred ImageBitmap becomes pixels in here. */
const ACCEPTS_BITMAP = typeof ctx.OffscreenCanvas === 'function';

post({ type: 'capabilities', acceptsBitmap: ACCEPTS_BITMAP });

// ---------------------------------------------------------------------------
// OpenCV loading
// ---------------------------------------------------------------------------

let cv: OpenCV | null = null;

/**
 * Fetches opencv.js with progress, then hands it to importScripts via a blob URL.
 * importScripts alone gives no progress events, and an 11 MB silent wait on a
 * phone reads as a hang.
 */
/**
 * IMPORTANT: the OpenCV module must never travel through a promise.
 *
 * opencv.js defines `Module.then`:
 *   function(func){ if(calledRun){func(Module)} else {...} return Module }
 *
 * That makes it a thenable whose `then` returns the module itself, so the
 * promise resolution procedure recurses without end. `return mod` from an
 * async function, `resolve(mod)`, or `await mod` is enough to do it, and the
 * failure is silent and baffling: in a worker the thread is killed outright
 * with no error event, moments after the last line that ran; in Node the
 * process simply stops, with even setTimeout no longer firing.
 *
 * So the module is assigned to a variable and the promise resolves with
 * nothing.
 */
async function loadOpenCv(url: string): Promise<void> {
  const started = performance.now();

  // Stream the file once purely to report progress, DISCARDING the bytes as
  // they arrive, then let importScripts load it from the HTTP cache this just
  // populated.
  //
  // The obvious alternative -- buffer the response, then hand the text to
  // importScripts via a blob URL -- kills the worker outright on this file.
  // Between the retained chunks, the concatenated copy, the decoded string and
  // the copy importScripts compiles, an 11 MB script turns into hundreds of
  // megabytes, and the worker is terminated with no error event: `init` is
  // handled, `ready` is posted, and then the thread simply stops, taking every
  // later message with it. Counting bytes without keeping them costs nothing
  // and keeps memory flat, which matters rather more on a phone than here.
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`opencv.js fetch failed: ${res.status} ${res.statusText}`);

  // Absent behind some proxies and when the response is compressed; the UI
  // falls back to showing megabytes rather than a percentage.
  const declared = Number(res.headers.get('content-length') ?? '0');
  let bytes = 0;

  if (res.body) {
    const reader = res.body.getReader();
    // Throttled: an 11 MB download arrives in hundreds of chunks, and a
    // postMessage per chunk is pure overhead for a progress bar nobody can
    // read at that rate.
    let lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const now = performance.now();
      if (now - lastPost > 100) {
        lastPost = now;
        post({ type: 'progress', loaded: bytes, total: declared });
      }
    }
    post({ type: 'progress', loaded: bytes, total: declared || bytes });
  } else {
    // No streaming support: fall back to a single read, and let it go at once.
    bytes = (await res.arrayBuffer()).byteLength;
    post({ type: 'progress', loaded: bytes, total: declared || bytes });
  }

  ctx.importScripts(url);

  const mod = ctx.cv as OpenCV | undefined;
  if (!mod) throw new Error('opencv.js did not define a module');

  await waitForRuntime(mod);

  // Assigned here rather than returned, for the reason above.
  cv = mod;
  post({ type: 'ready', openCvBytes: bytes, loadMs: performance.now() - started });
}

/**
 * Waits for the Emscripten runtime to finish instantiating, by polling.
 *
 * Deliberately does NOT use `onRuntimeInitialized`, in either direction:
 * presetting `self.cv = { onRuntimeInitialized }` before the import gets
 * silently dropped, and assigning it after the import overwrites the handler
 * opencv.js installed for its own binding generation. Polling for `cv.Mat`
 * observes the result without interfering with either.
 */
function waitForRuntime(mod: OpenCV, timeoutMs = 60_000): Promise<void> {
  if (mod.Mat) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const poll = setInterval(() => {
      if (mod.Mat) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (performance.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`opencv.js runtime did not initialise within ${timeoutMs / 1000}s`));
      }
    }, 25);
  });
}

// ---------------------------------------------------------------------------
// Reused OpenCV resources
// ---------------------------------------------------------------------------

interface Resources {
  dict: ArucoDictionary;
  params: ArucoDetectorParameters;
  detector: ArucoDetector;
  rgba: CvMat;
  gray: CvMat;
  corners: CvMatVector;
  ids: CvMat;
  rejected: CvMatVector;
  imagePoints: CvMat;
  objectPoints: CvMat;
  projected: CvMat;
  K: CvMat;
  D: CvMat;
  rvec: CvMat;
  tvec: CvMat;
  /** Size the rgba/gray Mats are currently allocated for. */
  width: number;
  height: number;
  /** Values the cached objectPoints / K / D were built from. */
  markerSize: number;
  intrinsicsKey: string;
}

let res: Resources | null = null;
let detectParams: DetectParams = {
  subPixelRefinement: true,
  aruco3: false,
  roiTracking: true,
  roiMarginFraction: 0.6,
  fullScanInterval: 30,
};

let canvas: OffscreenCanvas | null = null;
let canvasCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Last accepted quad per marker id, in processing-frame pixels, for ROI tracking. */
const lastQuads = new Map<number, number[]>();
let framesSinceFullScan = Number.MAX_SAFE_INTEGER;

function applyParams(p: ArucoDetectorParameters): void {
  p.cornerRefinementMethod = detectParams.subPixelRefinement
    ? CORNER_REFINE_SUBPIX
    : CORNER_REFINE_NONE;
  p.cornerRefinementWinSize = 5;
  p.cornerRefinementMaxIterations = 30;
  p.cornerRefinementMinAccuracy = 0.1;
  p.useAruco3Detection = detectParams.aruco3;
  if (detectParams.aruco3) {
    p.minSideLengthCanonicalImg = 32;
    p.minMarkerLengthRatioOriginalImg = 0;
  }
  // A printed marker on paper under room light thresholds fine with the defaults;
  // widening the window range only costs time.
  p.adaptiveThreshWinSizeMin = 3;
  p.adaptiveThreshWinSizeMax = 23;
  p.adaptiveThreshWinSizeStep = 10;
}

function ensureResources(cvm: OpenCV, width: number, height: number): Resources {
  if (res && res.width === width && res.height === height) return res;

  if (res) {
    // Only the size-dependent Mats need replacing.
    res.rgba.delete();
    res.gray.delete();
    res.rgba = new cvm.Mat(height, width, cvm.CV_8UC4);
    res.gray = new cvm.Mat(height, width, cvm.CV_8UC1);
    res.width = width;
    res.height = height;
    lastQuads.clear();
    return res;
  }

  const dict = cvm.getPredefinedDictionary(cvm.DICT_4X4_50);
  const params = new cvm.aruco_DetectorParameters();
  applyParams(params);
  const refine = new cvm.aruco_RefineParameters(10, 3, true);
  const detector = new cvm.aruco_ArucoDetector(dict, params, refine);

  res = {
    dict,
    params,
    detector,
    rgba: new cvm.Mat(height, width, cvm.CV_8UC4),
    gray: new cvm.Mat(height, width, cvm.CV_8UC1),
    corners: new cvm.MatVector(),
    ids: new cvm.Mat(),
    rejected: new cvm.MatVector(),
    imagePoints: cvm.matFromArray(4, 1, cvm.CV_32FC2, [0, 0, 0, 0, 0, 0, 0, 0]),
    objectPoints: cvm.matFromArray(4, 1, cvm.CV_32FC3, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    projected: cvm.matFromArray(4, 1, cvm.CV_32FC2, [0, 0, 0, 0, 0, 0, 0, 0]),
    K: cvm.matFromArray(3, 3, cvm.CV_64F, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    D: cvm.Mat.zeros(5, 1, cvm.CV_64F),
    rvec: cvm.Mat.zeros(3, 1, cvm.CV_64F),
    tvec: cvm.Mat.zeros(3, 1, cvm.CV_64F),
    width,
    height,
    markerSize: -1,
    intrinsicsKey: '',
  };
  return res;
}

/**
 * Marker-local object points, in the corner order detectMarkers returns
 * (top-left, top-right, bottom-right, bottom-left) and the order
 * SOLVEPNP_IPPE_SQUARE expects. The marker lies in its own z = 0 plane.
 */
function updateObjectPoints(r: Resources, sizeM: number): void {
  if (r.markerSize === sizeM) return;
  const h = sizeM / 2;
  const d = r.objectPoints.data32F;
  d[0] = -h; d[1] = h; d[2] = 0;
  d[3] = h;  d[4] = h; d[5] = 0;
  d[6] = h;  d[7] = -h; d[8] = 0;
  d[9] = -h; d[10] = -h; d[11] = 0;
  r.markerSize = sizeM;
}

function updateIntrinsics(r: Resources, k: Intrinsics): void {
  const key = `${k.fx},${k.fy},${k.cx},${k.cy},${k.distortion.join(',')}`;
  if (r.intrinsicsKey === key) return;
  const m = r.K.data64F;
  m[0] = k.fx; m[1] = 0;     m[2] = k.cx;
  m[3] = 0;    m[4] = k.fy;  m[5] = k.cy;
  m[6] = 0;    m[7] = 0;     m[8] = 1;
  const d = r.D.data64F;
  for (let i = 0; i < 5; i++) d[i] = k.distortion[i] ?? 0;
  r.intrinsicsKey = key;
}

// ---------------------------------------------------------------------------
// Per-frame work
// ---------------------------------------------------------------------------

function rasterise(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray | null {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    canvasCtx = canvas.getContext('2d', {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D | null;
  }
  if (!canvasCtx) return null;
  canvasCtx.drawImage(bitmap, 0, 0, width, height);
  return canvasCtx.getImageData(0, 0, width, height).data;
}

/** Bounding box of the previous quads, expanded, clamped to the frame. */
function roiFromQuads(width: number, height: number, margin: number): { x: number; y: number; w: number; h: number } | null {
  if (lastQuads.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const quad of lastQuads.values()) {
    for (let i = 0; i < 8; i += 2) {
      const x = quad[i] as number;
      const y = quad[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;

  const padX = (maxX - minX) * margin;
  const padY = (maxY - minY) * margin;
  const x = Math.max(0, Math.floor(minX - padX));
  const y = Math.max(0, Math.floor(minY - padY));
  const w = Math.min(width - x, Math.ceil(maxX + padX) - x);
  const h = Math.min(height - y, Math.ceil(maxY + padY) - y);

  // A ROI that is nearly the whole frame saves nothing and costs a crop.
  if (w < 32 || h < 32) return null;
  if (w * h > width * height * 0.75) return null;
  return { x, y, w, h };
}

function solvePose(
  cvm: OpenCV,
  r: Resources,
  quad: number[],
): { rvec: [number, number, number]; tvec: [number, number, number]; reprojError: number } | null {
  const ip = r.imagePoints.data32F;
  for (let i = 0; i < 8; i++) ip[i] = quad[i] as number;

  const ok = cvm.solvePnP(
    r.objectPoints,
    r.imagePoints,
    r.K,
    r.D,
    r.rvec,
    r.tvec,
    false,
    cvm.SOLVEPNP_IPPE_SQUARE,
  );
  if (!ok) return null;

  // IPPE_SQUARE is an analytic solution for a planar square; one LM pass on top
  // of it removes the residual bias from corner noise at a measured ~0.04 ms.
  cvm.solvePnPRefineLM(r.objectPoints, r.imagePoints, r.K, r.D, r.rvec, r.tvec);

  cvm.projectPoints(r.objectPoints, r.rvec, r.tvec, r.K, r.D, r.projected);
  const pp = r.projected.data32F;
  let err = 0;
  for (let i = 0; i < 4; i++) {
    const dx = (pp[i * 2] as number) - (quad[i * 2] as number);
    const dy = (pp[i * 2 + 1] as number) - (quad[i * 2 + 1] as number);
    err += Math.hypot(dx, dy);
  }

  const rv = r.rvec.data64F;
  const tv = r.tvec.data64F;
  return {
    rvec: [rv[0] as number, rv[1] as number, rv[2] as number],
    tvec: [tv[0] as number, tv[1] as number, tv[2] as number],
    reprojError: err / 4,
  };
}

/** Runs detectMarkers over `image`, writing quads offset by (ox, oy). */
function detectInto(
  cvm: OpenCV,
  r: Resources,
  image: CvMat,
  ox: number,
  oy: number,
  out: Map<number, number[]>,
): void {
  r.detector.detectMarkers(image, r.corners, r.ids, r.rejected);
  const n = r.ids.rows;
  if (n === 0) return;
  const ids = r.ids.data32S;
  for (let i = 0; i < n; i++) {
    const mat = r.corners.get(i);
    const c = mat.data32F;
    const quad = new Array<number>(8);
    for (let k = 0; k < 4; k++) {
      quad[k * 2] = (c[k * 2] as number) + ox;
      quad[k * 2 + 1] = (c[k * 2 + 1] as number) + oy;
    }
    out.set(ids[i] as number, quad);
  }
  void cvm;
}

function processFrame(msg: Extract<ToWorker, { type: 'frame' }>): void {
  const cvm = cv;
  if (!cvm) {
    msg.bitmap?.close();
    postEmptyResult(msg);
    return;
  }

  const t0 = performance.now();
  const { width, height } = msg;
  const r = ensureResources(cvm, width, height);
  updateObjectPoints(r, msg.markerSizeMeters);
  updateIntrinsics(r, msg.intrinsics);

  let pixels: Uint8ClampedArray | null = null;
  if (msg.bitmap) {
    pixels = rasterise(msg.bitmap, width, height);
    msg.bitmap.close();
  } else if (msg.pixels) {
    pixels = msg.pixels;
  }
  if (!pixels) {
    post({ type: 'error', message: 'frame had no usable pixel source', fatal: false });
    // Still report a result. The main thread releases its backpressure slot on
    // a result and only on a result, so returning here would stall the whole
    // pipeline after a single bad frame.
    postEmptyResult(msg);
    return;
  }

  r.rgba.data.set(pixels);
  cvm.cvtColor(r.rgba, r.gray, cvm.COLOR_RGBA2GRAY);

  const meanLuma = meanOf(r.gray.data);

  const found = new Map<number, number[]>();
  const tDetect = performance.now();
  let usedRoi = false;

  const wantFullScan = framesSinceFullScan >= detectParams.fullScanInterval;
  const roi =
    detectParams.roiTracking && !wantFullScan
      ? roiFromQuads(width, height, detectParams.roiMarginFraction)
      : null;

  if (roi) {
    const rect = new cvm.Rect(roi.x, roi.y, roi.w, roi.h);
    const view = r.gray.roi(rect);
    try {
      detectInto(cvm, r, view, roi.x, roi.y, found);
    } finally {
      view.delete();
    }
    usedRoi = true;
  }

  // A ROI miss falls back to a full scan in the same frame: one expensive frame
  // on loss beats a slow re-acquire.
  if (found.size === 0) {
    detectInto(cvm, r, r.gray, 0, 0, found);
    usedRoi = false;
    framesSinceFullScan = 0;
  } else {
    framesSinceFullScan++;
  }

  const detectMs = performance.now() - tDetect;

  lastQuads.clear();
  const markers: MarkerResult[] = [];
  const tPose = performance.now();
  for (const [id, quad] of found) {
    lastQuads.set(id, quad);
    const pose = solvePose(cvm, r, quad);
    if (!pose) continue;
    markers.push({
      id,
      corners: quad,
      rvec: pose.rvec,
      tvec: pose.tvec,
      reprojError: pose.reprojError,
      fromRoi: usedRoi,
    });
  }
  const poseMs = performance.now() - tPose;

  post({
    type: 'result',
    frameId: msg.frameId,
    timestamp: msg.timestamp,
    width,
    height,
    markers,
    detectMs,
    poseMs,
    totalMs: performance.now() - t0,
    meanLuma,
  });
}

/** A result with no markers, used on every failure path. */
function postEmptyResult(msg: Extract<ToWorker, { type: 'frame' }>): void {
  post({
    type: 'result',
    frameId: msg.frameId,
    timestamp: msg.timestamp,
    width: msg.width,
    height: msg.height,
    markers: [],
    detectMs: 0,
    poseMs: 0,
    totalMs: 0,
    meanLuma: 0,
  });
}

/**
 * Mean of a greyscale buffer, sampled every 16th pixel. Full accuracy is not
 * needed for an exposure hint, and the stride keeps this under 0.05 ms.
 */
function meanOf(data: Uint8Array): number {
  const stride = 16;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += stride) {
    sum += data[i] as number;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

ctx.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      detectParams = msg.params;
      loadOpenCv(msg.opencvUrl)
        .catch((err: unknown) => {
          post({ type: 'error', message: `detector init failed: ${String(err)}`, fatal: true });
        });
      break;
    }
    case 'params': {
      detectParams = { ...detectParams, ...msg.params };
      if (res) {
        applyParams(res.params);
        res.detector.setDetectorParameters(res.params);
        lastQuads.clear();
      }
      break;
    }
    case 'frame': {
      try {
        processFrame(msg);
      } catch (err) {
        msg.bitmap?.close();
        post({ type: 'error', message: `frame failed: ${String(err)}`, fatal: false });
        // Still report a result so the main thread releases backpressure.
        postEmptyResult(msg);
      }
      break;
    }
    case 'dispose': {
      lastQuads.clear();
      framesSinceFullScan = Number.MAX_SAFE_INTEGER;
      break;
    }
  }
});
