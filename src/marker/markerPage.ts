/**
 * Printable-marker page. Renders the SVG live and offers print / download /
 * "use this size in the app", the last of which writes the same localStorage key
 * the AR view reads, so the printed size and the solver's assumption agree
 * without the user retyping it.
 */

import { config, knownMarkerIds, getMarkerSizeMeters, setMarkerSizeMeters } from '../config';
import { markerSvg, validIds } from './markerSvg';

const idSelect = document.getElementById('marker-id') as HTMLSelectElement;
const sizeInput = document.getElementById('marker-size') as HTMLInputElement;
const quietSelect = document.getElementById('quiet-zone') as HTMLSelectElement;
const labelCheck = document.getElementById('with-label') as HTMLInputElement;
const preview = document.getElementById('preview') as HTMLElement;
const note = document.getElementById('marker-note') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

const configured = new Set(knownMarkerIds);

for (const id of validIds()) {
  const opt = document.createElement('option');
  opt.value = String(id);
  const model = config.markers[id];
  opt.textContent = model
    ? `${id} — ${model.url.split('/').pop() ?? model.url}`
    : `${id} — no model configured`;
  idSelect.appendChild(opt);
}

idSelect.value = String(knownMarkerIds[0] ?? 0);
sizeInput.value = String(Math.round(getMarkerSizeMeters() * 1000));

function currentOptions() {
  const id = Number.parseInt(idSelect.value, 10) || 0;
  const sideMm = clamp(Number.parseFloat(sizeInput.value) || 100, 20, 400);
  const quietZoneFraction = Number.parseFloat(quietSelect.value) || 0.25;
  return { id, sideMm, quietZoneFraction, withLabel: labelCheck.checked };
}

function render(): void {
  const opts = currentOptions();
  preview.innerHTML = markerSvg(opts);

  const appMm = Math.round(getMarkerSizeMeters() * 1000);
  const total = opts.sideMm * (1 + opts.quietZoneFraction * 2);
  const parts = [
    `Black square: ${opts.sideMm} mm. With the quiet zone the sheet needs ${total.toFixed(
      0,
    )} mm of white.`,
  ];
  if (!configured.has(opts.id)) {
    parts.push(
      `Marker ${opts.id} has no model in src/config.ts, so the app will detect it but show nothing.`,
    );
  }
  if (Math.abs(appMm - opts.sideMm) > 0.5) {
    parts.push(
      `The app is currently set to ${appMm} mm — press "Use this size in the app" after printing.`,
    );
  }
  note.textContent = parts.join(' ');
}

function setStatus(message: string): void {
  status.textContent = message;
  if (message) window.setTimeout(() => (status.textContent = ''), 4000);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

for (const input of [idSelect, sizeInput, quietSelect, labelCheck]) {
  input.addEventListener('input', render);
  input.addEventListener('change', render);
}

(document.getElementById('btn-print') as HTMLButtonElement).addEventListener('click', () => {
  window.print();
});

(document.getElementById('btn-svg') as HTMLButtonElement).addEventListener('click', () => {
  const opts = currentOptions();
  const svg = markerSvg(opts);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aruco-4x4_50-id${opts.id}-${opts.sideMm}mm.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus('SVG downloaded. Print it at 100% scale.');
});

(document.getElementById('btn-use') as HTMLButtonElement).addEventListener('click', () => {
  const { sideMm } = currentOptions();
  const ok = setMarkerSizeMeters(sideMm / 1000) ?? true;
  void ok;
  setStatus(`The app will now assume a ${sideMm} mm marker.`);
  render();
});

render();
