/**
 * Per-device camera calibration with a printed ChArUco board.
 *
 * The board is rendered by OpenCV's own `CharucoBoard.generateImage`, not by
 * hand-drawn SVG. That matters: a hand-built board whose marker ids, square
 * parity or marker-to-square ratio differ even slightly from what
 * `CharucoDetector` expects would still detect *something* and produce a
 * confident but wrong calibration. Letting OpenCV draw the thing it is going to
 * read removes that whole class of error.
 *
 * Result is stored normalised by frame size (see pose/intrinsics.ts) so it stays
 * valid if the capture resolution changes.
 */

import { loadOpenCvOnMainThread } from '../detect/openCvLoader';
import type { CvMat, CvMatVector, OpenCV } from '../detect/opencv-types';
import { clearCalibration, fovFromFocal, saveCalibration, type StoredCalibration } from '../pose/intrinsics';
import { config } from '../config';

const SQUARES_X = 5;
const SQUARES_Y = 7;
/** Marker side as a fraction of the square; 0.75 is OpenCV's usual choice. */
const MARKER_RATIO = 0.75;
const MIN_SHOTS = 8;
const MIN_CORNERS_PER_SHOT = 8;

const ui = {
  squareMm: byId<HTMLInputElement>('square-mm'),
  btnBoard: byId<HTMLButtonElement>('btn-board'),
  btnPrintBoard: byId<HTMLButtonElement>('btn-print-board'),
  boardPreview: byId<HTMLElement>('board-preview'),
  btnCamera: byId<HTMLButtonElement>('btn-camera'),
  btnCapture: byId<HTMLButtonElement>('btn-capture'),
  btnReset: byId<HTMLButtonElement>('btn-reset'),
  btnSolve: byId<HTMLButtonElement>('btn-solve'),
  btnClear: byId<HTMLButtonElement>('btn-clear'),
  video: byId<HTMLVideoElement>('cal-video'),
  canvas: byId<HTMLCanvasElement>('cal-canvas'),
  shots: byId<HTMLElement>('shots'),
  status: byId<HTMLElement>('status'),
  result: byId<HTMLTableElement>('result'),
  defaultFov: byId<HTMLElement>('default-fov'),
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

ui.defaultFov.textContent = `${config.camera.fallbackHorizontalFovDeg}°`;

/** One captured view: board corners and their ids, kept as OpenCV Mats. */
interface Shot {
  corners: CvMat;
  ids: CvMat;
  count: number;
}

let cv: OpenCV | null = null;
let board: unknown = null;
let detector: CharucoDetectorLike | null = null;
let stream: MediaStream | null = null;
const shots: Shot[] = [];
let frameSize = { width: 0, height: 0 };

/** Members of CharucoDetector / CharucoBoard used here, beyond opencv-types.ts. */
interface CharucoDetectorLike {
  detectBoard(image: CvMat, charucoCorners: CvMat, charucoIds: CvMat): void;
  delete(): void;
}
interface CharucoBoardLike {
  generateImage(size: { width: number; height: number }, out: CvMat, margin: number, borderBits: number): void;
  delete(): void;
}
interface CalibCv extends OpenCV {
  aruco_CharucoBoard: new (
    size: { width: number; height: number },
    squareLength: number,
    markerLength: number,
    dict: ReturnType<OpenCV['getPredefinedDictionary']>,
    ids: CvMat,
  ) => CharucoBoardLike;
  aruco_CharucoParameters: new () => { delete(): void };
  aruco_CharucoDetector: new (
    board: CharucoBoardLike,
    charucoParams: { delete(): void },
    detectorParams: ReturnType<() => never> | object,
    refineParams: object,
  ) => CharucoDetectorLike;
  calibrateCameraExtended(
    objectPoints: CvMatVector,
    imagePoints: CvMatVector,
    imageSize: { width: number; height: number },
    cameraMatrix: CvMat,
    distCoeffs: CvMat,
    rvecs: CvMatVector,
    tvecs: CvMatVector,
    stdDevIntrinsics: CvMat,
    stdDevExtrinsics: CvMat,
    perViewErrors: CvMat,
    flags: number,
    criteria: object,
  ): number;
  TermCriteria: new (type: number, maxCount: number, epsilon: number) => object;
  TERMCRIT_EPS: number;
  TERMCRIT_ITER: number;
  CALIB_FIX_K3: number;
  imshow?: (canvas: HTMLCanvasElement | string, mat: CvMat) => void;
}

function setStatus(message: string): void {
  ui.status.textContent = message;
}

function squareMeters(): number {
  const mm = Number.parseFloat(ui.squareMm.value) || 30;
  return Math.min(80, Math.max(5, mm)) / 1000;
}

async function ensureCv(): Promise<CalibCv> {
  if (cv) return cv as CalibCv;
  setStatus('Loading OpenCV (about 11 MB, cached after the first time)…');
  cv = await loadOpenCvOnMainThread();
  setStatus('OpenCV ready.');
  return cv as CalibCv;
}

function buildBoard(c: CalibCv): CharucoBoardLike {
  const square = squareMeters();
  const dict = c.getPredefinedDictionary(c.DICT_4X4_50);
  const emptyIds = new c.Mat();
  const b = new c.aruco_CharucoBoard(
    { width: SQUARES_X, height: SQUARES_Y },
    square,
    square * MARKER_RATIO,
    dict,
    emptyIds,
  );
  return b;
}

function ensureDetector(c: CalibCv): CharucoDetectorLike {
  if (detector) return detector;
  const b = buildBoard(c);
  board = b;
  detector = new c.aruco_CharucoDetector(
    b,
    new c.aruco_CharucoParameters(),
    new c.aruco_DetectorParameters(),
    new c.aruco_RefineParameters(10, 3, true),
  );
  return detector;
}

// ---------------------------------------------------------------------------
// Board generation / printing
// ---------------------------------------------------------------------------

ui.btnBoard.addEventListener('click', () => void generateBoard());

async function generateBoard(): Promise<void> {
  const c = await ensureCv();
  const b = buildBoard(c);
  const squareMm = squareMeters() * 1000;

  // Render at 8 px/mm, which is plenty for a 300 dpi print of this size.
  const pxPerMm = 8;
  const marginMm = squareMm * 0.5;
  const widthPx = Math.round((SQUARES_X * squareMm + marginMm * 2) * pxPerMm);
  const heightPx = Math.round((SQUARES_Y * squareMm + marginMm * 2) * pxPerMm);

  const img = new c.Mat();
  b.generateImage({ width: widthPx, height: heightPx }, img, Math.round(marginMm * pxPerMm), 1);

  // Mat (CV_8UC1) -> canvas -> <img> at exact physical size.
  const canvas = document.createElement('canvas');
  canvas.width = img.cols;
  canvas.height = img.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    setStatus('Could not render the board (no 2D canvas).');
    return;
  }
  const rgba = ctx.createImageData(img.cols, img.rows);
  const gray = img.data;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] as number;
    rgba.data[i * 4] = v;
    rgba.data[i * 4 + 1] = v;
    rgba.data[i * 4 + 2] = v;
    rgba.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);

  const totalWmm = SQUARES_X * squareMm + marginMm * 2;
  const totalHmm = SQUARES_Y * squareMm + marginMm * 2;

  ui.boardPreview.innerHTML = '';
  const el = document.createElement('img');
  el.id = 'board-img';
  el.alt = `ChArUco calibration board, ${SQUARES_X} by ${SQUARES_Y} squares of ${squareMm} mm`;
  el.src = canvas.toDataURL('image/png');
  // Physical sizing so printing at 100% gives the stated square size.
  el.style.width = `${totalWmm}mm`;
  el.style.height = `${totalHmm}mm`;
  el.style.maxWidth = '100%';
  ui.boardPreview.appendChild(el);
  ui.boardPreview.hidden = false;

  img.delete();
  b.delete();

  setStatus(
    `Board ready: ${SQUARES_X}x${SQUARES_Y} squares at ${squareMm} mm ` +
      `(sheet ${totalWmm.toFixed(0)}x${totalHmm.toFixed(0)} mm). Print at 100% scale.`,
  );
}

