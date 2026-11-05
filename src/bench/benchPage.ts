/**
 * In-browser benchmark.
 *
 * Measures through the real detector worker rather than calling OpenCV on the
 * main thread, because that is the path the app actually uses: it includes the
 * frame transfer, the greyscale conversion and the pose solve, not just
 * detectMarkers in isolation. A number measured any other way would flatter the
 * app.
 *
 * Also reports corner error against the synthetic ground truth, so a
 * configuration change that makes detection faster and less accurate cannot look
 * like a pure win.
 */

import { DetectorClient, type DetectorResult } from '../detect/DetectorClient';
import { meanCornerError, renderFrame } from './syntheticScene';
import { intrinsicsForFrame } from '../pose/intrinsics';
import { config, getMarkerSizeMeters, knownMarkerIds } from '../config';

const ui = {
  frames: byId<HTMLInputElement>('frames'),
  widths: byId<HTMLInputElement>('widths'),
  refine: byId<HTMLSelectElement>('refine'),
  run: byId<HTMLButtonElement>('btn-run'),
  copy: byId<HTMLButtonElement>('btn-copy'),
  status: byId<HTMLElement>('status'),
  results: byId<HTMLTableElement>('results'),
  fps: byId<HTMLButtonElement>('btn-fps'),
  fpsResult: byId<HTMLElement>('fps-result'),
  env: byId<HTMLElement>('env'),
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const MARKER_ID = knownMarkerIds[0] ?? 0;

interface Row {
  width: number;
  height: number;
  refine: boolean;
  p50: number;
  p95: number;
  max: number;
  perSecond: number;
  found: number;
  total: number;
  cornerErr: number;
}

const rows: Row[] = [];

let detector: DetectorClient | null = null;
let resolveResult: ((r: DetectorResult) => void) | null = null;

async function getDetector(): Promise<DetectorClient> {
  if (detector) return detector;
  ui.status.textContent = 'Loading detector (about 11 MB)…';

  const client = new DetectorClient({
    opencvUrl: new URL('vendor/opencv.js', document.baseURI).href,
    params: {
      subPixelRefinement: true,
      aruco3: false,
      // ROI tracking is off: it would make later frames cheaper than the first
      // and turn the measurement into a function of the clip rather than of the
      // detector. The app's ROI path is measured by the render-rate check.
      roiTracking: false,
      roiMarginFraction: config.detection.roiMarginFraction,
      fullScanInterval: 1,
    },
    onResult: (r) => {
      const fn = resolveResult;
      resolveResult = null;
      fn?.(r);
    },
    onProgress: (loaded, total) => {
      const pct = total > 0 ? ((loaded / total) * 100).toFixed(0) + '%' : '';
      ui.status.textContent = `Loading detector ${(loaded / 1_048_576).toFixed(1)} MB ${pct}`;
    },
    onError: (message, fatal) => {
      if (fatal) ui.status.textContent = `Detector failed: ${message}`;
    },
  });

  await client.whenCapabilitiesKnown();
  const ready = await client.init();
  ui.status.textContent = `Detector ready (${(ready.openCvBytes / 1_048_576).toFixed(
    1,
  )} MB in ${ready.loadMs.toFixed(0)} ms).`;
  detector = client;
  return client;
}

function detectOnce(
  client: DetectorClient,
  frame: { width: number; height: number; data: Uint8ClampedArray },
): Promise<DetectorResult> {
  return new Promise((resolve) => {
    resolveResult = resolve;
    const intrinsics = intrinsicsForFrame({
      sourceWidth: frame.width,
      sourceHeight: frame.height,
      processingWidth: frame.width,
      processingHeight: frame.height,
      fallbackHorizontalFovDeg: config.camera.fallbackHorizontalFovDeg,
      calibration: null,
    });
    client.submit(
      {
        pixels: frame.data,
        width: frame.width,
        height: frame.height,
        sourceWidth: frame.width,
        sourceHeight: frame.height,
        timestamp: performance.now(),
      },
      intrinsics,
      getMarkerSizeMeters(),
    );
  });
}

async function runBench(): Promise<void> {
  ui.run.disabled = true;
  ui.copy.disabled = true;
  rows.length = 0;
  renderTable();

  try {
    const client = await getDetector();
    const frameCount = clamp(Number.parseInt(ui.frames.value, 10) || 120, 20, 400);
    const widths = ui.widths.value
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 160 && n <= 1920);

    const refineModes: boolean[] =
      ui.refine.value === 'on' ? [true] : ui.refine.value === 'off' ? [false] : [true, false];

    for (const width of widths) {
      const height = Math.round((width * 3) / 4);

      // Frames are generated up front so generation time never lands inside a
      // measurement.
      ui.status.textContent = `Generating ${frameCount} frames at ${width}x${height}…`;
      await nextTick();
      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        frames.push(renderFrame({ width, height, markerId: MARKER_ID, seed: 7777 }, i));
      }

      for (const refine of refineModes) {
        client.setParams({ subPixelRefinement: refine });
        ui.status.textContent = `Measuring ${width}x${height}, refine ${refine ? 'on' : 'off'}…`;
        await nextTick();

        // Warm-up: the first few calls pay for WASM memory growth and JIT.
        for (let i = 0; i < 5; i++) await detectOnce(client, frames[i % frames.length]!);

        const times: number[] = [];
        let found = 0;
        let errSum = 0;
        let errCount = 0;
        const wallStart = performance.now();

        for (const frame of frames) {
          const result = await detectOnce(client, frame);
          times.push(result.detectMs);
          const marker = result.markers.find((m) => m.id === MARKER_ID);
          if (marker) {
            found++;
            errSum += meanCornerError(marker.corners, frame.truth.corners);
            errCount++;
          }
        }

        const wallMs = performance.now() - wallStart;
        times.sort((a, b) => a - b);
        rows.push({
          width,
          height,
          refine,
          p50: pct(times, 0.5),
          p95: pct(times, 0.95),
          max: times[times.length - 1] ?? 0,
          perSecond: (frames.length / wallMs) * 1000,
          found,
          total: frames.length,
          cornerErr: errCount > 0 ? errSum / errCount : NaN,
        });
        renderTable();
        await nextTick();
      }
    }

    ui.status.textContent = 'Done.';
    ui.copy.disabled = rows.length === 0;
  } catch (err) {
    ui.status.textContent = `Benchmark failed: ${String((err as Error).message ?? err)}`;
  } finally {
    ui.run.disabled = false;
  }
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx] as number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function nextTick(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function renderTable(): void {
  const body = ui.results.querySelector('tbody');
  if (!body) return;
  body.innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${r.width}x${r.height}</td><td>${r.refine ? 'on' : 'off'}</td>` +
        `<td>${r.p50.toFixed(2)}</td><td>${r.p95.toFixed(2)}</td><td>${r.max.toFixed(2)}</td>` +
        `<td>${r.perSecond.toFixed(1)}</td><td>${r.found}/${r.total}</td>` +
        `<td>${Number.isNaN(r.cornerErr) ? '—' : r.cornerErr.toFixed(3)}</td></tr>`,
    )
    .join('');
  ui.results.hidden = rows.length === 0;
}

ui.run.addEventListener('click', () => void runBench());

ui.copy.addEventListener('click', () => {
  const lines = [
    '| Processing size | Sub-pixel | p50 ms | p95 ms | max ms | det/s | found | corner err px |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.width}x${r.height} | ${r.refine ? 'on' : 'off'} | ${r.p50.toFixed(2)} | ` +
        `${r.p95.toFixed(2)} | ${r.max.toFixed(2)} | ${r.perSecond.toFixed(1)} | ` +
        `${r.found}/${r.total} | ${Number.isNaN(r.cornerErr) ? '-' : r.cornerErr.toFixed(3)} |`,
    ),
    '',
    `Device: ${navigator.userAgent}`,
  ];
  const text = lines.join('\n');
  void navigator.clipboard?.writeText(text).then(
    () => (ui.status.textContent = 'Copied as Markdown.'),
    () => (ui.status.textContent = text),
  );
});

