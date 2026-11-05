/**
 * Toggleable debug overlay: live metrics plus the tuning knobs that matter.
 *
 * The sliders are not decoration. Filter tuning is a per-use-case judgement
 * (a static display wants heavy smoothing, a hand-held demo wants
 * responsiveness) and it cannot be settled by reading code -- it has to be felt
 * on a real device, with the jitter visible in the numbers at the same time.
 */

export interface DebugMetrics {
  fps: number;
  renderMs: number;
  detectMs: number;
  poseMs: number;
  workerMs: number;
  latencyMs: number;
  detectionsPerSecond: number;
  processingWidth: number;
  processingHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  frameStrategy: string;
  frameTiming: string;
  capturedFrames: number;
  droppedFrames: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  meanLuma: number;
  calibrated: boolean;
  fx: number;
  fy: number;
  markerSizeMeters: number;
  /** Jitter measurements, computed over a sliding window while tracking. */
  posJitterMm: number;
  rotJitterDeg: number;
  markers: {
    id: number;
    phase: string;
    opacity: number;
    reprojError: number;
    rejected: number;
    position: readonly [number, number, number];
    distanceMm: number;
  }[];
}

export interface TuningValues {
  positionMinCutoff: number;
  positionBeta: number;
  rotationSlerp: number;
  holdMs: number;
  processingWidth: number;
  subPixelRefinement: boolean;
  roiTracking: boolean;
  aruco3: boolean;
  shadowCatcher: boolean;
  lightEstimation: boolean;
  exposure: number;
  markerSizeMeters: number;
}

export interface DebugPanelOptions {
  initial: TuningValues;
  onChange: (values: Partial<TuningValues>) => void;
}

interface SliderSpec {
  key: keyof TuningValues;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'positionMinCutoff', label: 'pos minCutoff', min: 0.1, max: 8, step: 0.1 },
  { key: 'positionBeta', label: 'pos beta', min: 0, max: 1, step: 0.01 },
  { key: 'rotationSlerp', label: 'rot slerp', min: 0.02, max: 1, step: 0.02 },
  { key: 'holdMs', label: 'hold ms', min: 0, max: 1000, step: 20 },
  { key: 'processingWidth', label: 'proc width', min: 240, max: 960, step: 80 },
  { key: 'exposure', label: 'exposure', min: 0.2, max: 3, step: 0.05 },
  {
    key: 'markerSizeMeters',
    label: 'marker mm',
    min: 20,
    max: 400,
    step: 1,
    format: (v) => `${Math.round(v)}`,
  },
];

const TOGGLES: { key: keyof TuningValues; label: string }[] = [
  { key: 'subPixelRefinement', label: 'sub-pixel refine' },
  { key: 'roiTracking', label: 'ROI tracking' },
  { key: 'aruco3', label: 'ArUco3 fast mode' },
  { key: 'shadowCatcher', label: 'shadow catcher' },
  { key: 'lightEstimation', label: 'light estimate' },
];

