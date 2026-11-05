import { describe, expect, it } from 'vitest';
import {
  mat3Apply,
  mat3Multiply,
  mat3ToQuat,
  markerPoseToThree,
  markerRotationMat3,
  quatAngleDeg,
  quatDot,
  quatNormalize,
  quatSlerp,
  rodriguesToMat3,
  type Mat3,
  type Quat,
  type Vec3,
} from '../../src/pose/poseMath';

const SQRT_HALF = Math.SQRT1_2;

function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Rotates a vector by a quaternion, independently of the matrix path. */
function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q_vec x v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function expectVecClose(a: Vec3, b: Vec3, tol = 1e-9): void {
  expect(a[0]).toBeCloseTo(b[0], Math.round(-Math.log10(tol)));
  expect(a[1]).toBeCloseTo(b[1], Math.round(-Math.log10(tol)));
  expect(a[2]).toBeCloseTo(b[2], Math.round(-Math.log10(tol)));
}

describe('rodriguesToMat3', () => {
  it('returns identity for a zero rotation vector', () => {
    const m = rodriguesToMat3([0, 0, 0]);
    expectVecClose(mat3Apply(m, [1, 2, 3]), [1, 2, 3]);
  });

  it('matches a known quarter turn about Z', () => {
    const m = rodriguesToMat3([0, 0, Math.PI / 2]);
    // +X should land on +Y.
    expectVecClose(mat3Apply(m, [1, 0, 0]), [0, 1, 0], 1e-12);
    expectVecClose(mat3Apply(m, [0, 1, 0]), [-1, 0, 0], 1e-12);
    expectVecClose(mat3Apply(m, [0, 0, 1]), [0, 0, 1], 1e-12);
  });

  it('matches a known half turn about X', () => {
    const m = rodriguesToMat3([Math.PI, 0, 0]);
    expectVecClose(mat3Apply(m, [0, 1, 0]), [0, -1, 0], 1e-12);
    expectVecClose(mat3Apply(m, [0, 0, 1]), [0, 0, -1], 1e-12);
  });

  it('preserves length and handedness for arbitrary rotations', () => {
    const samples: Vec3[] = [
      [0.1, -0.4, 0.9],
      [2.4, 0.3, -1.1],
      [-0.01, 0.02, -0.03],
      [3.1, 0, 0],
      [1e-10, -1e-10, 1e-10],
    ];
    for (const rvec of samples) {
      const m = rodriguesToMat3(rvec);
      // Right-handed, no scale: determinant is exactly +1.
      expect(det3(m)).toBeCloseTo(1, 9);
      const v: Vec3 = [0.3, -0.7, 0.2];
      const rotated = mat3Apply(m, v);
      expect(Math.hypot(...rotated)).toBeCloseTo(Math.hypot(...v), 9);
    }
  });

  it('uses the small-angle branch without losing orthonormality', () => {
    const m = rodriguesToMat3([1e-12, 0, 0]);
    expect(det3(m)).toBeCloseTo(1, 9);
  });
});

describe('mat3ToQuat', () => {
  it('agrees with the matrix it came from, across all four branches', () => {
    // These rotations are chosen to hit each branch of the trace/diagonal test.
    const rvecs: Vec3[] = [
      [0, 0, 0], // trace > 0
      [Math.PI * 0.99, 0, 0], // m00 largest
      [0, Math.PI * 0.99, 0], // m11 largest
      [0, 0, Math.PI * 0.99], // m22 largest
      [0.7, -1.2, 0.4],
      [-2.9, 0.6, 1.8],
    ];
    const probes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.26, -0.51, 0.82],
    ];

    for (const rvec of rvecs) {
      const m = rodriguesToMat3(rvec);
      const q = quatNormalize(mat3ToQuat(m));
      expect(Math.hypot(...q)).toBeCloseTo(1, 9);
      for (const p of probes) {
        expectVecClose(rotateByQuat(q, p), mat3Apply(m, p), 1e-7);
      }
    }
  });
});

describe('markerPoseToThree', () => {
  it('flips the camera basis: OpenCV +Y down / +Z forward becomes three.js +Y up / -Z forward', () => {
    const pose = markerPoseToThree([0, 0, 0], [0.2, 0.3, 1.5]);
    // A marker 1.5 m "forward" in OpenCV is 1.5 m along -Z in three.js, because
    // the three.js camera looks down -Z.
    expectVecClose(pose.position, [0.2, -0.3, -1.5], 1e-12);
  });

  it('puts a head-on marker exactly a quarter turn about X', () => {
    const { quaternion } = markerPoseToThree([0, 0, 0], [0, 0, 1]);
    // R = F * I * Rx(-90) works out to Rx(+90).
    expect(quaternion[0]).toBeCloseTo(SQRT_HALF, 9);
    expect(quaternion[1]).toBeCloseTo(0, 9);
    expect(quaternion[2]).toBeCloseTo(0, 9);
    expect(quaternion[3]).toBeCloseTo(SQRT_HALF, 9);
  });

  it('stands a Y-up model off the marker toward the viewer', () => {
    // This is the assertion that catches a model buried in the table or
    // sticking out the back of it.
    const m = markerRotationMat3([0, 0, 0]);
    expectVecClose(mat3Apply(m, [0, 1, 0]), [0, 0, 1], 1e-12);
  });

  it('keeps model right as world right, and does not mirror', () => {
    const m = markerRotationMat3([0, 0, 0]);
    expectVecClose(mat3Apply(m, [1, 0, 0]), [1, 0, 0], 1e-12);
    // A mirrored basis would give -1 here, and would show up as a model whose
    // text reads backwards -- easy to miss by eye on a symmetric model.
    expect(det3(m)).toBeCloseTo(1, 9);
  });

  it('never mirrors for any marker orientation', () => {
    for (const rvec of [
      [0.4, 0.2, -0.9],
      [2.2, -1.4, 0.3],
      [0, Math.PI, 0],
      [-1.1, 0.05, 2.7],
    ] as Vec3[]) {
      expect(det3(markerRotationMat3(rvec))).toBeCloseTo(1, 9);
    }
  });

  it('turns a marker rolled about its own normal into a roll about the model Y axis', () => {
    // Rotating the printed marker 90 degrees in its own plane (about the marker
    // frame +Z) must spin the model about its vertical axis, not tip it over.
    const m = markerRotationMat3([0, 0, Math.PI / 2]);
    const modelUp = mat3Apply(m, [0, 1, 0]);
    expectVecClose(modelUp, [0, 0, 1], 1e-9);
    // Model +X has swung to world -Y (screen up) ...
    const modelRight = mat3Apply(m, [1, 0, 0]);
    expect(Math.abs(modelRight[2])).toBeLessThan(1e-9);
  });

  it('produces a unit quaternion', () => {
    const { quaternion } = markerPoseToThree([0.9, -0.3, 1.4], [0, 0, 0.5]);
    expect(Math.hypot(...quaternion)).toBeCloseTo(1, 12);
  });
});