ui.btnPrintBoard.addEventListener('click', () => {
  if (ui.boardPreview.hidden) {
    setStatus('Generate the board first.');
    return;
  }
  window.print();
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

ui.btnCamera.addEventListener('click', () => void startCamera());

async function startCamera(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: config.camera.idealWidth },
        height: { ideal: config.camera.idealHeight },
      },
    });
  } catch (err) {
    setStatus(`Camera failed: ${String((err as Error).message ?? err)}`);
    return;
  }
  ui.video.srcObject = stream;
  await ui.video.play().catch(() => undefined);
  await ensureCv();
  ui.btnCapture.disabled = false;
  setStatus('Camera running. Frame the whole board, then capture.');
}

ui.btnCapture.addEventListener('click', () => void captureView());

async function captureView(): Promise<void> {
  const c = await ensureCv();
  const w = ui.video.videoWidth;
  const h = ui.video.videoHeight;
  if (w === 0 || h === 0) {
    setStatus('No camera frame yet.');
    return;
  }

  if (frameSize.width !== 0 && (frameSize.width !== w || frameSize.height !== h)) {
    setStatus('The camera resolution changed; discard the shots and start again.');
    return;
  }
  frameSize = { width: w, height: h };

  ui.canvas.width = w;
  ui.canvas.height = h;
  const ctx = ui.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(ui.video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);

  const rgba = new c.Mat(h, w, c.CV_8UC4);
  rgba.data.set(data.data);
  const gray = new c.Mat(h, w, c.CV_8UC1);
  c.cvtColor(rgba, gray, c.COLOR_RGBA2GRAY);

  const det = ensureDetector(c);
  const corners = new c.Mat();
  const ids = new c.Mat();
  det.detectBoard(gray, corners, ids);

  const count = ids.rows;
  rgba.delete();
  gray.delete();

  if (count < MIN_CORNERS_PER_SHOT) {
    corners.delete();
    ids.delete();
    setStatus(
      `Only ${count} board corners found (need ${MIN_CORNERS_PER_SHOT}). Move closer, ` +
        'get more light, or flatten the board.',
    );
    return;
  }

  shots.push({ corners, ids, count });
  renderShots();
  ui.btnSolve.disabled = shots.length < MIN_SHOTS;
  setStatus(
    `Captured ${shots.length} view${shots.length === 1 ? '' : 's'} (${count} corners). ` +
      (shots.length < MIN_SHOTS ? `${MIN_SHOTS - shots.length} more needed.` : 'Ready to calibrate.'),
  );
}

