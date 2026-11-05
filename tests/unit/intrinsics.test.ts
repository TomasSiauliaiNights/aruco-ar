import { describe, expect, it } from 'vitest';
import {
  focalFromFov,
  fovFromFocal,
  intrinsicsForFrame,
  verticalFovDeg,
  type StoredCalibration,
} from '../../src/pose/intrinsics';

describe('focalFromFov / fovFromFocal', () => {
  it('round-trips', () => {
    for (const fov of [40, 55, 62, 78, 110]) {
      const f = focalFromFov(1280, fov);
      expect(fovFromFocal(1280, f)).toBeCloseTo(fov, 9);
    }
  });

  it('gives the textbook value for a 90 degree field of view', () => {
    // At 90 degrees horizontal, the focal length equals half the width.
    expect(focalFromFov(1280, 90)).toBeCloseTo(640, 6);
  });

  it('a wider field of view means a shorter focal length', () => {
    expect(focalFromFov(1280, 90)).toBeLessThan(focalFromFov(1280, 50));
  });

  it('scales linearly with width at fixed field of view', () => {
    expect(focalFromFov(1280, 62)).toBeCloseTo(focalFromFov(640, 62) * 2, 9);
  });
});

describe('intrinsicsForFrame, uncalibrated', () => {
  const base = {
    sourceWidth: 1280,
    sourceHeight: 720,
    fallbackHorizontalFovDeg: 62,
    calibration: null,
  };

  it('centres the principal point on the processing frame', () => {
    const k = intrinsicsForFrame({ ...base, processingWidth: 480, processingHeight: 270 });
    expect(k.cx).toBeCloseTo(240, 9);
    expect(k.cy).toBeCloseTo(135, 9);
  });

  it('reports zero distortion', () => {
    const k = intrinsicsForFrame({ ...base, processingWidth: 480, processingHeight: 270 });
    expect(k.distortion).toEqual([0, 0, 0, 0, 0]);
  });

  it('scales focal length with the processing resolution', () => {
    // This is what lets the worker measure corners at 480 px while the solver
    // still gets consistent metres out.
    const full = intrinsicsForFrame({ ...base, processingWidth: 1280, processingHeight: 720 });
    const half = intrinsicsForFrame({ ...base, processingWidth: 640, processingHeight: 360 });
    expect(half.fx).toBeCloseTo(full.fx / 2, 6);
    expect(half.fy).toBeCloseTo(full.fy / 2, 6);
  });

  it('keeps the field of view invariant to processing resolution', () => {
    // The whole point: changing the processing width must not change the implied
    // camera geometry, or the model would jump when the resolution adapts.
    const a = intrinsicsForFrame({ ...base, processingWidth: 320, processingHeight: 180 });
    const b = intrinsicsForFrame({ ...base, processingWidth: 960, processingHeight: 540 });
    expect(fovFromFocal(320, a.fx)).toBeCloseTo(fovFromFocal(960, b.fx), 6);
    expect(fovFromFocal(320, a.fx)).toBeCloseTo(62, 6);
  });

  it('handles a portrait frame after an orientation change', () => {
    const k = intrinsicsForFrame({
      sourceWidth: 720,
      sourceHeight: 1280,
      processingWidth: 480,
      processingHeight: 853,
      fallbackHorizontalFovDeg: 62,
      calibration: null,
    });
    expect(k.cx).toBeCloseTo(240, 6);
    expect(k.cy).toBeCloseTo(426.5, 6);
    expect(k.fx).toBeGreaterThan(0);
    expect(k.fy).toBeGreaterThan(0);
  });
});

describe('intrinsicsForFrame, calibrated', () => {
  const calibration: StoredCalibration = {
    fxOverWidth: 1000 / 1280,
    fyOverHeight: 1010 / 720,
    cxOverWidth: 650 / 1280,
    cyOverHeight: 355 / 720,
    distortion: [0.1, -0.2, 0.001, -0.002, 0],
    rms: 0.3,
    samples: 10,
    capturedAt: '2026-01-01T00:00:00.000Z',
    sourceWidth: 1280,
    sourceHeight: 720,
  };

  it('reproduces the calibrated values at the calibrated resolution', () => {
    const k = intrinsicsForFrame({
      sourceWidth: 1280,
      sourceHeight: 720,
      processingWidth: 1280,
      processingHeight: 720,
      fallbackHorizontalFovDeg: 62,
      calibration,
    });
    expect(k.fx).toBeCloseTo(1000, 6);
    expect(k.fy).toBeCloseTo(1010, 6);
    expect(k.cx).toBeCloseTo(650, 6);
    expect(k.cy).toBeCloseTo(355, 6);
    expect(k.distortion).toEqual(calibration.distortion);
  });

  it('rescales to a different processing resolution', () => {
    const k = intrinsicsForFrame({
      sourceWidth: 1280,
      sourceHeight: 720,
      processingWidth: 640,
      processingHeight: 360,
      fallbackHorizontalFovDeg: 62,
      calibration,
    });
    expect(k.fx).toBeCloseTo(500, 6);
    expect(k.cx).toBeCloseTo(325, 6);
  });

  it('survives a capture-resolution change, which is why it is stored normalised', () => {
    const k = intrinsicsForFrame({
      sourceWidth: 1920,
      sourceHeight: 1080,
      processingWidth: 1920,
      processingHeight: 1080,
      fallbackHorizontalFovDeg: 62,
      calibration,
    });
    // Same field of view, more pixels.
    expect(fovFromFocal(1920, k.fx)).toBeCloseTo(fovFromFocal(1280, 1000), 6);
  });

  it('keeps an off-centre principal point off-centre', () => {
    const k = intrinsicsForFrame({
      sourceWidth: 1280,
      sourceHeight: 720,
      processingWidth: 480,
      processingHeight: 270,
      fallbackHorizontalFovDeg: 62,
      calibration,
    });
    expect(k.cx).not.toBeCloseTo(240, 3);
    expect(k.cx).toBeCloseTo((650 / 1280) * 480, 6);
  });
});

describe('verticalFovDeg', () => {
  it('derives the vertical field of view from fy', () => {
    // fy equal to half the height is 90 degrees vertically.
    expect(verticalFovDeg(360, 720)).toBeCloseTo(90, 6);
  });

  it('is narrower for a longer focal length', () => {
    expect(verticalFovDeg(1200, 720)).toBeLessThan(verticalFovDeg(600, 720));
  });

  it('matches the horizontal field of view for a square frame', () => {
    expect(verticalFovDeg(500, 500)).toBeCloseTo(fovFromFocal(500, 500), 9);
  });
});
