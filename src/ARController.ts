/**
 * Orchestrates camera -> detection -> pose -> render.
 *
 * The important structural decision is that the render loop and the detection
 * loop are independent. requestAnimationFrame drives rendering at display rate
 * and advances the filters every frame; detection runs on the worker at whatever
 * rate it sustains and only pushes new measurements in. So a device that detects
 * at 18 Hz still renders at 60 Hz with smooth motion, and a slow detect never
 * costs a dropped frame.
 *
 * Resolution adapts: if detection consistently overruns its budget the
 * processing width steps down, and back up when there is headroom. Touching the
 * width slider in the debug panel hands control to the user and stops the
 * automatic adjustment, because otherwise a measurement would fight the setting.
 */

import { CameraError, CameraStream, describeCameraError } from './camera/CameraStream';
import { FrameSource, type Frame } from './camera/FrameSource';
import { DetectorClient, type DetectorResult } from './detect/DetectorClient';
import type { Intrinsics } from './detect/protocol';
import { PoseTracker, type Measurement, type TrackedMarker } from './pose/PoseTracker';
import { intrinsicsForFrame, loadCalibration, type StoredCalibration } from './pose/intrinsics';
import { quatAngleDeg } from './pose/poseMath';
import { Renderer } from './render/Renderer';
import { loadModel, type LoadedModel } from './render/ModelLoader';
import { Overlay, type OverlayMarker } from './ui/Overlay';
import { DebugPanel, type DebugMetrics, type TuningValues } from './ui/DebugPanel';
import { captureComposite, deliverScreenshot, screenshotFilename } from './ui/Screenshot';
import { config, getMarkerSizeMeters, markerConfig, setMarkerSizeMeters } from './config';

export interface ARElements {
  root: HTMLElement;
  video: HTMLVideoElement;
  gl: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  debug: HTMLElement;
  lockPill: HTMLElement;
  loading: HTMLElement;
  loadingFill: HTMLElement;
  loadingText: HTMLElement;
  torchButton: HTMLButtonElement;
  swapButton: HTMLButtonElement;
  shotButton: HTMLButtonElement;
  debugButton: HTMLButtonElement;
}

export interface ARControllerCallbacks {
  onFatalError: (title: string, body: string) => void;
  onStatus?: (message: string) => void;
}

const WIDTH_STEP = 80;
const JITTER_WINDOW = 40;

export class ARController {
  private readonly camera: CameraStream;
  private readonly tracker: PoseTracker;
  private renderer: Renderer | null = null;
  private readonly overlay: Overlay;
  private debugPanel: DebugPanel | null = null;
  private detector: DetectorClient | null = null;
  private frameSource: FrameSource | null = null;

  private running = false;
  private rafHandle = 0;
  private lastFrameMs = 0;

  private calibration: StoredCalibration | null = null;
  private markerSizeMeters = getMarkerSizeMeters();
  private processingWidth = config.detection.processingWidth;
  private autoResolution = true;

  /** Latest worker result, kept for the debug panel. */
  private lastResult: DetectorResult | null = null;
  private overlayMarkers: OverlayMarker[] = [];
  private lightEstimation = config.render.lightEstimation;

  private readonly models = new Map<number, LoadedModel>();
  private readonly modelLoads = new Map<number, Promise<void>>();

  // Metrics
  private fps = 0;
  private renderMs = 0;
  private detectionTimes: number[] = [];
  private detectionStamps: number[] = [];
  private jitterPositions: [number, number, number][] = [];
  private jitterQuats: [number, number, number, number][] = [];
  private pendingScreenshot = false;

  private resizeObserver: ResizeObserver | null = null;
  private readonly boundOrientation = () => this.handleResize();
  private readonly boundVisibility = () => this.handleVisibility();

  constructor(
    private readonly el: ARElements,
    private readonly cb: ARControllerCallbacks,
  ) {
    this.camera = new CameraStream(el.video);
    this.overlay = new Overlay(el.overlay);
    this.tracker = new PoseTracker({
      positionMinCutoff: config.filter.positionMinCutoff,
      positionBeta: config.filter.positionBeta,
      positionDerivateCutoff: config.filter.positionDerivateCutoff,
      rotationSlerp: config.filter.rotationSlerp,
      holdMs: config.filter.holdMs,
      fadeOutMs: config.filter.fadeOutMs,
      fadeInMs: config.filter.fadeInMs,
      maxReprojError: 8,
      maxAngularJumpDeg: 60,
    });
  }

