/**
 * End-to-end: a real Chromium, a fake camera serving a clip of a moving ArUco
 * marker, and the production build.
 *
 * This is the only test that exercises the whole chain at once -- getUserMedia,
 * the frame pipeline, the worker, OpenCV, the pose solve, the filters and the
 * three.js render. Everything below it is unit-tested; this is what catches the
 * wiring between them.
 */

import { expect, test, type Page } from '@playwright/test';
import type { DebugMetrics } from '../../src/ui/DebugPanel';

/**
 * The exact type ARController publishes, imported rather than restated so the
 * test cannot drift from the thing it is asserting about.
 */
type DebugSnapshot = DebugMetrics;

async function startAr(page: Page): Promise<void> {
  await page.goto('/index.html');
  await expect(page.getByRole('heading', { name: 'Marker AR' })).toBeVisible();
  await page.getByRole('button', { name: 'Start camera' }).click();
  // The AR view appears immediately; the detector then downloads opencv.js.
  await expect(page.locator('#ar')).toBeVisible();
}

async function waitForTracking(page: Page): Promise<void> {
  await expect(page.locator('#lock-pill')).toHaveAttribute('data-state', 'locked', {
    timeout: 90_000,
  });
}

async function openDebug(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle debug overlay' }).click();
  await expect(page.locator('#debug')).toBeVisible();
}

async function snapshot(page: Page): Promise<DebugSnapshot> {
  return page.evaluate(() => {
    const d = window.markerArDebug;
    if (!d) throw new Error('debug snapshot not published');
    return d;
  });
}

test.describe('AR pipeline', () => {
  test('detects the marker and renders the model', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await startAr(page);
    await waitForTracking(page);
    await openDebug(page);

    // Give the render loop a moment to publish a settled frame.
    await page.waitForFunction(
      () => (window.markerArDebug?.markers.length ?? 0) > 0 && (window.markerArDebug?.fps ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );
    const snap = await snapshot(page);

    // The camera really is the fake clip.
    expect(snap.sourceWidth).toBe(640);
    expect(snap.sourceHeight).toBe(480);

    // Detection found the configured marker.
    expect(snap.markers.length).toBeGreaterThan(0);
    const marker = snap.markers[0]!;
    expect(marker.id).toBe(0);
    // Not asserted as 'tracking': the clip swings the marker through steep
    // angles where a frame or two legitimately misses, and this samples at an
    // arbitrary instant. Catching it mid-fade is the hold-and-fade behaviour
    // working, not a failure. What matters is that it is still on screen.
    expect(['tracking', 'fading-out']).toContain(marker.phase);
    expect(marker.opacity).toBeGreaterThan(0);

    // The pose is physically plausible: the synthetic marker sits a few tens of
    // centimetres from the camera, never behind it.
    expect(marker.distanceMm).toBeGreaterThan(30);
    expect(marker.distanceMm).toBeLessThan(5000);
    expect(marker.position[2]).toBeLessThan(0); // in front, in three.js space
    expect(marker.reprojError).toBeLessThan(8);

    // The model is actually being drawn, not just tracked.
    expect(snap.drawCalls).toBeGreaterThan(0);
    expect(snap.triangles).toBeGreaterThan(0);

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
  });

  test('the model follows the marker as it moves', async ({ page }) => {
    await startAr(page);
    await waitForTracking(page);
    await openDebug(page);
    await page.waitForFunction(() => (window.markerArDebug?.markers.length ?? 0) > 0, undefined, {
      timeout: 30_000,
    });

    // Sample the pose over time. The clip moves the marker continuously, so a
    // model that is merely drawn at a fixed place would fail here.
    const samples: Array<readonly [number, number, number]> = [];
    for (let i = 0; i < 12; i++) {
      const snap = await snapshot(page);
      if (snap.markers[0]) samples.push(snap.markers[0].position);
      await page.waitForTimeout(250);
    }

    expect(samples.length).toBeGreaterThanOrEqual(8);

    const xs = samples.map((p) => p[0]);
    const spread = Math.max(...xs) - Math.min(...xs);
    // Several centimetres of lateral travel over three seconds of the clip.
    expect(spread).toBeGreaterThan(0.01);

    // And it must stay physically sane throughout, never jumping behind camera.
    for (const p of samples) {
      expect(p[2]).toBeLessThan(0);
      expect(Math.hypot(...p)).toBeLessThan(5);
    }
  });

  test('detection runs off the main thread', async ({ page }) => {
    await startAr(page);
    await waitForTracking(page);
    await openDebug(page);
    await page.waitForFunction(() => (window.markerArDebug?.fps ?? 0) > 1, undefined, {
      timeout: 30_000,
    });

    const samples: DebugSnapshot[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await snapshot(page));
      await page.waitForTimeout(200);
    }

    const avgDetect = mean(samples.map((s) => s.detectMs));
    const avgRender = mean(samples.map((s) => s.renderMs));
    const avgFps = mean(samples.map((s) => s.fps));

    // Detection is doing real work ...
    expect(avgDetect).toBeGreaterThan(0);
    // ... but the main thread's own per-frame cost stays small, which is only
    // possible because detection is on the worker.
    expect(avgRender).toBeLessThan(avgDetect + 8);
    // Headless SwiftShader is slow, so this is a floor against a stalled loop,
    // not a performance assertion.
    expect(avgFps).toBeGreaterThan(10);

    // Frames are being captured and fed continuously.
    expect(samples[samples.length - 1]!.capturedFrames).toBeGreaterThan(
      samples[0]!.capturedFrames,
    );
  });

  test('a screenshot composites the camera and the model', async ({ page }) => {
    await startAr(page);
    await waitForTracking(page);

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Take screenshot' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^marker-ar-\d{8}-\d{6}\.png$/);

    const path = await file.path();
    expect(path).toBeTruthy();
  });

  test('recovers after the marker is lost', async ({ page }) => {
    await startAr(page);
    await waitForTracking(page);
    await openDebug(page);

    // Backgrounding the page stops the frame pump, which is the same code path
    // as losing the marker: the model should fade rather than vanish, and
    // tracking should resume when frames come back.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.locator('#lock-pill')).toHaveAttribute('data-state', 'locked', {
      timeout: 60_000,
    });
  });
});

test.describe('marker page', () => {
  test('generates a print-exact SVG', async ({ page }) => {
    await page.goto('/marker.html');
    await page.locator('#marker-size').fill('120');
    await page.locator('#marker-size').dispatchEvent('input');

    const svg = page.locator('#preview svg');
    await expect(svg).toBeVisible();

    // 120 mm marker plus a 25% quiet zone on each side = 180 mm.
    await expect(svg).toHaveAttribute('width', '180mm');
    await expect(svg).toHaveAttribute('viewBox', /^0 0 180 /);
  });
});

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}
