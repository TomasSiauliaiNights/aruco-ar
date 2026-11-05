/**
 * Pulls downscaled frames off a <video> and hands them to a consumer.
 *
 * Three concerns are handled here, all of them platform quirks:
 *
 * 1. Frame timing. requestVideoFrameCallback ties work to real camera frames
 *    (iOS Safari 15.4+, all Android Chrome targets). Where it is missing we fall
 *    back to requestAnimationFrame, which decouples us from the camera clock and
 *    may process the same frame twice.
 * 2. Downscaling. createImageBitmap's resize options are the cheap path, but
 *    Safari support for them is poorly documented, so we probe at runtime instead
 *    of trusting a version check, with two fallbacks behind it.
 * 3. Backpressure. We never queue frames. If the consumer is busy, the frame is
 *    dropped, so pose latency stays bounded instead of growing under load.
 */

export type FrameStrategy = 'bitmap-resize' | 'offscreen-bitmap' | 'canvas-pixels';

/** A downscaled frame, in whichever form the active strategy produces. */
export interface Frame {
  /** Zero-copy transferable bitmap, when the strategy produces one. */
  bitmap?: ImageBitmap;
  /** RGBA pixels, when the strategy produces raw bytes instead. */
  pixels?: Uint8ClampedArray;
  /** Processing size (not the camera size). */
  width: number;
  height: number;
  /** Native camera frame size this was derived from. */
  sourceWidth: number;
  sourceHeight: number;
  /** performance.now() at capture. */
  timestamp: number;
}

export interface FrameSourceOptions {
  /** Target width handed to the detector; height follows the camera aspect. */
  processingWidth: number;
  /** Return false to drop this frame (consumer busy). */
  shouldCapture: () => boolean;
  /** Called with each captured frame. Ownership of `bitmap` passes to the callee. */
  onFrame: (frame: Frame) => void;
  /**
   * When false, the ImageBitmap strategies are skipped and raw pixels are sent,
   * because the consumer cannot rasterise a bitmap (no OffscreenCanvas in worker).
   */
  consumerAcceptsBitmap: boolean;
}

