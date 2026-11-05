import { describe, expect, it } from 'vitest';
import { DICT_4X4_50_CODES, markerBits, markerSvg, validIds } from '../../src/marker/markerSvg';

describe('DICT_4X4_50_CODES', () => {
  it('has exactly 50 entries', () => {
    expect(DICT_4X4_50_CODES).toHaveLength(50);
  });

  it('has no duplicates', () => {
    // A duplicate would mean two ids print the same marker, which the detector
    // would resolve to whichever came first -- silently wrong.
    expect(new Set(DICT_4X4_50_CODES).size).toBe(50);
  });

  it('holds only 16-bit values', () => {
    for (const code of DICT_4X4_50_CODES) {
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(0xffff);
    }
  });

  it('keeps every pair at least one bit apart', () => {
    for (let i = 0; i < 50; i++) {
      for (let j = i + 1; j < 50; j++) {
        const diff = (DICT_4X4_50_CODES[i] as number) ^ (DICT_4X4_50_CODES[j] as number);
        let bits = 0;
        for (let b = 0; b < 16; b++) if ((diff >> b) & 1) bits++;
        expect(bits).toBeGreaterThan(0);
      }
    }
  });
});

describe('markerBits', () => {
  it('returns a 6x6 grid', () => {
    const bits = markerBits(0);
    expect(bits).toHaveLength(6);
    for (const row of bits) expect(row).toHaveLength(6);
  });

  it('makes the whole outer ring black', () => {
    // The black border is what the detector finds first; a gap in it means no
    // detection at all.
    for (const id of [0, 7, 23, 49]) {
      const bits = markerBits(id);
      for (let i = 0; i < 6; i++) {
        expect(bits[0]![i]).toBe(true);
        expect(bits[5]![i]).toBe(true);
        expect(bits[i]![0]).toBe(true);
        expect(bits[i]![5]).toBe(true);
      }
    }
  });

  it('matches the grid OpenCV renders for id 0', () => {
    // Captured from cv.getPredefinedDictionary(cv.DICT_4X4_50)
    //   .generateImageMarker(0, 6, out, 1); '#' is black.
    const expected = ['######', '#.#..#', '##.#.#', '###..#', '###.##', '######'];
    const actual = markerBits(0).map((row) => row.map((b) => (b ? '#' : '.')).join(''));
    expect(actual).toEqual(expected);
  });

  it('gives different ids different interiors', () => {
    const a = JSON.stringify(markerBits(0));
    const b = JSON.stringify(markerBits(1));
    expect(a).not.toBe(b);
  });

  it('rejects ids outside the dictionary', () => {
    expect(() => markerBits(50)).toThrow(RangeError);
    expect(() => markerBits(-1)).toThrow(RangeError);
    expect(() => markerBits(1.5)).toThrow(RangeError);
  });

  it('covers every id in the dictionary', () => {
    expect(validIds()).toHaveLength(50);
    for (const id of validIds()) expect(() => markerBits(id)).not.toThrow();
  });
});

describe('markerSvg', () => {
  it('sizes the document in millimetres so printing at 100% is exact', () => {
    // A unitless width would be interpreted as pixels and print at the wrong
    // physical size, which scales every distance the solver reports.
    const svg = markerSvg({ id: 0, sideMm: 100, quietZoneFraction: 0.25 });
    expect(svg).toContain('width="150mm"');
    expect(svg).toContain('height="150mm"');
    expect(svg).toContain('viewBox="0 0 150 150"');
  });

  it('matches viewBox units to millimetres at any size', () => {
    for (const sideMm of [20, 57.5, 100, 400]) {
      const quiet = 0.25;
      const total = sideMm * (1 + quiet * 2);
      const svg = markerSvg({ id: 3, sideMm, quietZoneFraction: quiet });
      expect(svg).toContain(`width="${total}mm"`);
      expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
    }
  });

  it('leaves a white quiet zone around the marker', () => {
    const svg = markerSvg({ id: 0, sideMm: 100, quietZoneFraction: 0.3 });
    // The marker starts one quiet-zone in from the edge.
    expect(svg).toContain('x="30"');
    expect(svg).toContain('fill="#fff"');
  });

  it('scales the quiet zone with the requested fraction', () => {
    const tight = markerSvg({ id: 0, sideMm: 100, quietZoneFraction: 0.15 });
    const loose = markerSvg({ id: 0, sideMm: 100, quietZoneFraction: 0.4 });
    expect(tight).toContain('width="130mm"');
    expect(loose).toContain('width="180mm"');
  });

  it('draws one rect per black cell', () => {
    const bits = markerBits(0);
    const blackCells = bits.flat().filter(Boolean).length;
    const svg = markerSvg({ id: 0, sideMm: 100, withLabel: false });
    // One background rect plus one per black cell.
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(blackCells + 1);
  });

  it('adds a caption only when asked, and leaves room for it', () => {
    const without = markerSvg({ id: 12, sideMm: 100, withLabel: false });
    const with_ = markerSvg({ id: 12, sideMm: 100, withLabel: true });
    expect(without).not.toContain('<text');
    expect(with_).toContain('<text');
    expect(with_).toContain('id 12');
    expect(with_).toContain('100 mm');
    // The caption must not overlap the quiet zone, so the page is taller.
    expect(with_).toContain('width="150mm"');
    expect(with_).not.toContain('height="150mm"');
  });

  it('is well-formed, self-contained SVG', () => {
    const svg = markerSvg({ id: 0, sideMm: 100, withLabel: true });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // No external references: it has to print identically offline.
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg).not.toContain('<image');
  });

  it('disables smoothing so cell edges stay sharp', () => {
    expect(markerSvg({ id: 0, sideMm: 100 })).toContain('shape-rendering="crispEdges"');
  });

  it('includes an accessible title', () => {
    expect(markerSvg({ id: 7, sideMm: 80 })).toContain('<title>ArUco 4x4_50 marker 7 at 80 mm</title>');
  });

  it('rejects an id with no marker', () => {
    expect(() => markerSvg({ id: 99, sideMm: 100 })).toThrow(RangeError);
  });
});