function renderShots(): void {
  ui.shots.innerHTML = '';
  shots.forEach((s, i) => {
    const pill = document.createElement('span');
    pill.className = 'ok';
    pill.textContent = `#${i + 1}: ${s.count}`;
    ui.shots.appendChild(pill);
  });
  for (let i = shots.length; i < MIN_SHOTS; i++) {
    const pill = document.createElement('span');
    pill.textContent = `#${i + 1}: —`;
    ui.shots.appendChild(pill);
  }
}

ui.btnReset.addEventListener('click', () => {
  for (const s of shots) {
    s.corners.delete();
    s.ids.delete();
  }
  shots.length = 0;
  frameSize = { width: 0, height: 0 };
  renderShots();
  ui.btnSolve.disabled = true;
  ui.result.hidden = true;
  setStatus('Shots discarded.');
});

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

ui.btnSolve.addEventListener('click', () => void solve());

async function solve(): Promise<void> {
  const c = await ensureCv();
  if (shots.length < MIN_SHOTS) return;
  setStatus('Calibrating…');

  const square = squareMeters();
  const objectPoints = new c.MatVector();
  const imagePoints = new c.MatVector();
  const built: CvMat[] = [];

  // ChArUco corner i is the inner chessboard corner at
  // (col, row) = (i % (SQUARES_X - 1), floor(i / (SQUARES_X - 1))), on z = 0.
  //
  // Derived rather than read from board.getChessboardCorners(), which returns an
  // unusable wrapper through the JS bindings (rows/cols/data32F all undefined).
  // Verified instead by end-to-end synthetic calibration: a known camera
  // (fx 1000, cx 650, cy 355) was recovered as fx 1001.2, cx 648.9, cy 354.8 at
  // RMS 0.157 px, which only works if this mapping is right. See
  // tests/integration/calibration.test.ts.
  const cols = SQUARES_X - 1;
  for (const shot of shots) {
    const n = shot.ids.rows;
    const ids = shot.ids.data32S;
    const obj: number[] = [];
    const imgPts: number[] = [];
    const src = shot.corners.data32F;
    for (let i = 0; i < n; i++) {
      const cornerId = ids[i] as number;
      const col = cornerId % cols;
      const row = Math.floor(cornerId / cols);
      obj.push((col + 1) * square, (row + 1) * square, 0);
      imgPts.push(src[i * 2] as number, src[i * 2 + 1] as number);
    }
    const objMat = c.matFromArray(n, 1, c.CV_32FC3, obj);
    const imgMat = c.matFromArray(n, 1, c.CV_32FC2, imgPts);
    built.push(objMat, imgMat);
    objectPoints.push_back(objMat);
    imagePoints.push_back(imgMat);
  }

  const K = c.Mat.zeros(3, 3, c.CV_64F);
  const D = c.Mat.zeros(5, 1, c.CV_64F);
  const rvecs = new c.MatVector();
  const tvecs = new c.MatVector();
  const stdInt = new c.Mat();
  const stdExt = new c.Mat();
  const perView = new c.Mat();

  let rms = NaN;
  try {
    rms = c.calibrateCameraExtended(
      objectPoints,
      imagePoints,
      frameSize,
      K,
      D,
      rvecs,
      tvecs,
      stdInt,
      stdExt,
      perView,
      // k3 is poorly constrained by a handful of phone shots and tends to make
      // the fit worse rather than better, so it is fixed at zero.
      c.CALIB_FIX_K3,
      new c.TermCriteria(c.TERMCRIT_EPS + c.TERMCRIT_ITER, 60, 1e-6),
    );
  } catch (err) {
    setStatus(`Calibration failed: ${String(err)}`);
    cleanup();
    return;
  }

  const k = K.data64F;
  const d = D.data64F;
  const fx = k[0] as number;
  const fy = k[4] as number;
  const cx = k[2] as number;
  const cy = k[5] as number;

  if (!Number.isFinite(fx) || fx <= 0) {
    setStatus('Calibration produced an unusable focal length; capture more varied views.');
    cleanup();
    return;
  }

  const stored: StoredCalibration = {
    fxOverWidth: fx / frameSize.width,
    fyOverHeight: fy / frameSize.height,
    cxOverWidth: cx / frameSize.width,
    cyOverHeight: cy / frameSize.height,
    distortion: [
      (d[0] as number) ?? 0,
      (d[1] as number) ?? 0,
      (d[2] as number) ?? 0,
      (d[3] as number) ?? 0,
      0,
    ],
    rms,
    samples: shots.length,
    capturedAt: new Date().toISOString(),
    sourceWidth: frameSize.width,
    sourceHeight: frameSize.height,
  };

  const saved = saveCalibration(stored);
  showResult(stored, rms, saved);
  cleanup();

  function cleanup(): void {
    for (const m of built) m.delete();
    objectPoints.delete();
    imagePoints.delete();
    K.delete();
    D.delete();
    rvecs.delete();
    tvecs.delete();
    stdInt.delete();
    stdExt.delete();
    perView.delete();
  }
}