interface VideoFrameMetadataLike {
  mediaTime?: number;
  presentedFrames?: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMetadataLike) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class FrameSource {
  private running = false;
  private handle = 0;
  private usingRvfc = false;
  private strategyResolved: FrameStrategy | null = null;
  private probing = false;

  /** Reused across frames so steady state makes no allocations. */
  private offscreen: OffscreenCanvas | null = null;
  private offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;

  private processingWidth: number;
  private inFlight = false;
  private droppedFrames = 0;
  private capturedFrames = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly opts: FrameSourceOptions,
  ) {
    this.processingWidth = opts.processingWidth;
  }

  get strategy(): FrameStrategy | null {
    return this.strategyResolved;
  }

  get frameTiming(): 'rvfc' | 'raf' {
    return this.usingRvfc ? 'rvfc' : 'raf';
  }

  get stats(): { captured: number; dropped: number } {
    return { captured: this.capturedFrames, dropped: this.droppedFrames };
  }

  setProcessingWidth(width: number): void {
    this.processingWidth = Math.max(160, Math.round(width));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const v = this.video as RvfcVideo;
    this.usingRvfc = typeof v.requestVideoFrameCallback === 'function';
    this.schedule();
  }

  stop(): void {
    this.running = false;
    const v = this.video as RvfcVideo;
    if (this.handle) {
      if (this.usingRvfc) v.cancelVideoFrameCallback?.(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = 0;
    }
  }

  dispose(): void {
    this.stop();
    this.offscreen = null;
    this.offscreenCtx = null;
    this.fallbackCanvas = null;
    this.fallbackCtx = null;
  }

  /** Call when the consumer has finished with the previous frame. */
  release(): void {
    this.inFlight = false;
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as RvfcVideo;
    if (this.usingRvfc && v.requestVideoFrameCallback) {
      this.handle = v.requestVideoFrameCallback(() => void this.tick());
    } else {
      this.handle = requestAnimationFrame(() => void this.tick());
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const sw = this.video.videoWidth;
    const sh = this.video.videoHeight;

    // Orientation changes swap these; nothing to do but wait for valid numbers.
    if (sw > 0 && sh > 0 && !this.inFlight && !this.probing && this.opts.shouldCapture()) {
      this.inFlight = true;
      try {
        const frame = await this.capture(sw, sh);
        if (frame) {
          this.capturedFrames++;
          this.opts.onFrame(frame);
        } else {
          this.inFlight = false;
        }
      } catch {
        // A single failed capture (e.g. the element went to readyState 0 during a
        // rotation) must not kill the loop.
        this.inFlight = false;
      }
    } else if (this.inFlight) {
      this.droppedFrames++;
    }

    this.schedule();
  }

  private targetSize(sw: number, sh: number): { w: number; h: number } {
    const w = Math.min(this.processingWidth, sw);
    const h = Math.max(1, Math.round((w * sh) / sw));
    return { w, h };
  }

  private async capture(sw: number, sh: number): Promise<Frame | null> {
    const { w, h } = this.targetSize(sw, sh);

    if (this.strategyResolved === null) {
      this.probing = true;
      try {
        this.strategyResolved = await this.probeStrategy(w, h);
      } finally {
        this.probing = false;
      }
    }

    const base = {
      width: w,
      height: h,
      sourceWidth: sw,
      sourceHeight: sh,
      timestamp: performance.now(),
    };

    switch (this.strategyResolved) {
      case 'bitmap-resize': {
        const bitmap = await createImageBitmap(this.video, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'low',
        });
        return { ...base, bitmap };
      }
      case 'offscreen-bitmap': {
        const ctx = this.ensureOffscreen(w, h);
        if (!ctx) return null;
        ctx.drawImage(this.video, 0, 0, w, h);
        return { ...base, bitmap: (ctx.canvas as OffscreenCanvas).transferToImageBitmap() };
      }
      case 'canvas-pixels': {
        const ctx = this.ensureFallbackCanvas(w, h);
        if (!ctx) return null;
        ctx.drawImage(this.video, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        return { ...base, pixels: data.data };
      }
      default:
        return null;
    }
  }

  /**
   * Picks the cheapest strategy that actually works on this device, by trying it
   * rather than by sniffing versions.
   */
  private async probeStrategy(w: number, h: number): Promise<FrameStrategy> {
    const canBitmap = this.opts.consumerAcceptsBitmap;

    if (canBitmap && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(this.video, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'low',
        });
        const honoured = bmp.width === w && bmp.height === h;
        bmp.close();
        if (honoured) return 'bitmap-resize';
      } catch {
        // fall through
      }
    }

    if (canBitmap && typeof OffscreenCanvas === 'function') {
      try {
        const probe = new OffscreenCanvas(w, h);
        const ctx = probe.getContext('2d');
        if (ctx) {
          ctx.drawImage(this.video, 0, 0, w, h);
          probe.transferToImageBitmap().close();
          return 'offscreen-bitmap';
        }
      } catch {
        // fall through
      }
    }

    return 'canvas-pixels';
  }

  private ensureOffscreen(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
    if (!this.offscreen || this.offscreen.width !== w || this.offscreen.height !== h) {
      this.offscreen = new OffscreenCanvas(w, h);
      this.offscreenCtx = this.offscreen.getContext('2d', {
        willReadFrequently: false,
      }) as OffscreenCanvasRenderingContext2D | null;
    }
    return this.offscreenCtx;
  }

  private ensureFallbackCanvas(w: number, h: number): CanvasRenderingContext2D | null {
    if (!this.fallbackCanvas) {
      this.fallbackCanvas = document.createElement('canvas');
      this.fallbackCtx = this.fallbackCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this.fallbackCanvas.width !== w || this.fallbackCanvas.height !== h) {
      this.fallbackCanvas.width = w;
      this.fallbackCanvas.height = h;
    }
    return this.fallbackCtx;
  }
}
