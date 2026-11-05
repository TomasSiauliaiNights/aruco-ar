import { describe, expect, it } from 'vitest';
import { PoseTracker, defaultTrackerOptions, type Measurement } from '../../src/pose/PoseTracker';
import type { Vec3 } from '../../src/pose/poseMath';

const FRAME_MS = 1000 / 60;

function tracker(overrides: Partial<typeof defaultTrackerOptions> = {}) {
  return new PoseTracker({ ...defaultTrackerOptions, ...overrides });
}

/** A head-on marker one metre away. */
function headOn(id = 0, z = 1, reprojError = 0.2): Measurement {
  return { id, rvec: [0, 0, 0], tvec: [0, 0, z], reprojError };
}

/** Advances the render loop by `frames`, optionally feeding a measurement each frame. */
function run(
  t: PoseTracker,
  frames: number,
  startMs: number,
  measurement?: () => Measurement[] | null,
): number {
  let now = startMs;
  for (let i = 0; i < frames; i++) {
    now += FRAME_MS;
    const m = measurement?.();
    if (m && m.length > 0) t.ingest(m, now);
    t.update(now, FRAME_MS);
  }
  return now;
}

describe('PoseTracker acquisition', () => {
  it('starts with nothing visible', () => {
    expect(tracker().visible).toHaveLength(0);
    expect(tracker().hasLock).toBe(false);
  });

  it('fades in rather than popping on', () => {
    const t = tracker({ fadeInMs: 180 });
    t.ingest([headOn()], 1000);
    t.update(1000 + FRAME_MS, FRAME_MS);

    const first = t.visible[0];
    expect(first).toBeDefined();
    // The very first frame must not already be fully opaque: that is the pop
    // this fade exists to prevent.
    expect(first!.opacity).toBeGreaterThan(0);
    expect(first!.opacity).toBeLessThan(0.5);
  });

  it('reaches full opacity within roughly the fade-in time', () => {
    const t = tracker({ fadeInMs: 180 });
    let now = 1000;
    now = run(t, 15, now, () => [headOn()]);
    expect(t.visible[0]!.opacity).toBeCloseTo(1, 5);
    expect(t.hasLock).toBe(true);
  });

  it('converges the filtered pose onto the measurement', () => {
    const t = tracker();
    run(t, 200, 1000, () => [headOn(0, 1.25)]);
    const marker = t.visible[0]!;
    // three.js space: OpenCV +Z forward maps to -Z.
    expect(marker.position[2]).toBeCloseTo(-1.25, 2);
    expect(marker.position[0]).toBeCloseTo(0, 3);
  });
});

describe('PoseTracker loss handling', () => {
  it('holds the last pose at full opacity for holdMs', () => {
    const t = tracker({ holdMs: 220, fadeOutMs: 260 });
    let now = run(t, 20, 1000, () => [headOn()]);
    const heldPosition = t.visible[0]!.position;

    // Stop feeding measurements but keep rendering, for less than holdMs.
    now = run(t, 10, now); // ~167 ms
    const held = t.visible[0]!;
    expect(held.phase).toBe('tracking');
    expect(held.opacity).toBeCloseTo(1, 5);
    // A single dropped detection must not move the model.
    expect(held.position[2]).toBeCloseTo(heldPosition[2], 4);
  });

  it('fades out after the hold expires, then disappears', () => {
    const t = tracker({ holdMs: 100, fadeOutMs: 200 });
    let now = run(t, 20, 1000, () => [headOn()]);

    now = run(t, 9, now); // ~150 ms: past hold, inside fade
    const fading = t.visible[0];
    expect(fading?.phase).toBe('fading-out');
    expect(fading!.opacity).toBeLessThan(1);
    expect(fading!.opacity).toBeGreaterThan(0);

    now = run(t, 40, now); // well past hold + fade
    expect(t.visible).toHaveLength(0);
    expect(t.hasLock).toBe(false);
  });

  it('fades back in from wherever it got to, without popping', () => {
    const t = tracker({ holdMs: 100, fadeOutMs: 400, fadeInMs: 400 });
    let now = run(t, 30, 1000, () => [headOn()]);

    now = run(t, 12, now); // start fading out
    const mid = t.visible[0]!.opacity;
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0);

    // Re-acquire: opacity must rise from `mid`, not jump to 1 or restart at 0.
    now += FRAME_MS;
    t.ingest([headOn()], now);
    t.update(now, FRAME_MS);
    const resumed = t.visible[0]!;
    expect(resumed.phase).toBe('tracking');
    expect(resumed.opacity).toBeGreaterThan(mid);
    expect(resumed.opacity).toBeLessThan(1);
  });

  it('reports hasLock false while only holding', () => {
    const t = tracker({ holdMs: 100, fadeOutMs: 200 });
    let now = run(t, 20, 1000, () => [headOn()]);
    now = run(t, 15, now);
    expect(t.hasLock).toBe(false);
  });
});

