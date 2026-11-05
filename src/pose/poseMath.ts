/**
 * Conversion from an OpenCV marker pose to a three.js transform.
 *
 * This is the single place the two coordinate conventions meet, and it is the
 * classic source of a model that renders mirrored, upside down, or behind the
 * camera. Two distinct changes of basis are involved, and both are applied here:
 *
 *   1. Camera frame. OpenCV: +X right, +Y DOWN, +Z FORWARD into the scene.
 *      three.js: +X right, +Y UP, camera looks down -Z. The change of basis is
 *      F = diag(1, -1, -1), which is a 180 degree rotation about X -- a proper
 *      rotation (det = +1), so nothing is mirrored.
 *
 *   2. Marker frame. The object points fed to solvePnP put the marker in its own
 *      z = 0 plane with +Z out of the printed face. Models, by convention, are
 *      authored Y-up. So the model's local frame is rotated by Rx(-90) relative
 *      to the solver's marker frame.
 *
 * Composed: R_three = F * R_cv * Rx(-90), t_three = F * t_cv.
 *
 * Sanity checks, which the unit tests assert:
 *   rvec = 0, tvec = (0, 0, 1)  ->  position (0, 0, -1), one metre in front
 *   model local +Y  ->  world +Z, i.e. standing off the marker toward the viewer
 *   model local +X  ->  world +X, i.e. right stays right
 */

/** Row-major 3x3. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export type Vec3 = readonly [number, number, number];

/** (x, y, z, w), matching three.js Quaternion ordering. */
export type Quat = readonly [number, number, number, number];

/** F = diag(1, -1, -1): OpenCV camera basis -> three.js camera basis. */
const CV_TO_THREE: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

/** Rx(-90): solver marker frame -> Y-up model frame. */
const MARKER_TO_YUP: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        (a[r * 3] as number) * (b[c] as number) +
        (a[r * 3 + 1] as number) * (b[3 + c] as number) +
        (a[r * 3 + 2] as number) * (b[6 + c] as number);
    }
  }
  return out as unknown as Mat3;
}

export function mat3Apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Rodrigues rotation vector -> row-major 3x3.
 * Uses the small-angle limit below ~1e-8 rad, where sin(t)/t would lose precision.
 */
export function rodriguesToMat3(rvec: Vec3): Mat3 {
  const [rx, ry, rz] = rvec;
  const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);

  if (theta < 1e-8) {
    // First-order expansion: I + [r]_x
    return [1, -rz, ry, rz, 1, -rx, -ry, rx, 1];
  }

  const x = rx / theta;
  const y = ry / theta;
  const z = rz / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;

  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/** Row-major 3x3 rotation -> quaternion (x, y, z, w). Shepperd's branch selection. */
export function mat3ToQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * Shortest-arc slerp. Negates `b` when the dot product is negative, so the
 * interpolation never takes the long way round -- without this, a marker whose
 * recovered quaternion flips sign between frames produces a visible spin.
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = quatDot(a, b);

  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  // Near-identical orientations: lerp and renormalise, which avoids a 0/0 in the
  // trigonometric form.
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }

  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const theta = theta0 * t;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;

  return [a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1];
}

export interface ThreePose {
  /** Metres, three.js camera space. */
  position: Vec3;
  /** (x, y, z, w). */
  quaternion: Quat;
}

/** Full rotation basis of the marker in three.js space, before quaternion conversion. */
export function markerRotationMat3(rvec: Vec3): Mat3 {
  return mat3Multiply(mat3Multiply(CV_TO_THREE, rodriguesToMat3(rvec)), MARKER_TO_YUP);
}

/** The conversion this module exists for. */
export function markerPoseToThree(rvec: Vec3, tvec: Vec3): ThreePose {
  return {
    position: [tvec[0], -tvec[1], -tvec[2]],
    quaternion: quatNormalize(mat3ToQuat(markerRotationMat3(rvec))),
  };
}

/** Degrees between two orientations; used by the debug panel and the jitter test. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(quatDot(quatNormalize(a), quatNormalize(b))));
  return (2 * Math.acos(d) * 180) / Math.PI;
}
