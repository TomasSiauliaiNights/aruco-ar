/**
 * Message contract between the main thread and the detector worker.
 * Imported by both sides so a change cannot desynchronise them.
 */

/** Pinhole intrinsics, in the pixel units of the frame actually sent to the detector. */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** [k1, k2, p1, p2, k3]; all zero when uncalibrated. */
  distortion: readonly [number, number, number, number, number];
}

export interface DetectParams {
  subPixelRefinement: boolean;
  aruco3: boolean;
  roiTracking: boolean;
  roiMarginFraction: number;
  fullScanInterval: number;
}

/** One detected marker with its pose, in OpenCV camera coordinates. */
export interface MarkerResult {
  id: number;
  /** 8 numbers: x0,y0,x1,y1,x2,y2,x3,y3 in processing-frame pixels, TL TR BR BL. */
  corners: number[];
  /** Rodrigues rotation vector. */
  rvec: [number, number, number];
  /** Translation in metres: OpenCV camera frame (+X right, +Y down, +Z forward). */
  tvec: [number, number, number];
  /** Mean reprojection error in processing-frame pixels. */
  reprojError: number;
  /** True when this detection came from a region-of-interest pass, not a full scan. */
  fromRoi: boolean;
}

export type ToWorker =
  | {
      type: 'init';
      /** Absolute URL of the vendored opencv.js. */
      opencvUrl: string;
      params: DetectParams;
    }
  | { type: 'params'; params: Partial<DetectParams> }
  | {
      type: 'frame';
      frameId: number;
      bitmap?: ImageBitmap;
      pixels?: Uint8ClampedArray;
      width: number;
      height: number;
      timestamp: number;
      intrinsics: Intrinsics;
      markerSizeMeters: number;
    }
  | { type: 'dispose' };

export type FromWorker =
  | {
      type: 'capabilities';
      /**
       * Whether the worker can rasterise a transferred ImageBitmap. False without
       * OffscreenCanvas (Safari below 16.4), in which case the main thread must
       * send raw RGBA pixels instead.
       */
      acceptsBitmap: boolean;
    }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; openCvBytes: number; loadMs: number }
  | {
      type: 'result';
      frameId: number;
      timestamp: number;
      width: number;
      height: number;
      markers: MarkerResult[];
      /** Time inside detectMarkers. */
      detectMs: number;
      /** Time inside solvePnP plus refinement, for all markers. */
      poseMs: number;
      /** Total worker time for this frame, including pixel upload. */
      totalMs: number;
      /**
       * Mean luminance of the greyscale frame, 0..255. Computed here because the
       * greyscale conversion has already happened, so the light estimate is free
       * rather than costing the main thread another pixel read.
       */
      meanLuma: number;
    }
  | { type: 'error'; message: string; fatal: boolean };
