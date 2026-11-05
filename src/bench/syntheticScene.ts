/**
 * Synthetic marker frames, in pure JavaScript.
 *
 * Deliberately has no dependency on OpenCV or on the DOM, so the exact same
 * generator feeds three things and they stay comparable:
 *   - the in-browser benchmark page
 *   - the headless Node benchmark
 *   - the Y4M clip used as Chromium's fake camera in the E2E test
 *
 * It renders the marker through an inverse homography with bilinear sampling, so
 * edges land on sub-pixel positions. That is the point: a nearest-neighbour
 * render would quantise the corners and make a detector with sub-pixel
 * refinement look no better than one without.
 *
 * Ground-truth corners are returned with every frame, which is what makes
 * corner accuracy measurable rather than merely assumed.
 */

import { markerBits } from '../marker/markerSvg';

/** Grid size of a 4x4 marker including its black border. */
const GRID = 6;

export interface SceneOptions {
  width: number;
  height: number;
  markerId: number;
  /** Width of the white sheet around the marker, in marker side lengths. */
  quietFraction?: number;
  /** 0..1 noise amplitude; a little makes the test less artificial. */
  noise?: number;
  /** Background grey level behind the sheet. */
  background?: number;
  /** Deterministic seed, so runs are repeatable. */
  seed?: number;
}

export interface MarkerPlacement {
  /** Frame-space corners, TL TR BR BL, matching detectMarkers ordering. */
  corners: [number, number, number, number, number, number, number, number];
}

export interface SyntheticFrame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
  /** Ground-truth marker corners in frame pixels, TL TR BR BL. */
  truth: MarkerPlacement;
}

/**
 * A marker moving, tilting and changing distance over a loop, so a benchmark
 * covers a realistic spread of apparent sizes and angles rather than one pose.
 */
export function placementAt(t: number, width: number, height: number): MarkerPlacement {
  const cx = width / 2 + Math.sin(t * 0.9) * width * 0.16;
  const cy = height / 2 + Math.cos(t * 0.7) * height * 0.12;
  // Apparent side length, cycling between a fifth and two fifths of the frame
  // height. The upper bound keeps the white quiet zone inside the frame too:
  // a clipped quiet zone costs detections for reasons that have nothing to do
  // with the detector under test.
  const size = height * (0.3 + 0.1 * Math.sin(t * 0.5));
  const yaw = Math.sin(t * 0.8) * 0.5;
  const pitch = Math.cos(t * 0.6) * 0.4;
  const roll = Math.sin(t * 0.35) * 0.3;

  // Project a unit square through a pinhole rather than interpolating corners,
  // so the result is a genuinely projective quad and the pose solver is given a
  // consistent problem.
  //
  // Working in units of the square's own side length: at depth Z the square
  // spans f/Z pixels, so placing it at Z0 = f / size makes it span exactly
  // `size` pixels when it faces the camera.
  const f = height * 1.1;
  const depth = f / size;
  const half = 0.5;
  const local: [number, number, number][] = [
    [-half, half, 0],
    [half, half, 0],
    [half, -half, 0],
    [-half, -half, 0],
  ];

  const cosA = Math.cos(yaw);
  const sinA = Math.sin(yaw);
  const cosB = Math.cos(pitch);
  const sinB = Math.sin(pitch);
  const cosC = Math.cos(roll);
  const sinC = Math.sin(roll);

  const out: number[] = [];
  for (const [x, y, z] of local) {
    // Yaw about Y, pitch about X, roll about Z.
    let px = cosA * x + sinA * z;
    let py = y;
    let pz = -sinA * x + cosA * z;

    const ny = cosB * py - sinB * pz;
    pz = sinB * py + cosB * pz;
    py = ny;

    const nx = cosC * px - sinC * py;
    py = sinC * px + cosC * py;
    px = nx;

    // px, py, pz are already in units of the square's side.
    const Z = pz + depth;
    out.push(cx + (f * px) / Z, cy - (f * py) / Z);
  }

  return { corners: out as MarkerPlacement['corners'] };
}

/** Solves for the homography mapping the unit square to `quad`. */
function unitSquareToQuad(
  quad: readonly number[],
): [number, number, number, number, number, number, number, number, number] {
  // Unit square corners in the same order as the quad: (0,0) (1,0) (1,1) (0,1).
  const src: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  // 8x8 linear system for h11..h32 with h33 = 1.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i] as [number, number];
    const x = quad[i * 2] as number;
    const y = quad[i * 2 + 1] as number;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solve8(A, b);
  return [
    h[0] as number,
    h[1] as number,
    h[2] as number,
    h[3] as number,
    h[4] as number,
    h[5] as number,
    h[6] as number,
    h[7] as number,
    1,
  ];
}

