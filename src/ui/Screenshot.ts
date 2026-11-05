/**
 * Composited screenshot: the camera frame with the rendered model over it.
 *
 * Drawing the video and the WebGL canvas into one 2D canvas is the only way to
 * get the composite -- the GL canvas alone is transparent where the camera shows
 * through. The video is drawn with the same cover crop the viewer sees, so the
 * saved image matches the screen rather than the raw sensor frame.
 */

export interface ScreenshotSources {
  video: HTMLVideoElement;
  gl: HTMLCanvasElement;
  /** Optional 2D overlay, included only when the debug view is on. */
  overlay?: HTMLCanvasElement | null;
  /** CSS size of the on-screen area, which sets the output aspect. */
  cssWidth: number;
  cssHeight: number;
  /** Output scale over CSS pixels. 2 gives a retina-sized image. */
  pixelRatio?: number;
}

/**
 * Note on ordering: this must be called immediately after a render, in the same
 * frame, because `preserveDrawingBuffer` is off (keeping it off is worth real
 * performance). Calling it later reads a cleared buffer.
 */
export async function captureComposite(src: ScreenshotSources): Promise<Blob | null> {
  const ratio = src.pixelRatio ?? Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(src.cssWidth * ratio));
  const h = Math.max(1, Math.round(src.cssHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // Camera frame, cover-cropped exactly as CSS object-fit: cover does it.
  const vw = src.video.videoWidth;
  const vh = src.video.videoHeight;
  if (vw > 0 && vh > 0) {
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(src.video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  ctx.drawImage(src.gl, 0, 0, w, h);
  if (src.overlay) ctx.drawImage(src.overlay, 0, 0, w, h);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/**
 * Hands the image to the user. Tries the share sheet first, because on iOS a
 * download of a blob URL from a standalone PWA often goes nowhere, while sharing
 * lets them save to Photos. Falls back to a download, then to opening the image.
 */
export async function deliverScreenshot(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'opened'> {
  const file = new File([blob], filename, { type: 'image/png' });

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (err) {
      // An AbortError means the user dismissed the sheet deliberately; do not
      // then force a download on them.
      if ((err as { name?: string }).name === 'AbortError') return 'shared';
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'downloaded';
  } catch {
    window.open(url, '_blank');
    return 'opened';
  } finally {
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function screenshotFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `marker-ar-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