  /** Must be called from a user gesture: iOS will not start video otherwise. */
  async start(): Promise<void> {
    if (this.running) return;
    this.calibration = loadCalibration();
    this.markerSizeMeters = getMarkerSizeMeters();

    try {
      await this.camera.start({
        idealWidth: config.camera.idealWidth,
        idealHeight: config.camera.idealHeight,
      });
    } catch (err) {
      const kind = err instanceof CameraError ? err.kind : 'unknown';
      const { title, body } = describeCameraError(kind);
      this.cb.onFatalError(title, body);
      throw err;
    }

    this.el.torchButton.hidden = !this.camera.canTorch;
    this.el.swapButton.hidden = !this.camera.canSwitch;

    this.renderer = new Renderer(this.el.gl, {
      maxPixelRatio: config.render.maxPixelRatio,
      exposure: config.render.exposure,
      shadowCatcher: config.render.shadowCatcher,
      shadowOpacity: config.render.shadowOpacity,
      markerSizeMeters: this.markerSizeMeters,
    });

    this.setupDebugPanel();
    this.handleResize();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.el.root);
    window.addEventListener('orientationchange', this.boundOrientation);
    document.addEventListener('visibilitychange', this.boundVisibility);

    // Environment map is a nicety, not a blocker; start it and carry on.
    void this.renderer.initEnvironment().catch(() => {
      this.cb.onStatus?.('Environment map unavailable; lighting will be flatter.');
    });

    this.running = true;
    this.loop(performance.now());

