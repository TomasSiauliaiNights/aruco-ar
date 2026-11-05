/**
 * Camera intrinsics.
 *
 * Uncalibrated default: assume square pixels, a centred principal point, and a
 * horizontal field of view typical of a phone's main rear camera. That is good
 * enough for a model to sit convincingly on a marker -- the error shows up as a
 * few percent of scale, not as a wrong orientation.
 *
 * Calibrated: stored per device, normalised by the frame size so a resolution or
 * orientation change does not invalidate it.
 */

import type { Intrinsics } from '../detect/protocol';

const STORAGE_KEY = 'aruco-ar.calibration.v1';

export interface StoredCalibration {
  /** Normalised so the values survive a change of capture resolution. */
  fxOverWidth: number;
  fyOverHeight: number;
  cxOverWidth: number;
  cyOverHeight: number;
  distortion: [number, number, number, number, number];
  /** Diagnostics, shown in the debug panel. */
  rms: number;
  samples: number;
  capturedAt: string;
  sourceWidth: number;
  sourceHeight: number;
}

export function loadCalibration(): StoredCalibration | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCalibration;
    if (
      typeof parsed.fxOverWidth !== 'number' ||
      typeof parsed.fyOverHeight !== 'number' ||
      !Array.isArray(parsed.distortion) ||
      parsed.distortion.length !== 5
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCalibration(c: StoredCalibration): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

/** fx for a given width and horizontal FOV, assuming a pinhole camera. */
export function focalFromFov(width: number, horizontalFovDeg: number): number {
  const half = (horizontalFovDeg * Math.PI) / 360;
  return width / 2 / Math.tan(half);
}

/** Horizontal FOV implied by a focal length, in degrees. */
export function fovFromFocal(width: number, fx: number): number {
  return (2 * Math.atan(width / 2 / fx) * 180) / Math.PI;
}

export interface IntrinsicsInput {
  /** Native camera frame size. */
  sourceWidth: number;
  sourceHeight: number;
  /** Size of the frame actually given to the detector. */
  processingWidth: number;
  processingHeight: number;
  /** Used only when there is no stored calibration. */
  fallbackHorizontalFovDeg: number;
  calibration?: StoredCalibration | null;
}

/**
 * Intrinsics in the pixel units of the *processing* frame, which is what the
 * detector measures corners in. Keeping the scaling here means the worker never
 * has to know about the capture resolution.
 */
export function intrinsicsForFrame(input: IntrinsicsInput): Intrinsics {
  const {
    sourceWidth,
    sourceHeight,
    processingWidth,
    processingHeight,
    fallbackHorizontalFovDeg,
    calibration,
  } = input;

  if (calibration) {
    return {
      fx: calibration.fxOverWidth * processingWidth,
      fy: calibration.fyOverHeight * processingHeight,
      cx: calibration.cxOverWidth * processingWidth,
      cy: calibration.cyOverHeight * processingHeight,
      distortion: calibration.distortion,
    };
  }

  // Square pixels: one focal length in pixels for both axes at native size,
  // then scaled independently because the processing frame may not match the
  // source aspect exactly after rounding.
  const fNative = focalFromFov(sourceWidth, fallbackHorizontalFovDeg);
  return {
    fx: fNative * (processingWidth / sourceWidth),
    fy: fNative * (processingHeight / sourceHeight),
    cx: processingWidth / 2,
    cy: processingHeight / 2,
    distortion: [0, 0, 0, 0, 0],
  };
}

/**
 * Vertical FOV for the three.js camera, derived from the same intrinsics the
 * solver used. Must come from fy, not from a guess, or the model will not stay
 * glued to the marker as it moves toward the edge of the frame.
 */
export function verticalFovDeg(fy: number, height: number): number {
  return (2 * Math.atan(height / 2 / fy) * 180) / Math.PI;
}
