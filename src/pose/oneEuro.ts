/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012).
 *
 * Chosen over a fixed low-pass or a Kalman filter because it has exactly the
 * knob this problem needs: a cutoff that rises with signal speed. A still marker
 * gets heavy smoothing (jitter disappears), a moving one gets light smoothing
 * (no rubber-banding). A fixed low-pass has to pick one or the other.
 *
 * Tuning, in the order to try:
 *   minCutoff down  -> less jitter when still, more lag when moving
 *   beta up         -> less lag when moving, more jitter during motion
 */

/** Exponential smoothing with an alpha derived from a cutoff frequency and dt. */
export class LowPassFilter {
  private prevRaw = 0;
  private prevFiltered = 0;
  private initialised = false;

  reset(): void {
    this.initialised = false;
    this.prevRaw = 0;
    this.prevFiltered = 0;
  }

  get hasValue(): boolean {
    return this.initialised;
  }

  get lastRaw(): number {
    return this.prevRaw;
  }

  filter(value: number, alpha: number): number {
    const out = this.initialised ? alpha * value + (1 - alpha) * this.prevFiltered : value;
    this.prevRaw = value;
    this.prevFiltered = out;
    this.initialised = true;
    return out;
  }
}

/** alpha for a first-order low-pass at `cutoff` Hz sampled with step `dt` seconds. */
export function smoothingAlpha(cutoff: number, dt: number): number {
  if (dt <= 0) return 1;
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-6));
  return 1 / (1 + tau / dt);
}

export interface OneEuroOptions {
  /** Cutoff at zero speed, Hz. Lower is smoother and laggier. */
  minCutoff: number;
  /** How fast the cutoff grows with speed. Higher follows motion more tightly. */
  beta: number;
  /** Cutoff for the speed estimate itself, Hz. */
  derivateCutoff: number;
}

export class OneEuroFilter {
  private readonly xFilter = new LowPassFilter();
  private readonly dxFilter = new LowPassFilter();
  private lastTime: number | null = null;

  constructor(private opts: OneEuroOptions) {}

  configure(opts: Partial<OneEuroOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
  }

  /**
   * @param value   sample
   * @param timeSec timestamp in seconds (monotonic)
   */
  filter(value: number, timeSec: number): number {
    if (this.lastTime === null) {
      this.lastTime = timeSec;
      this.dxFilter.filter(0, 1);
      return this.xFilter.filter(value, 1);
    }

    // Clamp dt: a tab that was backgrounded produces a huge gap, and a duplicate
    // frame timestamp produces zero. Both would otherwise blow up the derivative.
    const dt = Math.min(0.25, Math.max(1 / 240, timeSec - this.lastTime));
    this.lastTime = timeSec;

    const rawSpeed = this.xFilter.hasValue ? (value - this.xFilter.lastRaw) / dt : 0;
    const speed = this.dxFilter.filter(rawSpeed, smoothingAlpha(this.opts.derivateCutoff, dt));
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(speed);
    return this.xFilter.filter(value, smoothingAlpha(cutoff, dt));
  }
}

/** Three independent One Euro filters, one per axis. */
export class OneEuroVec3 {
  private readonly filters: [OneEuroFilter, OneEuroFilter, OneEuroFilter];

  constructor(opts: OneEuroOptions) {
    this.filters = [new OneEuroFilter(opts), new OneEuroFilter(opts), new OneEuroFilter(opts)];
  }

  configure(opts: Partial<OneEuroOptions>): void {
    for (const f of this.filters) f.configure(opts);
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }

  filter(v: readonly [number, number, number], timeSec: number): [number, number, number] {
    return [
      this.filters[0].filter(v[0], timeSec),
      this.filters[1].filter(v[1], timeSec),
      this.filters[2].filter(v[2], timeSec),
    ];
  }
}
