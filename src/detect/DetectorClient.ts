/**
 * Main-thread side of the detector worker.
 *
 * Owns backpressure: exactly one frame is ever in flight. `canAccept()` is what
 * FrameSource consults before paying for a capture, so a slow device drops
 * frames instead of building a queue that would make the pose lag behind.
 */

import DetectWorker from './worker?worker';
import type { DetectParams, FromWorker, Intrinsics, MarkerResult, ToWorker } from './protocol';
import type { Frame } from '../camera/FrameSource';

export interface DetectorResult {
  frameId: number;
  timestamp: number;
  width: number;
  height: number;
  markers: MarkerResult[];
  detectMs: number;
  poseMs: number;
  totalMs: number;
  /** Mean frame luminance, 0..255, for the light estimate. */
  meanLuma: number;
  /** Wall time from frame capture to this result landing on the main thread. */
  latencyMs: number;
}

export interface DetectorClientOptions {
  opencvUrl: string;
  params: DetectParams;
  onResult: (result: DetectorResult) => void;
  onProgress?: (loaded: number, total: number) => void;
  onError?: (message: string, fatal: boolean) => void;
}

export class DetectorClient {
  private readonly worker: Worker;
  private nextFrameId = 1;
  private inFlight = false;
  private ready = false;
  private acceptsBitmapValue: boolean | null = null;
  private readonly capabilities: Promise<{ acceptsBitmap: boolean }>;
  private readonly readyPromise: Promise<{ openCvBytes: number; loadMs: number }>;
  private resolveCaps!: (v: { acceptsBitmap: boolean }) => void;
  private resolveReady!: (v: { openCvBytes: number; loadMs: number }) => void;
  private rejectReady!: (e: unknown) => void;

  constructor(private readonly opts: DetectorClientOptions) {
    this.capabilities = new Promise((resolve) => {
      this.resolveCaps = resolve;
    });
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.worker = new DetectWorker();
    this.worker.addEventListener('message', (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data));
    this.worker.addEventListener('error', (ev) => {
      const message = `worker error: ${ev.message}`;
      this.opts.onError?.(message, true);
      this.rejectReady(new Error(message));
    });
  }

  /** Resolves as soon as the worker reports what frame formats it can take. */
  async whenCapabilitiesKnown(): Promise<{ acceptsBitmap: boolean }> {
    return this.capabilities;
  }

  /** Starts loading opencv.js. Resolves when the detector can take frames. */
  async init(): Promise<{ openCvBytes: number; loadMs: number }> {
    this.send({ type: 'init', opencvUrl: this.opts.opencvUrl, params: this.opts.params });
    return this.readyPromise;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get acceptsBitmap(): boolean {
    return this.acceptsBitmapValue ?? false;
  }

  /** False while a frame is being processed, or before opencv.js has loaded. */
  canAccept(): boolean {
    return this.ready && !this.inFlight;
  }

  setParams(params: Partial<DetectParams>): void {
    this.send({ type: 'params', params });
  }

  /**
   * Hands a frame to the worker. Takes ownership of `frame.bitmap`, which is
   * transferred (and therefore unusable here afterwards).
   */
  submit(frame: Frame, intrinsics: Intrinsics, markerSizeMeters: number): boolean {
    if (!this.canAccept()) {
      frame.bitmap?.close();
      return false;
    }
    this.inFlight = true;
    const frameId = this.nextFrameId++;

    const base = {
      type: 'frame' as const,
      frameId,
      width: frame.width,
      height: frame.height,
      timestamp: frame.timestamp,
      intrinsics,
      markerSizeMeters,
    };

    if (frame.bitmap) {
      this.worker.postMessage({ ...base, bitmap: frame.bitmap }, [frame.bitmap]);
    } else if (frame.pixels) {
      // Copy, then transfer the copy: the source buffer belongs to a reused
      // canvas ImageData and must stay intact.
      const copy = new Uint8ClampedArray(frame.pixels);
      this.worker.postMessage({ ...base, pixels: copy }, [copy.buffer]);
    } else {
      this.inFlight = false;
      return false;
    }
    return true;
  }

  dispose(): void {
    this.send({ type: 'dispose' });
    this.worker.terminate();
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'capabilities':
        this.acceptsBitmapValue = msg.acceptsBitmap;
        this.resolveCaps({ acceptsBitmap: msg.acceptsBitmap });
        break;
      case 'progress':
        this.opts.onProgress?.(msg.loaded, msg.total);
        break;
      case 'ready':
        this.ready = true;
        this.resolveReady({ openCvBytes: msg.openCvBytes, loadMs: msg.loadMs });
        break;
      case 'result':
        this.inFlight = false;
        this.opts.onResult({
          frameId: msg.frameId,
          timestamp: msg.timestamp,
          width: msg.width,
          height: msg.height,
          markers: msg.markers,
          detectMs: msg.detectMs,
          poseMs: msg.poseMs,
          totalMs: msg.totalMs,
          meanLuma: msg.meanLuma,
          latencyMs: performance.now() - msg.timestamp,
        });
        break;
      case 'error':
        if (msg.fatal) {
          this.rejectReady(new Error(msg.message));
        } else {
          this.inFlight = false;
        }
        this.opts.onError?.(msg.message, msg.fatal);
        break;
    }
  }
}
