/**
 * Integration tests against the real, shipped opencv.js.
 *
 * Run with `npm run test:integration`.
 *
 * These exist because the riskiest assumptions in this project are not about
 * our own code, they are about what the stock OpenCV.js build actually provides
 * and how it behaves. Four things are pinned here:
 *
 *  1. The ArUco and planar-pose API surface is present under the names we use.
 *     Most guides insist a custom Emscripten build is required; it is not, but
 *     the bindings are namespaced (cv.aruco_ArucoDetector, not
 *     cv.ArucoDetector). If a future OpenCV renames them, this fails loudly
 *     here instead of at runtime on someone's phone.
 *
 *  2. The marker dictionary baked into src/marker/markerSvg.ts matches what the
 *     detector reads. Drift there would print markers the app cannot see.
 *
 *  3. detect -> solvePnP -> poseMath recovers a known pose.
 *
 *  4. The ChArUco calibration path recovers a known camera, which is what
 *     justifies the hand-derived corner-id mapping in src/marker/calibration.ts.
 *
 * ---------------------------------------------------------------------------
 * Why this file is .mjs while every other test is TypeScript
 *
 * Two separate things had to be worked around, both found the hard way:
 *
 *  - Loading the 11 MB opencv.js inside a Vitest worker ran for over seven
 *    minutes without reaching a single assertion. Node's own require path does
 *    it in about 250 ms, so these tests run under `node --test`.
 *
 *  - Requiring opencv.js from a module that Node had type-stripped (any .ts
 *    file) wedges the event loop: the require returns, but the Emscripten
 *    runtime never finishes initialising and even a plain setTimeout stops
 *    firing. Requiring it from an ordinary .mjs module works fine. So this file
 *    stays .mjs and pulls the TypeScript helpers in by dynamic import, which is
 *    unaffected.
 *
 * ts-resolve.mjs (loaded via --import) lets those TypeScript helpers keep their
 * ordinary extensionless imports.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const OPENCV_PATH = join(root, 'public', 'vendor', 'opencv.js');
const CACHE_DIR = join(root, 'node_modules', '.cache', 'opencv');
const CJS_PATH = join(CACHE_DIR, 'opencv.cjs');

const available = (() => {
  try {
    return statSync(OPENCV_PATH).size > 1_000_000;
  } catch {
    return false;
  }
})();

if (!available) {
  console.warn(
    'Skipping OpenCV integration tests: public/vendor/opencv.js is missing. Run "npm run assets".',
  );
}

const opts = available ? {} : { skip: 'opencv.js not built; run npm run assets' };

/** @type {any} */ let cv;
/** @type {any} */ let app;

/**
 * package.json sets "type": "module", so the vendored .js would be treated as
 * ESM and its UMD wrapper would throw. Copying it to a .cjs name takes the
 * CommonJS branch.
 */
function requireOpenCv() {
  const source = statSync(OPENCV_PATH);
  let stale = true;
  try {
    const existing = statSync(CJS_PATH);
    stale = existing.size !== source.size || existing.mtimeMs < source.mtimeMs;
  } catch {
    stale = true;
  }
  if (stale) {
    mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(OPENCV_PATH, CJS_PATH);
  }
  return createRequire(import.meta.url)(CJS_PATH);
}

const CORNER_REFINE_SUBPIX = 1;

before(async () => {
  if (!available) return;

  cv = requireOpenCv();
  if (!cv.Mat) {
    await new Promise((resolve, reject) => {
      cv.onRuntimeInitialized = resolve;
      setTimeout(() => reject(new Error('opencv.js did not initialise within 120s')), 120_000);
    });
  }

  const load = (p) => import(pathToFileURL(join(root, p)).href);
  const [markerSvg, poseMath, scene] = await Promise.all([
    load('src/marker/markerSvg.ts'),
    load('src/pose/poseMath.ts'),
    load('src/bench/syntheticScene.ts'),
  ]);
  app = { ...markerSvg, ...poseMath, ...scene };
});