describe('mat3Multiply', () => {
  it('composes in the expected order', () => {
    const a = rodriguesToMat3([0, 0, Math.PI / 2]);
    const b = rodriguesToMat3([Math.PI / 2, 0, 0]);
    const ab = mat3Multiply(a, b);
    const v: Vec3 = [0.3, 0.5, -0.8];
    // (a*b) v == a (b v)
    expectVecClose(mat3Apply(ab, v), mat3Apply(a, mat3Apply(b, v)), 1e-12);
  });
});

describe('quatSlerp', () => {
  const qa: Quat = [0, 0, 0, 1];
  const qb = quatNormalize(mat3ToQuat(rodriguesToMat3([0, 0, Math.PI / 2])));

  it('returns the endpoints at t = 0 and t = 1', () => {
    expect(quatAngleDeg(quatSlerp(qa, qb, 0), qa)).toBeCloseTo(0, 6);
    expect(quatAngleDeg(quatSlerp(qa, qb, 1), qb)).toBeCloseTo(0, 6);
  });

  it('lands halfway at t = 0.5', () => {
    const mid = quatSlerp(qa, qb, 0.5);
    const total = quatAngleDeg(qa, qb);
    expect(quatAngleDeg(qa, mid)).toBeCloseTo(total / 2, 4);
    expect(quatAngleDeg(mid, qb)).toBeCloseTo(total / 2, 4);
  });

  it('stays a unit quaternion throughout', () => {
    for (const t of [0, 0.1, 0.37, 0.5, 0.83, 1]) {
      expect(Math.hypot(...quatSlerp(qa, qb, t))).toBeCloseTo(1, 9);
    }
  });

  it('takes the short way round when the target has flipped sign', () => {
    // A pose solver may return q or -q for the same orientation. Without the
    // dot-product check this interpolates the long way and the model visibly
    // spins through a full turn.
    const flipped: Quat = [-qb[0], -qb[1], -qb[2], -qb[3]];
    const direct = quatSlerp(qa, qb, 0.25);
    const viaFlipped = quatSlerp(qa, flipped, 0.25);
    expect(quatAngleDeg(direct, viaFlipped)).toBeCloseTo(0, 5);
    // And it never wanders further than the endpoints are apart.
    expect(quatAngleDeg(qa, viaFlipped)).toBeLessThan(quatAngleDeg(qa, qb) + 1e-6);
  });

  it('handles nearly identical orientations without dividing by zero', () => {
    const almost = quatNormalize([1e-9, 0, 0, 1]);
    const out = quatSlerp(qa, almost, 0.5);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Math.hypot(...out)).toBeCloseTo(1, 9);
  });

  it('converges monotonically when applied repeatedly, as the tracker does', () => {
    let q: Quat = qa;
    let previous = quatAngleDeg(q, qb);
    for (let i = 0; i < 40; i++) {
      q = quatSlerp(q, qb, 0.25);
      const remaining = quatAngleDeg(q, qb);
      expect(remaining).toBeLessThanOrEqual(previous + 1e-9);
      previous = remaining;
    }
    expect(previous).toBeLessThan(0.01);
  });
});

describe('quatAngleDeg', () => {
  it('is zero for identical orientations and for a sign flip', () => {
    const q: Quat = quatNormalize([0.2, -0.4, 0.1, 0.9]);
    expect(quatAngleDeg(q, q)).toBeCloseTo(0, 9);
    expect(quatAngleDeg(q, [-q[0], -q[1], -q[2], -q[3]])).toBeCloseTo(0, 6);
  });

  it('measures a known quarter turn as 90 degrees', () => {
    const q = quatNormalize(mat3ToQuat(rodriguesToMat3([0, 0, Math.PI / 2])));
    expect(quatAngleDeg([0, 0, 0, 1], q)).toBeCloseTo(90, 6);
  });
});

describe('quatDot / quatNormalize', () => {
  it('normalises to unit length and survives a zero quaternion', () => {
    expect(Math.hypot(...quatNormalize([3, 0, 4, 0]))).toBeCloseTo(1, 12);
    expect(quatNormalize([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
  });

  it('dot of a unit quaternion with itself is one', () => {
    const q = quatNormalize([0.3, 0.5, -0.2, 0.7]);
    expect(quatDot(q, q)).toBeCloseTo(1, 12);
  });
});
