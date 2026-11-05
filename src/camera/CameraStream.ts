/**
 * Rear-camera capture. Deliberately conservative: constraints use `ideal` rather
 * than `exact` everywhere, because an over-specified constraint set is the most
 * common cause of OverconstrainedError on mid-range Android devices.
 */

export type CameraErrorKind =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-camera'
  | 'in-use'
  | 'overconstrained'
  | 'unknown';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
    readonly original?: unknown,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

const MESSAGES: Record<CameraErrorKind, { title: string; body: string }> = {
  'insecure-context': {
    title: 'Needs a secure connection',
    body: 'Cameras only work over HTTPS (or on localhost). Open this page via its https:// address and try again.',
  },
  unsupported: {
    title: 'Camera not supported',
    body: 'This browser does not expose camera capture. On iOS, use Safari; in-app browsers often block it.',
  },
  'permission-denied': {
    title: 'Camera permission denied',
    body: 'Allow camera access for this site, then reload. On iOS: Settings › Safari › Camera, or the aA menu in the address bar › Website Settings.',
  },
  'no-camera': {
    title: 'No camera found',
    body: 'This device reports no usable camera. If an external camera is attached, reconnect it and reload.',
  },
  'in-use': {
    title: 'Camera already in use',
    body: 'Another app or browser tab is holding the camera. Close it and try again.',
  },
  overconstrained: {
    title: 'Camera mode unavailable',
    body: 'The camera could not provide a usable video mode. Retrying with relaxed settings did not help.',
  },
  unknown: {
    title: 'Camera unavailable',
    body: 'Starting the camera failed for an unexpected reason. Reloading the page usually clears it.',
  },
};

export function describeCameraError(kind: CameraErrorKind): { title: string; body: string } {
  return MESSAGES[kind];
}

function classify(err: unknown): CameraErrorKind {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'overconstrained';
    default:
      return 'unknown';
  }
}

/**
 * Torch is a non-standard track capability, so lib.dom has no types for it.
 * Declared as a view over MediaStreamTrack rather than an extension of it,
 * because narrowing `getCapabilities` to optional is not a valid subtype.
 */
type TorchCapableTrack = MediaStreamTrack & {
  getCapabilities?: () => MediaTrackCapabilities & { torch?: boolean };
};

export interface CameraStartOptions {
  idealWidth: number;
  idealHeight: number;
  /** Pin a specific camera; omit to let facingMode choose the rear one. */
  deviceId?: string;
}

export class CameraStream {
  private stream: MediaStream | null = null;
  private track: TorchCapableTrack | null = null;
  private torchOn = false;
  private videoDevices: MediaDeviceInfo[] = [];
  private activeDeviceId: string | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  /**
   * Opens the camera and resolves once the video element reports real dimensions.
   * Must be called from a user gesture: iOS Safari rejects autoplay otherwise.
   */
  async start(opts: CameraStartOptions): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError('insecure-context', 'getUserMedia requires a secure context');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('unsupported', 'navigator.mediaDevices.getUserMedia is missing');
    }

    this.stop();

    // Progressively relaxed attempts. The first is what we actually want; the
    // later ones exist because some Android cameras reject resolution hints and
    // some report no environment-facing camera at all.
    const videoWanted: MediaTrackConstraints = opts.deviceId
      ? {
          deviceId: { exact: opts.deviceId },
          width: { ideal: opts.idealWidth },
          height: { ideal: opts.idealHeight },
        }
      : {
          facingMode: { ideal: 'environment' },
          width: { ideal: opts.idealWidth },
          height: { ideal: opts.idealHeight },
        };

    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: videoWanted },
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      { audio: false, video: true },
    ];

    let lastErr: unknown;
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
        const kind = classify(err);
        // Permission and hardware problems will not be fixed by relaxing constraints.
        if (kind === 'permission-denied' || kind === 'no-camera' || kind === 'in-use') {
          throw new CameraError(kind, 'getUserMedia failed: ' + String(err), err);
        }
      }
    }

    if (!this.stream) {
      throw new CameraError(classify(lastErr), 'getUserMedia failed: ' + String(lastErr), lastErr);
    }

    const tracks = this.stream.getVideoTracks();
    this.track = (tracks[0] as TorchCapableTrack | undefined) ?? null;
    this.activeDeviceId = this.track?.getSettings().deviceId ?? null;
    this.torchOn = false;

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;

    try {
      await this.video.play();
    } catch (err) {
      // Safari can reject play() if the gesture was already consumed. The stream
      // is still live and metadata usually arrives anyway, so only treat this as
      // fatal when the dimensions never show up.
      if (this.video.readyState < 2) {
        await this.waitForDimensions().catch(() => {
          throw new CameraError('unknown', 'video.play() rejected: ' + String(err), err);
        });
      }
    }

    await this.waitForDimensions();

    // Device labels are only populated once permission is granted, so enumerate here.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter((d) => d.kind === 'videoinput');
    } catch {
      this.videoDevices = [];
    }
  }

  /** Resolves when videoWidth/videoHeight are non-zero, rejects after a timeout. */
  private waitForDimensions(timeoutMs = 8000): Promise<void> {
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new CameraError('unknown', 'video dimensions never arrived'));
      }, timeoutMs);
      const onReady = () => {
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('resize', onReady);
        this.video.removeEventListener('canplay', onReady);
      };
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('resize', onReady);
      this.video.addEventListener('canplay', onReady);
      onReady();
    });
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    if (this.video.srcObject) this.video.srcObject = null;
  }

  get size(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  get settings(): MediaTrackSettings | null {
    return this.track?.getSettings() ?? null;
  }

  get canSwitch(): boolean {
    return this.videoDevices.length > 1;
  }

  get canTorch(): boolean {
    const caps = this.track?.getCapabilities?.() as
      | (MediaTrackCapabilities & { torch?: boolean })
      | undefined;
    return caps?.torch === true;
  }

  get isTorchOn(): boolean {
    return this.torchOn;
  }

  /** Cycles to the next video input. Returns false when there is only one. */
  async switchCamera(opts: CameraStartOptions): Promise<boolean> {
    if (!this.canSwitch) return false;
    const ids = this.videoDevices.map((d) => d.deviceId);
    const idx = this.activeDeviceId ? ids.indexOf(this.activeDeviceId) : -1;
    const next = ids[(idx + 1) % ids.length];
    if (!next) return false;
    await this.start({ ...opts, deviceId: next });
    return true;
  }

  /** Returns the new torch state, or null when the track does not support it. */
  async toggleTorch(): Promise<boolean | null> {
    if (!this.track || !this.canTorch) return null;
    const next = !this.torchOn;
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      } as MediaTrackConstraints);
      this.torchOn = next;
      return next;
    } catch {
      return null;
    }
  }
}