/**
 * Emscripten keeps the Node event loop alive after instantiation, so the
 * process would hang after the last assertion. Exiting explicitly preserves
 * whatever exit code node:test already decided on.
 */
after(() => {
  if (!available) return;
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------

describe('opencv.js build contents', () => {
  it('exposes the ArUco detector under its namespaced binding name', opts, () => {
    assert.equal(typeof cv.getPredefinedDictionary, 'function');
    assert.equal(typeof cv.aruco_ArucoDetector, 'function');
    assert.equal(typeof cv.aruco_DetectorParameters, 'function');
    assert.equal(typeof cv.aruco_RefineParameters, 'function');
    assert.equal(typeof cv.DICT_4X4_50, 'number');
  });

  it('exposes the planar-square pose solver and its refinement', opts, () => {
    assert.equal(typeof cv.solvePnP, 'function');
    assert.equal(typeof cv.solvePnPRefineLM, 'function');
    assert.equal(typeof cv.projectPoints, 'function');
    assert.equal(typeof cv.SOLVEPNP_IPPE_SQUARE, 'number');
  });

  it('supports sub-pixel corner refinement through DetectorParameters', opts, () => {
    // cv.cornerSubPix is NOT exported by this build, so refinement has to come
    // from the detector's own parameter. If this property disappeared, the app
    // would silently drop to coarse corners and visibly jitter.
    const params = new cv.aruco_DetectorParameters();
    params.cornerRefinementMethod = CORNER_REFINE_SUBPIX;
    assert.equal(params.cornerRefinementMethod, CORNER_REFINE_SUBPIX);
    params.delete();
  });

  it('provides a 4x4 dictionary with 4-bit markers', opts, () => {
    assert.equal(cv.getPredefinedDictionary(cv.DICT_4X4_50).markerSize, 4);
  });

  it('does not expose cornerSubPix, which is why the parameter path matters', opts, () => {
    // Documents the constraint rather than asserting a wish: if a future build
    // adds it, this test is the reminder to reconsider the approach.
    assert.equal(cv.cornerSubPix, undefined);
  });
});

describe('marker dictionary matches OpenCV', () => {
  it('reproduces all 50 marker bit patterns', opts, () => {
    const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);

    for (let id = 0; id < app.DICT_4X4_50_CODES.length; id++) {
      const mat = new cv.Mat();
      // 6 px total = the 4x4 payload plus a one-cell black border.
      dict.generateImageMarker(id, 6, mat, 1);
      const data = mat.data;

      const fromOpenCv = [];
      for (let row = 0; row < 6; row++) {
        const cols = [];
        for (let col = 0; col < 6; col++) cols.push(data[row * 6 + col] < 128);
        fromOpenCv.push(cols);
      }
      mat.delete();

      assert.deepEqual(app.markerBits(id), fromOpenCv, `marker ${id} differs from OpenCV`);
    }
  });

  it('covers exactly the 50 ids the dictionary defines', opts, () => {
    assert.equal(app.DICT_4X4_50_CODES.length, 50);
    assert.throws(() => app.markerBits(50), RangeError);
  });
});

describe('detection and pose round-trip', () => {
  function makeDetector(refine) {
    const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    const params = new cv.aruco_DetectorParameters();
    params.cornerRefinementMethod = refine;
    return new cv.aruco_ArucoDetector(dict, params, new cv.aruco_RefineParameters(10, 3, true));
  }

  /** Detects marker 0 in an RGBA frame; returns its 8 corner values or null. */
  function detect(detector, frame) {
    const rgba = new cv.Mat(frame.height, frame.width, cv.CV_8UC4);
    rgba.data.set(frame.data);
    const gray = new cv.Mat(frame.height, frame.width, cv.CV_8UC1);
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

    const corners = new cv.MatVector();
    const ids = new cv.Mat();
    const rejected = new cv.MatVector();
    detector.detectMarkers(gray, corners, ids, rejected);

    let out = null;
    for (let i = 0; i < ids.rows; i++) {
      if (ids.data32S[i] === 0) {
        out = Array.from(corners.get(i).data32F.slice(0, 8));
        break;
      }
    }

    rgba.delete();
    gray.delete();
    ids.delete();
    corners.delete();
    rejected.delete();
    return out;
  }

  it('finds the marker across the whole synthetic motion loop', opts, () => {
    const detector = makeDetector(CORNER_REFINE_SUBPIX);
    let found = 0;
    const total = 24;
    for (let i = 0; i < total; i++) {
      const frame = app.renderScene(
        { width: 640, height: 480, markerId: 0, seed: 4242 + i },
        app.placementAt(i / 6, 640, 480),
      );
      if (detect(detector, frame)) found++;
    }
    // The clip includes steep angles, so a few misses are acceptable; wholesale
    // failure is not.
    assert.ok(found / total > 0.9, `found ${found}/${total}`);
    detector.delete();
  });

  it('locates corners to within a pixel of ground truth, with a consistent bias', opts, () => {
    const detector = makeDetector(CORNER_REFINE_SUBPIX);
    const frame = app.renderScene(
      { width: 640, height: 480, markerId: 0, noise: 0, seed: 11 },
      app.placementAt(0.2, 640, 480),
    );
    const corners = detect(detector, frame);
    assert.ok(corners, 'marker not detected');

    const err = app.meanCornerError(corners, frame.truth.corners);
    // There is a systematic offset of roughly half a pixel between "the quad
    // the renderer drew" and "the corner OpenCV reports", because the two
    // disagree about where an antialiased black-to-white edge is. That offset
    // is a convention difference, not an error, so the absolute bound is loose.
    assert.ok(err < 1, `mean corner error ${err.toFixed(3)} px`);

    // What actually matters for jitter is that the offset is CONSISTENT: a
    // constant bias moves the model a fraction of a millimetre, while a bias
    // that varies corner to corner shows up as wobble. So check the spread.
    const perCorner = [];
    for (let i = 0; i < 4; i++) {
      perCorner.push(
        Math.hypot(
          corners[i * 2] - frame.truth.corners[i * 2],
          corners[i * 2 + 1] - frame.truth.corners[i * 2 + 1],
        ),
      );
    }
    const spread = Math.max(...perCorner) - Math.min(...perCorner);
    assert.ok(spread < 0.5, `corner error spread ${spread.toFixed(3)} px`);
    detector.delete();
  });

  it('returns genuinely sub-pixel corners, not integers', opts, () => {
    // This is the measurable difference against a detector with no refinement
    // (js-aruco2 returns whole pixels), and it is what keeps a still marker from
    // wobbling once the pose is solved.
    const detector = makeDetector(CORNER_REFINE_SUBPIX);
    const frame = app.renderScene(
      { width: 640, height: 480, markerId: 0, noise: 0, seed: 12 },
      app.placementAt(0.37, 640, 480),
    );
    const corners = detect(detector, frame);
    assert.ok(corners);
    const fractional = corners.filter((v) => Math.abs(v - Math.round(v)) > 1e-4);
    assert.ok(fractional.length > 4, `only ${fractional.length} of 8 values were fractional`);
    detector.delete();
  });

  it('recovers a known pose through solvePnP IPPE_SQUARE', opts, () => {
    const detector = makeDetector(CORNER_REFINE_SUBPIX);
    const W = 640;
    const H = 480;
    const markerM = 0.1;
    const fx = 620;
    const fy = 620;

    // Build the frame from a KNOWN camera and a KNOWN marker pose by projecting
    // the marker's own corners, so there is real ground truth to compare with
    // rather than mere self-consistency.
    //
    // The pose has to be one where the camera sees the marker's FRONT. With
    // rvec = 0 the marker's +Z runs away from the camera, so we would be
    // looking at its back; the projected quad comes out wound the other way,
    // the renderer draws a mirrored pattern, and the detector correctly refuses
    // to decode it. Composing a small rotation with a half turn about X is what
    // "facing the camera" actually means here.
    const facing = app.mat3Multiply(
      app.rodriguesToMat3([Math.PI, 0, 0]),
      app.rodriguesToMat3([0.22, -0.35, 0.12]),
    );
    const Rmat = cv.matFromArray(3, 3, cv.CV_64F, Array.from(facing));
    const rvecMat = new cv.Mat();
    cv.Rodrigues(Rmat, rvecMat);
    const trueRvec = Array.from(rvecMat.data64F.slice(0, 3));
    const trueTvec = [0.015, -0.02, 0.44];

    const objectPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
      -markerM / 2, markerM / 2, 0,
      markerM / 2, markerM / 2, 0,
      markerM / 2, -markerM / 2, 0,
      -markerM / 2, -markerM / 2, 0,
    ]);
    const K = cv.matFromArray(3, 3, cv.CV_64F, [fx, 0, W / 2, 0, fy, H / 2, 0, 0, 1]);
    const D = cv.Mat.zeros(5, 1, cv.CV_64F);
    const rvecTrue = cv.matFromArray(3, 1, cv.CV_64F, trueRvec);
    const tvecTrue = cv.matFromArray(3, 1, cv.CV_64F, trueTvec);
    const projected = new cv.Mat();
    cv.projectPoints(objectPoints, rvecTrue, tvecTrue, K, D, projected);
    const expectedCorners = Array.from(projected.data32F.slice(0, 8));

    // Guard the convention above: with the marker facing the camera, the
    // projected corners must trace the same way round the screen that
    // detectMarkers reports (top-left, top-right, bottom-right, bottom-left).
    let twiceArea = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      twiceArea +=
        expectedCorners[i * 2] * expectedCorners[j * 2 + 1] -
        expectedCorners[j * 2] * expectedCorners[i * 2 + 1];
    }
    assert.ok(twiceArea > 0, 'projected quad is wound the wrong way: the camera is behind the marker');

    const frame = app.renderScene(
      { width: W, height: H, markerId: 0, noise: 0.004, seed: 777 },
      { corners: expectedCorners },
    );
    const corners = detect(detector, frame);
    assert.ok(corners, 'marker not detected in the projected frame');

    const imagePoints = cv.matFromArray(4, 1, cv.CV_32FC2, corners);
    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const ok = cv.solvePnP(
      objectPoints, imagePoints, K, D, rvec, tvec, false, cv.SOLVEPNP_IPPE_SQUARE,
    );
    assert.equal(ok, true);
    cv.solvePnPRefineLM(objectPoints, imagePoints, K, D, rvec, tvec);

    const t = Array.from(tvec.data64F.slice(0, 3));
    const r = Array.from(rvec.data64F.slice(0, 3));

    // Position to within a millimetre at 44 cm.
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(t[i] - trueTvec[i]) < 0.001,
        `tvec[${i}] ${t[i].toFixed(4)} vs ${trueTvec[i]}`,
      );
    }

    // Orientation to within a degree, compared through the same conversion the
    // renderer uses, so this covers poseMath as well as the solver.
    const got = app.markerPoseToThree(r, t);
    const want = app.markerPoseToThree(trueRvec, trueTvec);
    const angle = app.quatAngleDeg(got.quaternion, want.quaternion);
    assert.ok(angle < 1, `orientation off by ${angle.toFixed(3)} degrees`);

    // And the three.js position is the OpenCV one with Y and Z flipped.
    assert.ok(Math.abs(got.position[2] + trueTvec[2]) < 0.001);
    assert.ok(Math.abs(got.position[1] + trueTvec[1]) < 0.001);

    for (const m of [objectPoints, K, D, rvecTrue, tvecTrue, projected, imagePoints, rvec, tvec, Rmat, rvecMat]) {
      m.delete();
    }
    detector.delete();
  });

  it('scales reported distance linearly with the configured marker size', opts, () => {
    // Getting the printed size wrong scales every distance by the same factor.
    // This pins that relationship so the marker-size setting cannot drift.
    const detector = makeDetector(CORNER_REFINE_SUBPIX);
    const frame = app.renderScene(
      { width: 640, height: 480, markerId: 0, noise: 0, seed: 31 },
      app.placementAt(0.1, 640, 480),
    );
    const corners = detect(detector, frame);
    assert.ok(corners);

    const K = cv.matFromArray(3, 3, cv.CV_64F, [620, 0, 320, 0, 620, 240, 0, 0, 1]);
    const D = cv.Mat.zeros(5, 1, cv.CV_64F);
    const imagePoints = cv.matFromArray(4, 1, cv.CV_32FC2, corners);

    const distanceFor = (sizeM) => {
      const h = sizeM / 2;
      const obj = cv.matFromArray(4, 1, cv.CV_32FC3, [-h, h, 0, h, h, 0, h, -h, 0, -h, -h, 0]);
      const rvec = new cv.Mat();
      const tvec = new cv.Mat();
      cv.solvePnP(obj, imagePoints, K, D, rvec, tvec, false, cv.SOLVEPNP_IPPE_SQUARE);
      const z = tvec.data64F[2];
      obj.delete();
      rvec.delete();
      tvec.delete();
      return z;
    };

    const ratio = distanceFor(0.2) / distanceFor(0.1);
    assert.ok(Math.abs(ratio - 2) < 1e-3, `ratio ${ratio}`);

    K.delete();
    D.delete();
    imagePoints.delete();
    detector.delete();
  });
});