    await this.startDetector();
  }

  private async startDetector(): Promise<void> {
    this.showLoading('Loading detector…', 0);

    const detector = new DetectorClient({
      opencvUrl: new URL('vendor/opencv.js', document.baseURI).href,
      params: {
        subPixelRefinement: config.detection.subPixelRefinement,
        aruco3: config.detection.aruco3,
        roiTracking: config.detection.roiTracking,
        roiMarginFraction: config.detection.roiMarginFraction,
        fullScanInterval: config.detection.fullScanInterval,
      },
      onResult: (r) => this.onDetectorResult(r),
      onProgress: (loaded, total) => {
        const pct = total > 0 ? loaded / total : 0;
        const mb = (loaded / 1_048_576).toFixed(1);
        this.showLoading(
          total > 0 ? `Loading detector ${mb} MB` : `Loading detector ${mb} MB`,
          pct,
        );
      },
      onError: (message, fatal) => {
        if (fatal) {
          this.cb.onFatalError(
            'Detector failed to load',
            `${message}. Check that vendor/opencv.js is deployed, then reload.`,
          );
        }
      },
    });
    this.detector = detector;

    const caps = await detector.whenCapabilitiesKnown();

    this.frameSource = new FrameSource(this.el.video, {
      processingWidth: this.processingWidth,
      consumerAcceptsBitmap: caps.acceptsBitmap,
      shouldCapture: () => detector.canAccept(),
      onFrame: (frame) => this.onFrame(frame),
    });

    try {
      await detector.init();
    } catch {
      // onError has already surfaced this.
      return;
    }

    this.hideLoading();
    this.frameSource.start();
  }

  private onFrame(frame: Frame): void {
    const detector = this.detector;
    if (!detector) {
      frame.bitmap?.close();
      return;
    }
    const intrinsics = this.intrinsicsFor(frame.width, frame.height);
    detector.submit(frame, intrinsics, this.markerSizeMeters);
  }

  private intrinsicsFor(processingWidth: number, processingHeight: number): Intrinsics {
    const { width: sw, height: sh } = this.camera.size;
    return intrinsicsForFrame({
      sourceWidth: sw || processingWidth,
      sourceHeight: sh || processingHeight,
      processingWidth,
      processingHeight,
      fallbackHorizontalFovDeg: config.camera.fallbackHorizontalFovDeg,
      calibration: this.calibration,
    });
  }

  private onDetectorResult(result: DetectorResult): void {
    this.lastResult = result;
    this.frameSource?.release();

    const measurements: Measurement[] = result.markers.map((m) => ({
      id: m.id,
      rvec: m.rvec,
      tvec: m.tvec,
      reprojError: m.reprojError,
    }));
    this.tracker.ingest(measurements, performance.now());

    this.overlayMarkers = result.markers.map((m) => ({
      id: m.id,
      corners: m.corners,
      fromRoi: m.fromRoi,
      reprojError: m.reprojError,
    }));

    // Jitter: raw (unfiltered) measurements only, and only for one marker, so
    // the number means "how much does a still marker wobble" rather than an
    // average over unrelated tracks.
    const first = result.markers[0];
    if (first) {
      const pose = this.tracker.visible.find((v) => v.id === first.id);
      if (pose) {
        this.jitterPositions.push([...pose.rawPosition] as [number, number, number]);
        this.jitterQuats.push([...pose.rawQuaternion] as [number, number, number, number]);
        if (this.jitterPositions.length > JITTER_WINDOW) this.jitterPositions.shift();
        if (this.jitterQuats.length > JITTER_WINDOW) this.jitterQuats.shift();
      }
    } else {
      this.jitterPositions.length = 0;
      this.jitterQuats.length = 0;
    }

    for (const id of result.markers.map((m) => m.id)) {
      void this.ensureModel(id);
    }

    // Resolution control
    const now = performance.now();
    this.detectionTimes.push(result.detectMs);
    this.detectionStamps.push(now);
    while (this.detectionStamps.length > 0 && now - (this.detectionStamps[0] as number) > 2000) {
      this.detectionStamps.shift();
    }
    if (this.detectionTimes.length > 24) this.detectionTimes.shift();
    if (this.autoResolution && this.detectionTimes.length >= 20) this.adaptResolution();

    if (this.lightEstimation && this.renderer) {
      this.renderer.setLightEstimate(result.meanLuma);
    }
  }

  /** Steps the processing width to keep detection inside its time budget. */
  private adaptResolution(): void {
    const sorted = [...this.detectionTimes].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)] as number;
    const target = config.detection.targetDetectMs;

    let next = this.processingWidth;
    if (p75 > target * 1.15 && this.processingWidth > config.detection.minProcessingWidth) {
      next = Math.max(config.detection.minProcessingWidth, this.processingWidth - WIDTH_STEP);
    } else if (p75 < target * 0.55 && this.processingWidth < config.detection.maxProcessingWidth) {
      next = Math.min(config.detection.maxProcessingWidth, this.processingWidth + WIDTH_STEP);
    }

    if (next !== this.processingWidth) {
      this.processingWidth = next;
      this.frameSource?.setProcessingWidth(next);
      this.detectionTimes.length = 0;
    }
  }

  private async ensureModel(id: number): Promise<void> {
    if (this.models.has(id) || this.modelLoads.has(id)) return;
    const cfg = markerConfig(id);
    if (!cfg) return;
    const renderer = this.renderer;
    if (!renderer) return;

    const task = (async () => {
      try {
        const model = await loadModel(renderer.webgl, cfg, this.markerSizeMeters);
        this.models.set(id, model);
        renderer.scene.add(model.group);
      } catch (err) {
        this.cb.onStatus?.(`Could not load the model for marker ${id}.`);
        console.error('model load failed', err);
      } finally {
        this.modelLoads.delete(id);
      }
    })();

    this.modelLoads.set(id, task);
    return task;
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);

    const dtMs = this.lastFrameMs === 0 ? 16.7 : Math.min(250, now - this.lastFrameMs);
    this.lastFrameMs = now;
    this.fps = this.fps === 0 ? 1000 / dtMs : this.fps * 0.9 + (1000 / dtMs) * 0.1;

    const renderStart = performance.now();
    const renderer = this.renderer;
    if (!renderer) return;

    this.tracker.update(now, dtMs);
    const visible = this.tracker.visible;

    let shadowSet = false;
    for (const marker of visible) {
      const model = this.models.get(marker.id);
      if (!model) continue;

      model.group.visible = marker.opacity > 0.002;
      renderer.applyPose(model.group, marker.position, marker.quaternion);
      setOpacity(model, marker.opacity);
      model.mixer?.update(dtMs / 1000);

      if (!shadowSet) {
        renderer.alignShadowTo(marker.position, marker.quaternion);
        shadowSet = true;
      }
    }
    if (!shadowSet) renderer.hideShadow();

    // Hide models whose track has gone entirely.
    const liveIds = new Set(visible.map((m) => m.id));
    for (const [id, model] of this.models) {
      if (!liveIds.has(id)) model.group.visible = false;
    }

    renderer.render();
    this.renderMs = performance.now() - renderStart;

    // Must happen in the same task as the render: preserveDrawingBuffer is off.
    if (this.pendingScreenshot) {
      this.pendingScreenshot = false;
      void this.finishScreenshot();
    }

    this.drawOverlay();
    this.updateLockPill(visible.length > 0, this.tracker.hasLock);

    if (this.debugPanel?.isVisible) {
      const metrics = this.collectMetrics(visible);
      this.debugPanel.update(metrics);
      // Published only while the debug overlay is open, so the same numbers can
      // be read from the console or by an automated test without scraping
      // formatted text out of the DOM.
      window.markerArDebug = metrics;
    }
  };

  private drawOverlay(): void {
    if (!this.debugPanel?.isVisible || !this.lastResult) {
      this.overlay.clear();
      return;
    }
    const rect = this.el.root.getBoundingClientRect();
    this.overlay.draw(this.overlayMarkers, {
      frameWidth: this.lastResult.width,
      frameHeight: this.lastResult.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
    });
  }

  private updateLockPill(anyVisible: boolean, hasLock: boolean): void {
    const state = hasLock ? 'locked' : anyVisible ? 'lost' : 'searching';
    if (this.el.lockPill.dataset.state === state) return;
    this.el.lockPill.dataset.state = state;
    this.el.lockPill.textContent =
      state === 'locked' ? 'Tracking' : state === 'lost' ? 'Marker lost' : 'Searching…';
  }

  private collectMetrics(visible: readonly TrackedMarker[]): DebugMetrics {
    const r = this.lastResult;
    const { width: sw, height: sh } = this.camera.size;
    const procH = r?.height ?? 0;
    const intr = this.intrinsicsFor(this.processingWidth, procH || 1);
    const fsStats = this.frameSource?.stats ?? { captured: 0, dropped: 0 };
    const draw = this.renderer?.drawInfo ?? { calls: 0, triangles: 0, programs: 0 };

    return {
      fps: this.fps,
      renderMs: this.renderMs,
      detectMs: r?.detectMs ?? 0,
      poseMs: r?.poseMs ?? 0,
      workerMs: r?.totalMs ?? 0,
      latencyMs: r?.latencyMs ?? 0,
      detectionsPerSecond: this.detectionStamps.length / 2,
      processingWidth: r?.width ?? this.processingWidth,
      processingHeight: procH,
      sourceWidth: sw,
      sourceHeight: sh,
      frameStrategy: this.frameSource?.strategy ?? 'pending',
      frameTiming: this.frameSource?.frameTiming ?? '-',
      capturedFrames: fsStats.captured,
      droppedFrames: fsStats.dropped,
      pixelRatio: this.renderer?.pixelRatio ?? 1,
      drawCalls: draw.calls,
      triangles: draw.triangles,
      meanLuma: r?.meanLuma ?? 0,
      calibrated: this.calibration !== null,
      fx: intr.fx,
      fy: intr.fy,
      markerSizeMeters: this.markerSizeMeters,
      posJitterMm: this.positionJitterMm(),
      rotJitterDeg: this.rotationJitterDeg(),
      markers: visible.map((m) => ({
        id: m.id,
        phase: m.phase,
        opacity: m.opacity,
        reprojError: m.reprojError,
        rejected: m.rejected,
        position: m.position,
        distanceMm: Math.hypot(m.position[0], m.position[1], m.position[2]) * 1000,
      })),
    };
  }

  /** RMS deviation of raw position from the window mean, in millimetres. */
  private positionJitterMm(): number {
    const n = this.jitterPositions.length;
    if (n < 4) return 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const p of this.jitterPositions) {
      mx += p[0];
      my += p[1];
      mz += p[2];
    }
    mx /= n;
    my /= n;
    mz /= n;

    let sum = 0;
    for (const p of this.jitterPositions) {
      sum += (p[0] - mx) ** 2 + (p[1] - my) ** 2 + (p[2] - mz) ** 2;
    }
    return Math.sqrt(sum / n) * 1000;
  }

  /** Mean angle between consecutive raw orientations, in degrees. */
  private rotationJitterDeg(): number {
    const n = this.jitterQuats.length;
    if (n < 4) return 0;
    let sum = 0;
    for (let i = 1; i < n; i++) {
      sum += quatAngleDeg(this.jitterQuats[i - 1] as never, this.jitterQuats[i] as never);
    }
    return sum / (n - 1);
  }

  // -------------------------------------------------------------------------
  // UI actions
  // -------------------------------------------------------------------------

  toggleDebug(): boolean {
    const visible = this.debugPanel?.toggle() ?? false;
    this.el.debugButton.setAttribute('aria-pressed', String(visible));
    if (!visible) this.overlay.clear();
    return visible;
  }

  async toggleTorch(): Promise<void> {
    const state = await this.camera.toggleTorch();
    if (state === null) {
      this.cb.onStatus?.('This camera does not support the torch.');
      return;
    }
    this.el.torchButton.setAttribute('aria-pressed', String(state));
  }

  async switchCamera(): Promise<void> {
    try {
      await this.camera.switchCamera({
        idealWidth: config.camera.idealWidth,
        idealHeight: config.camera.idealHeight,
      });
      this.tracker.reset();
      this.el.torchButton.hidden = !this.camera.canTorch;
      this.handleResize();
    } catch (err) {
      const kind = err instanceof CameraError ? err.kind : 'unknown';
      this.cb.onStatus?.(describeCameraError(kind).body);
    }
  }

  requestScreenshot(): void {
    this.pendingScreenshot = true;
  }

  private async finishScreenshot(): Promise<void> {
    const rect = this.el.root.getBoundingClientRect();
    const blob = await captureComposite({
      video: this.el.video,
      gl: this.el.gl,
      overlay: this.debugPanel?.isVisible ? this.el.overlay : null,
      cssWidth: rect.width,
      cssHeight: rect.height,
    });
    if (!blob) {
      this.cb.onStatus?.('Screenshot failed.');
      return;
    }
    const how = await deliverScreenshot(blob, screenshotFilename());
    this.cb.onStatus?.(how === 'shared' ? 'Screenshot shared.' : 'Screenshot saved.');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private setupDebugPanel(): void {
    const initial: TuningValues = {
      positionMinCutoff: config.filter.positionMinCutoff,
      positionBeta: config.filter.positionBeta,
      rotationSlerp: config.filter.rotationSlerp,
      holdMs: config.filter.holdMs,
      processingWidth: this.processingWidth,
      subPixelRefinement: config.detection.subPixelRefinement,
      roiTracking: config.detection.roiTracking,
      aruco3: config.detection.aruco3,
      shadowCatcher: config.render.shadowCatcher,
      lightEstimation: config.render.lightEstimation,
      exposure: config.render.exposure,
      markerSizeMeters: this.markerSizeMeters,
    };

    this.debugPanel = new DebugPanel(this.el.debug, {
      initial,
      onChange: (values) => this.applyTuning(values),
    });
    this.debugPanel.setVisible(false);
  }

  private applyTuning(values: Partial<TuningValues>): void {
    if (
      values.positionMinCutoff !== undefined ||
      values.positionBeta !== undefined ||
      values.rotationSlerp !== undefined ||
      values.holdMs !== undefined
    ) {
      this.tracker.configure({
        ...(values.positionMinCutoff !== undefined
          ? { positionMinCutoff: values.positionMinCutoff }
          : {}),
        ...(values.positionBeta !== undefined ? { positionBeta: values.positionBeta } : {}),
        ...(values.rotationSlerp !== undefined ? { rotationSlerp: values.rotationSlerp } : {}),
        ...(values.holdMs !== undefined ? { holdMs: values.holdMs } : {}),
      });
    }

    if (values.processingWidth !== undefined) {
      // Explicit choice wins; stop second-guessing it.
      this.autoResolution = false;
      this.processingWidth = values.processingWidth;
      this.frameSource?.setProcessingWidth(values.processingWidth);
    }

    if (
      values.subPixelRefinement !== undefined ||
      values.roiTracking !== undefined ||
      values.aruco3 !== undefined
    ) {
      this.detector?.setParams({
        ...(values.subPixelRefinement !== undefined
          ? { subPixelRefinement: values.subPixelRefinement }
          : {}),
        ...(values.roiTracking !== undefined ? { roiTracking: values.roiTracking } : {}),
        ...(values.aruco3 !== undefined ? { aruco3: values.aruco3 } : {}),
      });
    }

    if (values.lightEstimation !== undefined) {
      this.lightEstimation = values.lightEstimation;
      if (!values.lightEstimation) this.renderer?.setLightEstimate(128);
    }

    if (values.exposure !== undefined || values.shadowCatcher !== undefined) {
      this.renderer?.configure({
        ...(values.exposure !== undefined ? { exposure: values.exposure } : {}),
        ...(values.shadowCatcher !== undefined ? { shadowCatcher: values.shadowCatcher } : {}),
      });
    }

    if (values.markerSizeMeters !== undefined) {
      this.markerSizeMeters = values.markerSizeMeters;
      setMarkerSizeMeters(values.markerSizeMeters);
      this.renderer?.configure({ markerSizeMeters: values.markerSizeMeters });
      // Model scale is derived from the marker size, so reload on change.
      this.reloadModels();
    }
  }

  private reloadModels(): void {
    for (const [id, model] of this.models) {
      this.renderer?.scene.remove(model.group);
      model.dispose();
      this.models.delete(id);
    }
    for (const id of this.tracker.trackedIds) void this.ensureModel(id);
  }

  private handleResize(): void {
    const rect = this.el.root.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);

    this.overlay.setSize(cssWidth, cssHeight, config.render.maxPixelRatio);

    const { width: sw, height: sh } = this.camera.size;
    if (this.renderer && sw > 0 && sh > 0) {
      // Intrinsics at source scale: what the 3D camera frustum needs.
      const intr = intrinsicsForFrame({
        sourceWidth: sw,
        sourceHeight: sh,
        processingWidth: sw,
        processingHeight: sh,
        fallbackHorizontalFovDeg: config.camera.fallbackHorizontalFovDeg,
        calibration: this.calibration,
      });
      this.renderer.setCameraGeometry({
        sourceWidth: sw,
        sourceHeight: sh,
        fx: intr.fx,
        fy: intr.fy,
        cx: intr.cx,
        cy: intr.cy,
        cssWidth,
        cssHeight,
      });
    }
    this.renderer?.setSize(cssWidth, cssHeight);
  }

  private handleVisibility(): void {
    if (document.hidden) {
      this.frameSource?.stop();
    } else if (this.running && this.detector?.isReady) {
      this.frameSource?.start();
    }
  }

  private showLoading(text: string, fraction: number): void {
    this.el.loading.hidden = false;
    this.el.loadingText.textContent = text;
    this.el.loadingFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  private hideLoading(): void {
    this.el.loading.hidden = true;
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.lastFrameMs = 0;

    this.frameSource?.dispose();
    this.frameSource = null;
    this.detector?.dispose();
    this.detector = null;

    for (const [, model] of this.models) {
      this.renderer?.scene.remove(model.group);
      model.dispose();
    }
    this.models.clear();
    this.modelLoads.clear();

    this.tracker.reset();
    this.overlay.clear();
    this.renderer?.dispose();
    this.renderer = null;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('orientationchange', this.boundOrientation);
    document.removeEventListener('visibilitychange', this.boundVisibility);

    this.camera.stop();
  }
}

/**
 * Fades a model by writing material opacity. Materials are cloned per model by
 * the loader, so this never leaks across markers.
 */
function setOpacity(model: LoadedModel, opacity: number): void {
  if (opacity >= 0.999) {
    if (model.group.userData.faded !== false) {
      forEachMaterial(model, (m) => {
        m.transparent = Boolean(m.userData?.wasTransparent);
        m.opacity = 1;
      });
      model.group.userData.faded = false;
    }
    return;
  }
  forEachMaterial(model, (m) => {
    if (m.userData && m.userData.wasTransparent === undefined) {
      m.userData.wasTransparent = m.transparent;
    }
    m.transparent = true;
    m.opacity = opacity;
  });
  model.group.userData.faded = true;
}

interface FadeableMaterial {
  transparent: boolean;
  opacity: number;
  userData?: Record<string, unknown> & { wasTransparent?: boolean };
}

function forEachMaterial(model: LoadedModel, fn: (m: FadeableMaterial) => void): void {
  model.group.traverse((obj) => {
    const mesh = obj as unknown as { material?: FadeableMaterial | FadeableMaterial[] };
    const material = mesh.material;
    if (!material) return;
    if (Array.isArray(material)) material.forEach(fn);
    else fn(material);
  });
}