export class DebugPanel {
  private readonly stats: HTMLElement;
  private readonly outputs = new Map<keyof TuningValues, HTMLOutputElement>();
  private values: TuningValues;
  private visible = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: DebugPanelOptions,
  ) {
    this.values = { ...opts.initial };
    this.root.innerHTML = '';

    this.stats = document.createElement('div');
    this.root.appendChild(this.stats);

    const tuning = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = 'Tuning';
    tuning.appendChild(heading);

    for (const spec of SLIDERS) {
      tuning.appendChild(this.makeSlider(spec));
    }
    for (const toggle of TOGGLES) {
      tuning.appendChild(this.makeToggle(toggle.key, toggle.label));
    }
    this.root.appendChild(tuning);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  private makeSlider(spec: SliderSpec): HTMLElement {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);

    // Marker size is tuned in millimetres but stored in metres.
    const isMarker = spec.key === 'markerSizeMeters';
    const toUi = (v: number) => (isMarker ? v * 1000 : v);
    const fromUi = (v: number) => (isMarker ? v / 1000 : v);

    input.value = String(toUi(this.values[spec.key] as number));

    const out = document.createElement('output');
    const render = (v: number) => (spec.format ? spec.format(v) : String(v));
    out.textContent = render(toUi(this.values[spec.key] as number));
    this.outputs.set(spec.key, out);

    input.addEventListener('input', () => {
      const ui = Number.parseFloat(input.value);
      out.textContent = render(ui);
      const next = fromUi(ui) as TuningValues[typeof spec.key];
      this.values = { ...this.values, [spec.key]: next };
      this.opts.onChange({ [spec.key]: next } as Partial<TuningValues>);
    });

    label.append(name, input, out);
    return label;
  }

  private makeToggle(key: keyof TuningValues, labelText: string): HTMLElement {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.values[key]);

    const out = document.createElement('output');
    out.textContent = input.checked ? 'on' : 'off';

    input.addEventListener('change', () => {
      out.textContent = input.checked ? 'on' : 'off';
      this.values = { ...this.values, [key]: input.checked };
      this.opts.onChange({ [key]: input.checked } as Partial<TuningValues>);
    });

    label.append(name, input, out);
    return label;
  }

  /** Called every frame while visible; writes textContent only, no DOM churn. */
  update(m: DebugMetrics): void {
    if (!this.visible) return;

    const rows: [string, string][] = [
      ['fps', m.fps.toFixed(1)],
      ['render', `${m.renderMs.toFixed(2)} ms`],
      ['detect', `${m.detectMs.toFixed(2)} ms`],
      ['pose', `${m.poseMs.toFixed(3)} ms`],
      ['worker total', `${m.workerMs.toFixed(2)} ms`],
      ['cam-to-pose', `${m.latencyMs.toFixed(1)} ms`],
      ['detections/s', m.detectionsPerSecond.toFixed(1)],
      ['jitter pos', `${m.posJitterMm.toFixed(2)} mm`],
      ['jitter rot', `${m.rotJitterDeg.toFixed(3)} deg`],
    ];

    const pipeline: [string, string][] = [
      ['source', `${m.sourceWidth}x${m.sourceHeight}`],
      ['processing', `${m.processingWidth}x${m.processingHeight}`],
      ['frames', `${m.capturedFrames} / ${m.droppedFrames} dropped`],
      ['capture', m.frameStrategy],
      ['timing', m.frameTiming],
      ['dpr', m.pixelRatio.toFixed(2)],
      ['draw calls', String(m.drawCalls)],
      ['triangles', String(m.triangles)],
      ['mean luma', m.meanLuma.toFixed(1)],
    ];

    const camera: [string, string][] = [
      ['intrinsics', m.calibrated ? 'calibrated' : 'estimated'],
      ['fx / fy', `${m.fx.toFixed(1)} / ${m.fy.toFixed(1)}`],
      ['marker', `${(m.markerSizeMeters * 1000).toFixed(0)} mm`],
    ];

    let html = `<h3>Performance</h3>${dl(rows)}<h3>Pipeline</h3>${dl(pipeline)}<h3>Camera</h3>${dl(camera)}`;

    if (m.markers.length > 0) {
      const markerRows = m.markers.flatMap((mk): [string, string][] => [
        [`#${mk.id} phase`, `${mk.phase} ${(mk.opacity * 100).toFixed(0)}%`],
        [`#${mk.id} dist`, `${mk.distanceMm.toFixed(0)} mm`],
        [
          `#${mk.id} pos`,
          `${mk.position.map((v) => (v * 1000).toFixed(0)).join(', ')} mm`,
        ],
        [`#${mk.id} reproj`, `${mk.reprojError.toFixed(2)} px / ${mk.rejected} rej`],
      ]);
      html += `<h3>Markers</h3>${dl(markerRows)}`;
    } else {
      html += '<h3>Markers</h3><dl><dt>none</dt><dd>&mdash;</dd></dl>';
    }

    this.stats.innerHTML = html;
  }
}

function dl(rows: readonly [string, string][]): string {
  return `<dl>${rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')}</dl>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
