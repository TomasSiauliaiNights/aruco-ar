/**
 * ArUco 4x4_50 marker generation as print-exact SVG.
 *
 * The dictionary is embedded rather than derived, because OpenCV's predefined
 * dictionaries are published byte tables, not a generated code. These 50 codes
 * were exported from the same `cv.getPredefinedDictionary(cv.DICT_4X4_50)` the
 * detector uses, so a printed marker and the detector cannot disagree. The unit
 * test regenerates them from OpenCV and compares.
 *
 * Printing is the part people get wrong. The SVG is sized in millimetres with a
 * matching viewBox, so "100% / actual size" produces a marker whose black border
 * measures exactly the configured side length. Any "fit to page" or "shrink to
 * printable area" scaling silently changes the physical size, which scales every
 * distance the solver reports by the same factor.
 */

/**
 * 4x4_50: one 16-bit code per marker. MSB = top-left of the inner 4x4,
 * row-major, and a SET bit means a WHITE cell.
 *
 * Extracted from the shipped public/vendor/opencv.js (sha256 63366510...) by
 * rendering each id with `generateImageMarker(id, 6, out, 1)` and reading the
 * inner 4x4. Regenerate with `npm run marker:codes`; the unit test re-derives
 * them from OpenCV and fails if this table drifts.
 */
export const DICT_4X4_50_CODES: readonly number[] = [
  0xb532, 0x0f9a, 0x332d, 0x9946, 0x549e, 0x79cd, 0x9e2e, 0xc4f2, 0xfeda, 0xcf56,
  0xf991, 0x11a7, 0x0eb7, 0x2a0f, 0x24b1, 0x263e, 0x4665, 0x6600, 0x6c5e, 0x76af,
  0x868b, 0xb02b, 0xccd5, 0xdd82, 0xfe47, 0x9471, 0xace4, 0xa554, 0x2123, 0x346f,
  0x4415, 0x57b2, 0x9ecf, 0xf0cb, 0x08ae, 0x0929, 0x1875, 0x04ff, 0x0df6, 0x1c5a,
  0x1718, 0x2a28, 0x328c, 0x38b2, 0x24e8, 0x2eeb, 0x2d3f, 0x4b64, 0x502e, 0x5013,
];

export interface MarkerSvgOptions {
  /** Marker id. */
  id: number;
  /** Side length of the black border square, in millimetres. */
  sideMm: number;
  /**
   * White quiet zone around the marker, as a fraction of the side length.
   * OpenCV's detector needs a quiet zone of at least one marker cell; 0.25 of
   * the side (one full cell for a 4x4 marker plus margin) is a safe default.
   */
  quietZoneFraction?: number;
  /** Print the id and physical size beneath the marker. */
  withLabel?: boolean;
}

/** Grid size of a 4x4 marker including its one-cell black border. */
const GRID = 6;

/**
 * Bit grid for a marker id: true = black.
 *
 * The outer ring is always black (the border). The inner 4x4 comes from the
 * code, MSB first, row-major, where a set bit is white -- matching OpenCV's
 * byte-list convention.
 */
export function markerBits(id: number): boolean[][] {
  const code = DICT_4X4_50_CODES[id];
  if (code === undefined) {
    throw new RangeError(`marker id ${id} is outside 4x4_50 (valid: 0-49)`);
  }

  const cells: boolean[][] = [];
  for (let row = 0; row < GRID; row++) {
    const cols: boolean[] = [];
    for (let col = 0; col < GRID; col++) {
      const isBorder = row === 0 || col === 0 || row === GRID - 1 || col === GRID - 1;
      if (isBorder) {
        cols.push(true);
        continue;
      }
      const bitIndex = (row - 1) * 4 + (col - 1);
      const bit = (code >> (15 - bitIndex)) & 1;
      cols.push(bit === 0);
    }
    cells.push(cols);
  }
  return cells;
}

/**
 * Print-exact SVG. Width/height carry explicit `mm` units and the viewBox is in
 * the same numeric space, so one user unit is one millimetre.
 */
export function markerSvg(opts: MarkerSvgOptions): string {
  const { id, sideMm } = opts;
  const quiet = opts.quietZoneFraction ?? 0.25;
  const quietMm = sideMm * quiet;
  const labelMm = opts.withLabel ? Math.max(6, sideMm * 0.07) : 0;

  const totalW = sideMm + quietMm * 2;
  const totalH = totalW + labelMm;
  const cell = sideMm / GRID;
  const bits = markerBits(id);

  const rects: string[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (!bits[row]?.[col]) continue;
      const x = quietMm + col * cell;
      const y = quietMm + row * cell;
      // A hairline overlap stops printer anti-aliasing leaving white seams
      // between adjacent black cells, which costs the detector contrast.
      rects.push(
        `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(cell + 0.02)}" height="${fmt(
          cell + 0.02,
        )}"/>`,
      );
    }
  }

  const label = opts.withLabel
    ? `<text x="${fmt(totalW / 2)}" y="${fmt(totalW + labelMm * 0.75)}" ` +
      `font-family="monospace" font-size="${fmt(labelMm * 0.62)}" text-anchor="middle" ` +
      `fill="#000">ArUco 4x4_50  id ${id}  ${fmt(sideMm)} mm</text>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(totalW)}mm" height="${fmt(totalH)}mm" ` +
    `viewBox="0 0 ${fmt(totalW)} ${fmt(totalH)}" shape-rendering="crispEdges">` +
    `<title>ArUco 4x4_50 marker ${id} at ${fmt(sideMm)} mm</title>` +
    `<rect width="${fmt(totalW)}" height="${fmt(totalH)}" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g>` +
    label +
    `</svg>`
  );
}

/** Trims float noise so the SVG stays readable and small. */
function fmt(v: number): string {
  return Number.parseFloat(v.toFixed(4)).toString();
}

/** Marker ids that the app has a model bound to; used to populate the picker. */
export function validIds(): number[] {
  return DICT_4X4_50_CODES.map((_, i) => i);
}