describe('PoseTracker outlier rejection', () => {
  it('ignores a measurement whose reprojection error is implausible', () => {
    const t = tracker({ maxReprojError: 5 });
    let now = run(t, 20, 1000, () => [headOn(0, 1)]);
    const before = t.visible[0]!.position[2];

    // A wildly different pose, flagged by a large reprojection error, arriving
    // on the very next frame while the track is still live.
    now += FRAME_MS;
    t.ingest([{ id: 0, rvec: [0, 0, 0], tvec: [0, 0, 4], reprojError: 40 }], now);
    t.update(now, FRAME_MS);
    expect(t.visible[0]!.position[2]).toBeCloseTo(before, 2);
    expect(t.visible[0]!.rejected).toBeGreaterThan(0);
  });

  it('rejects a single-frame orientation flip', () => {
    // Planar-square pose is ambiguous near head-on; a flipped solution appears
    // as a huge one-frame rotation that the real marker did not make.
    const t = tracker({ maxAngularJumpDeg: 45 });
    let now = run(t, 20, 1000, () => [headOn()]);

    now += FRAME_MS;
    t.ingest([{ id: 0, rvec: [2.6, 0, 0], tvec: [0, 0, 1], reprojError: 0.3 }], now);
    t.update(now, FRAME_MS);
    expect(t.visible[0]!.rejected).toBeGreaterThan(0);
  });

  it('lets a genuinely fast rotation through after a few frames', () => {
    // The flip guard must not permanently block real motion, or a quick flick of
    // the marker would freeze the model.
    const t = tracker({ maxAngularJumpDeg: 45 });
    let now = run(t, 20, 1000, () => [headOn()]);

    for (let i = 0; i < 5; i++) {
      now += FRAME_MS;
      t.ingest([{ id: 0, rvec: [2.6, 0, 0], tvec: [0, 0, 1], reprojError: 0.3 }], now);
      t.update(now, FRAME_MS);
    }
    // By now the repeated measurement has been accepted.
    expect(t.visible[0]!.phase).toBe('tracking');
    const q = t.visible[0]!.rawQuaternion;
    expect(Math.hypot(...q)).toBeCloseTo(1, 6);
  });

  it('discards a marker behind the camera', () => {
    const t = tracker();
    t.ingest([{ id: 0, rvec: [0, 0, 0], tvec: [0, 0, -1], reprojError: 0.1 }], 1000);
    t.update(1000, FRAME_MS);
    expect(t.visible).toHaveLength(0);
  });

  it('discards a non-finite pose', () => {
    const t = tracker();
    t.ingest(
      [{ id: 0, rvec: [0, 0, 0], tvec: [0, 0, Number.NaN] as unknown as Vec3, reprojError: 0.1 }],
      1000,
    );
    t.update(1000, FRAME_MS);
    expect(t.visible).toHaveLength(0);
  });
});

describe('PoseTracker multiple markers', () => {
  it('tracks markers independently', () => {
    const t = tracker();
    run(t, 30, 1000, () => [headOn(0, 1), headOn(3, 2)]);
    const ids = t.visible.map((m) => m.id).sort();
    expect(ids).toEqual([0, 3]);
    const first = t.visible.find((m) => m.id === 0)!;
    const second = t.visible.find((m) => m.id === 3)!;
    expect(first.position[2]).toBeCloseTo(-1, 2);
    expect(second.position[2]).toBeCloseTo(-2, 2);
  });

  it('loses one without disturbing the other', () => {
    const t = tracker({ holdMs: 60, fadeOutMs: 100 });
    let now = run(t, 30, 1000, () => [headOn(0), headOn(1)]);
    now = run(t, 30, now, () => [headOn(0)]);
    expect(t.visible.map((m) => m.id)).toEqual([0]);
    expect(t.visible[0]!.opacity).toBeCloseTo(1, 5);
  });
});

describe('PoseTracker frame-rate independence', () => {
  it('reaches a similar orientation at 30 and 60 fps', () => {
    // The slerp factor is compensated for dt, so the visual response should not
    // depend on the device's frame rate.
    const target: Measurement = { id: 0, rvec: [0, 0.6, 0], tvec: [0, 0, 1], reprojError: 0.2 };

    const at60 = tracker();
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 1000 / 60;
      at60.ingest([target], now);
      at60.update(now, 1000 / 60);
    }

    const at30 = tracker();
    now = 0;
    for (let i = 0; i < 30; i++) {
      now += 1000 / 30;
      at30.ingest([target], now);
      at30.update(now, 1000 / 30);
    }

    const q60 = at60.visible[0]!.quaternion;
    const q30 = at30.visible[0]!.quaternion;
    // Both have had one second of settling; they should agree closely.
    const dot = Math.abs(
      q60[0] * q30[0] + q60[1] * q30[1] + q60[2] * q30[2] + q60[3] * q30[3],
    );
    expect(dot).toBeGreaterThan(0.999);
  });
});

describe('PoseTracker configuration', () => {
  it('reset clears all tracks', () => {
    const t = tracker();
    run(t, 20, 1000, () => [headOn()]);
    t.reset();
    expect(t.visible).toHaveLength(0);
    expect(t.trackedIds).toEqual([]);
  });

  it('configure applies to existing tracks', () => {
    const t = tracker();
    run(t, 20, 1000, () => [headOn()]);
    t.configure({ positionMinCutoff: 9, holdMs: 0 });
    expect(t.options.positionMinCutoff).toBe(9);
    expect(t.options.holdMs).toBe(0);
  });

  it('with holdMs 0 it begins fading as soon as detection stops', () => {
    const t = tracker({ holdMs: 0, fadeOutMs: 200 });
    let now = run(t, 20, 1000, () => [headOn()]);
    now = run(t, 3, now);
    expect(t.visible[0]!.phase).toBe('fading-out');
  });
});