/** Gaussian elimination with partial pivoting. */
function solve8(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i] as number]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs((m[r] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) {
        pivot = r;
      }
    }
    const tmp = m[col] as number[];
    m[col] = m[pivot] as number[];
    m[pivot] = tmp;

    const pivotRow = m[col] as number[];
    const pv = pivotRow[col] as number;
    if (Math.abs(pv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r] as number[];
      const factor = (row[col] as number) / pv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        row[c] = (row[c] as number) - factor * (pivotRow[c] as number);
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const row = m[i] as number[];
    const d = row[i] as number;
    x[i] = Math.abs(d) < 1e-12 ? 0 : (row[n] as number) / d;
  }
  return x;
}

function invert3(
  h: readonly number[],
): [number, number, number, number, number, number, number, number, number] {
  const [a, b, c, d, e, f, g, i, j] = h as [
    number, number, number, number, number, number, number, number, number,
  ];
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const inv = 1 / det;
  return [
    A * inv,
    -(b * j - c * i) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * j - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * i - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Mulberry32: small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders one frame with the marker at `placement`. */
export function renderScene(opts: SceneOptions, placement: MarkerPlacement): SyntheticFrame {
  const { width, height, markerId } = opts;
  const quiet = opts.quietFraction ?? 0.32;
  const noise = opts.noise ?? 0.015;
  const bg = opts.background ?? 96;
  const rand = rng(opts.seed ?? 12345);

  const bits = markerBits(markerId);
  const H = unitSquareToQuad(placement.corners);
  const Hi = invert3(H);

  const data = new Uint8ClampedArray(width * height * 4);

  // Sampling the marker in its own unit space: sheet spans [-quiet, 1+quiet].
  const lo = -quiet;
  const hi = 1 + quiet;

  /**
   * Marker-space luminance at (u, v), with SHARP cell boundaries.
   *
   * Interpolating between cell values was the obvious thing to do and it was
   * wrong: it turns every cell into a gradient, OpenCV's per-cell bit sampling
   * averages that down toward the midpoint, and the marker becomes candidates
   * that are found but never decoded. A printed marker has hard-edged cells;
   * the smoothness belongs at the edges only, and comes from supersampling
   * below, which is also what a real camera does.
   */
  const sheetLuma = (u: number, v: number): number | null => {
    if (u < lo || u > hi || v < lo || v > hi) return null;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 243; // paper white
    const col = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const row = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    return bits[row]?.[col] ? 18 : 243;
  };

  // Supersampling gives edges that land on true sub-pixel positions, which is
  // what makes sub-pixel corner refinement measurable at all. 2x2 is enough:
  // 3x3 moved the measured corner error by under 0.02 px for 2.3x the cost.
  const SS = 2;
  const inv = 1 / (SS * SS);
  const step = 1 / SS;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          const w = Hi[6] * px + Hi[7] * py + Hi[8];
          if (Math.abs(w) < 1e-9) {
            acc += bg;
            continue;
          }
          const u = (Hi[0] * px + Hi[1] * py + Hi[2]) / w;
          const v = (Hi[3] * px + Hi[4] * py + Hi[5]) / w;
          const sheet = sheetLuma(u, v);
          // Gentle background gradient: a perfectly flat background is easier
          // for adaptive thresholding than anything real.
          acc += sheet ?? bg + 26 * (y / height) - 13;
        }
      }
      let luma = acc * inv;
      if (noise > 0) luma += (rand() - 0.5) * 255 * noise;
      const v8 = luma < 0 ? 0 : luma > 255 ? 255 : luma;
      const o = (y * width + x) * 4;
      data[o] = v8;
      data[o + 1] = v8;
      data[o + 2] = v8;
      data[o + 3] = 255;
    }
  }

  return { width, height, data, truth: placement };
}

/** Convenience: frame `index` of a looping animation. */
export function renderFrame(opts: SceneOptions, index: number, fps = 30): SyntheticFrame {
  const t = index / fps;
  return renderScene(
    { ...opts, seed: (opts.seed ?? 12345) + index },
    placementAt(t, opts.width, opts.height),
  );
}

/** Mean distance between two corner quads, in pixels. */
export function meanCornerError(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += Math.hypot((a[i * 2] as number) - (b[i * 2] as number), (a[i * 2 + 1] as number) - (b[i * 2 + 1] as number));
  }
  return sum / 4;
}