// ---------------------------------------------------------------------------
// Render-rate check: detection and rendering competing, as in the real app.
// ---------------------------------------------------------------------------

ui.fps.addEventListener('click', () => void measureFps());

async function measureFps(): Promise<void> {
  ui.fps.disabled = true;
  ui.fpsResult.textContent = 'Measuring…';
  try {
    const client = await getDetector();
    client.setParams({ subPixelRefinement: true, roiTracking: true });

    const width = config.detection.processingWidth;
    const height = Math.round((width * 3) / 4);
    const frames = Array.from({ length: 60 }, (_, i) =>
      renderFrame({ width, height, markerId: MARKER_ID, seed: 991 }, i),
    );

    let detections = 0;
    let feeding = true;
    const feed = async () => {
      let i = 0;
      while (feeding) {
        if (client.canAccept()) {
          await detectOnce(client, frames[i++ % frames.length]!);
          detections++;
        } else {
          await nextTick();
        }
      }
    };
    void feed();

    // Busy-ish render loop stand-in: counts frames the browser actually serves.
    let frameCount = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        frameCount++;
        if (performance.now() - start >= 5000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    feeding = false;

    const seconds = (performance.now() - start) / 1000;
    ui.fpsResult.textContent =
      `${(frameCount / seconds).toFixed(1)} fps over ${seconds.toFixed(1)} s ` +
      `while detecting at ${(detections / seconds).toFixed(1)} detections/s ` +
      `(${width}x${height}).`;
  } catch (err) {
    ui.fpsResult.textContent = `Failed: ${String((err as Error).message ?? err)}`;
  } finally {
    ui.fps.disabled = false;
  }
}

// ---------------------------------------------------------------------------

const nav = navigator as Navigator & { deviceMemory?: number };
ui.env.innerHTML =
  `<h2>Environment</h2><table class="bench"><tbody>` +
  [
    ['User agent', navigator.userAgent],
    ['Logical cores', String(navigator.hardwareConcurrency ?? 'unknown')],
    ['Device memory (GB)', String(nav.deviceMemory ?? 'unknown')],
    ['devicePixelRatio', String(window.devicePixelRatio)],
    ['Screen', `${window.screen.width}x${window.screen.height}`],
    ['requestVideoFrameCallback', 'requestVideoFrameCallback' in HTMLVideoElement.prototype ? 'yes' : 'no'],
    ['OffscreenCanvas', typeof OffscreenCanvas === 'function' ? 'yes' : 'no'],
    ['Marker id benchmarked', String(MARKER_ID)],
  ]
    .map(
      ([k, v]) =>
        `<tr><td>${k}</td><td style="word-break:break-all">${String(v).replace(/[<>&]/g, '')}</td></tr>`,
    )
    .join('') +
  '</tbody></table>';
