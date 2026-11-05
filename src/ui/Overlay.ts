/**
 * 2D debug overlay: detected marker quads, ids, and the pose axes.
 *
 * Drawn in display space. The mapping from detector space is the same
 * `object-fit: cover` crop the 3D camera uses, so a quad drawn here landing on
 * the printed marker is independent confirmation that the crop maths is right --
 * if the overlay sits on the marker but the model does not, the bug is in the
 * pose conversion, not in the camera geometry.
 */

export interface OverlayMarker {
  id: number;
  /** x0,y0,...,x3,y3 in detector-frame pixels. */
  corners: number[];
  fromRoi: boolean;
  reprojError: number;
}

export interface OverlayGeometry {
  /** Size of the frame the corners are expressed in. */
  frameWidth: number;
  frameHeight: number;
  /** CSS size of the display area. */
  cssWidth: number;
  cssHeight: number;
}

const ACCENT = '#5ad1a0';
const ROI = '#e8b04b';

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D | null;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  setSize(cssWidth: number, cssHeight: number, maxPixelRatio = 2): void {
    this.dpr = Math.min(maxPixelRatio, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(markers: readonly OverlayMarker[], geom: OverlayGeometry): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.clear();
    if (markers.length === 0) return;

    // Same cover-crop transform the 3D camera uses.
    const scale = Math.max(geom.cssWidth / geom.frameWidth, geom.cssHeight / geom.frameHeight);
    const offX = (geom.cssWidth - geom.frameWidth * scale) / 2;
    const offY = (geom.cssHeight - geom.frameHeight * scale) / 2;
    const toX = (x: number) => (offX + x * scale) * this.dpr;
    const toY = (y: number) => (offY + y * scale) * this.dpr;

    ctx.lineJoin = 'round';
    ctx.font = `${12 * this.dpr}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    for (const m of markers) {
      const colour = m.fromRoi ? ROI : ACCENT;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2 * this.dpr;

      ctx.beginPath();
      ctx.moveTo(toX(m.corners[0] as number), toY(m.corners[1] as number));
      for (let i = 2; i < 8; i += 2) {
        ctx.lineTo(toX(m.corners[i] as number), toY(m.corners[i + 1] as number));
      }
      ctx.closePath();
      ctx.stroke();

      // Mark the first corner so corner ordering is visible at a glance; a
      // rotated model is usually an ordering problem.
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(toX(m.corners[0] as number), toY(m.corners[1] as number), 4 * this.dpr, 0, Math.PI * 2);
      ctx.fill();

      let cx = 0;
      let cy = 0;
      for (let i = 0; i < 8; i += 2) {
        cx += m.corners[i] as number;
        cy += m.corners[i + 1] as number;
      }
      cx /= 4;
      cy /= 4;

      const label = `#${m.id}  ${m.reprojError.toFixed(2)}px`;
      const tx = toX(cx);
      const ty = toY(cy);
      const w = ctx.measureText(label).width + 10 * this.dpr;
      ctx.fillStyle = 'rgba(10, 13, 16, 0.72)';
      ctx.fillRect(tx - w / 2, ty - 10 * this.dpr, w, 20 * this.dpr);
      ctx.fillStyle = colour;
      ctx.fillText(label, tx, ty);
    }
  }
}