function showResult(stored: StoredCalibration, rms: number, saved: boolean): void {
  const fov = fovFromFocal(stored.sourceWidth, stored.fxOverWidth * stored.sourceWidth);
  const rows: [string, string][] = [
    ['RMS reprojection error', `${rms.toFixed(3)} px`],
    ['Views used', String(stored.samples)],
    ['Frame size', `${stored.sourceWidth} x ${stored.sourceHeight}`],
    ['fx / fy (px)', `${(stored.fxOverWidth * stored.sourceWidth).toFixed(1)} / ${(stored.fyOverHeight * stored.sourceHeight).toFixed(1)}`],
    ['Principal point', `${(stored.cxOverWidth * 100).toFixed(1)}% , ${(stored.cyOverHeight * 100).toFixed(1)}%`],
    ['Horizontal FOV', `${fov.toFixed(1)}° (default assumption: ${config.camera.fallbackHorizontalFovDeg}°)`],
    ['k1, k2, p1, p2', stored.distortion.slice(0, 4).map((v) => v.toFixed(4)).join(', ')],
    ['Stored', saved ? 'yes, in this browser' : 'no (localStorage unavailable)'],
  ];
  const body = ui.result.querySelector('tbody');
  if (body) {
    body.innerHTML = rows
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
      .join('');
  }
  ui.result.hidden = false;

  const quality =
    rms < 0.6 ? 'Good.' : rms < 1.2 ? 'Usable.' : 'Poor — recapture with more varied angles.';
  setStatus(`Calibration done. ${quality} The AR view will use it on next start.`);
}

ui.btnClear.addEventListener('click', () => {
  clearCalibration();
  ui.result.hidden = true;
  setStatus('Stored calibration cleared; the app is back to the estimated field of view.');
});

window.addEventListener('pagehide', () => {
  stream?.getTracks().forEach((t) => t.stop());
  detector?.delete();
  (board as CharucoBoardLike | null)?.delete();
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

renderShots();