describe('ChArUco calibration recovers a known camera', () => {
  it('matches the true intrinsics within half a percent', opts, () => {
    // Mirrors src/marker/calibration.ts exactly, including the corner-id to 3D
    // mapping. That mapping cannot be read back from board.getChessboardCorners()
    // through the JS bindings (it returns an object with no usable rows or
    // data), so it is derived -- and this test is what justifies the
    // derivation: if it were wrong, the recovered focal length would be too.
    const SX = 5;
    const SY = 7;
    const SQ = 0.03;
    const COLS = SX - 1;
    const W = 1280;
    const H = 720;
    const truth = { fx: 1000, fy: 1000, cx: 650, cy: 355 };

    assert.equal(typeof cv.calibrateCameraExtended, 'function', 'calibrateCameraExtended missing');
    assert.equal(typeof cv.aruco_CharucoDetector, 'function', 'CharucoDetector missing');

    const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    const board = new cv.aruco_CharucoBoard(
      { width: SX, height: SY }, SQ, SQ * 0.75, dict, new cv.Mat(),
    );
    const detector = new cv.aruco_CharucoDetector(
      board,
      new cv.aruco_CharucoParameters(),
      new cv.aruco_DetectorParameters(),
      new cv.aruco_RefineParameters(10, 3, true),
    );

    const pxPerM = 4000;
    const bw = Math.round(SX * SQ * pxPerM);
    const bh = Math.round(SY * SQ * pxPerM);
    const boardImg = new cv.Mat();
    board.generateImage({ width: bw, height: bh }, boardImg, 0, 1);

    const Ktrue = cv.matFromArray(3, 3, cv.CV_64F, [
      truth.fx, 0, truth.cx, 0, truth.fy, truth.cy, 0, 0, 1,
    ]);
    const Dtrue = cv.Mat.zeros(5, 1, cv.CV_64F);

    const views = [
      [0.05, 0.05, 0, 0.42, 0, 0],
      [0.35, -0.15, 0.1, 0.4, 0.02, -0.01],
      [-0.3, 0.25, -0.1, 0.38, -0.03, 0.02],
      [0.2, 0.4, 0.2, 0.45, 0.04, 0.03],
      [-0.4, -0.3, -0.2, 0.36, -0.02, -0.03],
      [0.45, 0.1, 0.35, 0.5, 0.05, 0],
      [-0.15, 0.45, -0.3, 0.34, 0, 0.04],
      [0.3, -0.4, 0.15, 0.44, -0.04, -0.02],
      [0.1, 0.2, -0.4, 0.39, 0.03, -0.03],
      [-0.35, -0.1, 0.25, 0.47, -0.01, 0.03],
    ];

    const objV = new cv.MatVector();
    const imgV = new cv.MatVector();
    const temp = [];
    let usable = 0;

    for (const [rx, ry, rz, tz, tx, ty] of views) {
      const rvec = cv.matFromArray(3, 1, cv.CV_64F, [rx, ry, rz]);
      const tvec = cv.matFromArray(3, 1, cv.CV_64F, [tx, ty, tz]);
      const plane = cv.matFromArray(4, 1, cv.CV_32FC3, [
        0, 0, 0, SX * SQ, 0, 0, SX * SQ, SY * SQ, 0, 0, SY * SQ, 0,
      ]);
      const proj = new cv.Mat();
      cv.projectPoints(plane, rvec, tvec, Ktrue, Dtrue, proj);
      const p = proj.data32F;

      const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, bw, 0, bw, bh, 0, bh]);
      const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
        p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7],
      ]);
      const Hm = cv.getPerspectiveTransform(src, dst);

      const scene = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
      cv.warpPerspective(
        boardImg, scene, Hm, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT,
      );

      const chCorners = new cv.Mat();
      const chIds = new cv.Mat();
      detector.detectBoard(scene, chCorners, chIds);

      if (chIds.rows >= 8) {
        usable++;
        const n = chIds.rows;
        const obj = [];
        const img = [];
        for (let i = 0; i < n; i++) {
          const cid = chIds.data32S[i];
          obj.push(((cid % COLS) + 1) * SQ, (Math.floor(cid / COLS) + 1) * SQ, 0);
          img.push(chCorners.data32F[i * 2], chCorners.data32F[i * 2 + 1]);
        }
        const om = cv.matFromArray(n, 1, cv.CV_32FC3, obj);
        const im = cv.matFromArray(n, 1, cv.CV_32FC2, img);
        temp.push(om, im);
        objV.push_back(om);
        imgV.push_back(im);
      }

      for (const m of [rvec, tvec, plane, proj, src, dst, Hm, scene, chCorners, chIds]) m.delete();
    }

    assert.ok(usable >= 8, `only ${usable} usable views`);

    const K = cv.Mat.zeros(3, 3, cv.CV_64F);
    const D = cv.Mat.zeros(5, 1, cv.CV_64F);
    const rvecs = new cv.MatVector();
    const tvecs = new cv.MatVector();
    const sdI = new cv.Mat();
    const sdE = new cv.Mat();
    const perView = new cv.Mat();

    const rms = cv.calibrateCameraExtended(
      objV, imgV, new cv.Size(W, H),
      K, D, rvecs, tvecs, sdI, sdE, perView,
      cv.CALIB_FIX_K3,
      new cv.TermCriteria(cv.TERMCRIT_EPS + cv.TERMCRIT_ITER, 60, 1e-6),
    );

    const k = K.data64F;
    assert.ok(rms < 0.5, `RMS ${rms.toFixed(4)} px`);
    assert.ok(Math.abs(k[0] - truth.fx) / truth.fx < 0.005, `fx ${k[0].toFixed(1)}`);
    assert.ok(Math.abs(k[4] - truth.fy) / truth.fy < 0.005, `fy ${k[4].toFixed(1)}`);
    assert.ok(Math.abs(k[2] - truth.cx) / W < 0.005, `cx ${k[2].toFixed(1)}`);
    assert.ok(Math.abs(k[5] - truth.cy) / H < 0.005, `cy ${k[5].toFixed(1)}`);

    for (const m of [...temp, Ktrue, Dtrue, boardImg, K, D, sdI, sdE, perView]) m.delete();
    for (const v of [objV, imgV, rvecs, tvecs]) v.delete();
    detector.delete();
    board.delete();
  });
});
