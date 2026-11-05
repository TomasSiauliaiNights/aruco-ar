import { describe, expect, it } from 'vitest';
import {
  LowPassFilter,
  OneEuroFilter,
  OneEuroVec3,
  smoothingAlpha,
} from '../../src/pose/oneEuro';

const DT = 1 / 30;

/** Deterministic pseudo-noise, so a flaky test cannot hide here. */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function rms(values: readonly number[], about: number): number {
  const sum = values.reduce((acc, v) => acc + (v - about) ** 2, 0);
  return Math.sqrt(sum / values.length);
}

describe('smoothingAlpha', () => {
  it('rises with cutoff frequency', () => {
    const low = smoothingAlpha(0.5, DT);
    const high = smoothingAlpha(10, DT);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('is in (0, 1] for every sane input, and 1 for a non-positive step', () => {
    for (const cutoff of [0.01, 1, 30, 1000]) {
      for (const dt of [1 / 240, 1 / 60, 1 / 10]) {
        const a = smoothingAlpha(cutoff, dt);
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
    expect(smoothingAlpha(1, 0)).toBe(1);
    expect(smoothingAlpha(1, -1)).toBe(1);
  });

  it('approaches 1 as the sampling step grows relative to the cutoff', () => {
    expect(smoothingAlpha(5, 10)).toBeGreaterThan(0.99);
  });
});

describe('LowPassFilter', () => {
  it('passes the first sample through untouched', () => {
    const f = new LowPassFilter();
    expect(f.filter(7, 0.1)).toBe(7);
  });

  it('converges to a constant input', () => {
    const f = new LowPassFilter();
    f.filter(0, 1);
    let out = 0;
    for (let i = 0; i < 200; i++) out = f.filter(10, 0.2);
    expect(out).toBeCloseTo(10, 6);
  });

  it('resets back to pass-through', () => {
    const f = new LowPassFilter();
    f.filter(100, 0.5);
    f.reset();
    expect(f.hasValue).toBe(false);
    expect(f.filter(3, 0.5)).toBe(3);
  });
});

describe('OneEuroFilter', () => {
  const opts = { minCutoff: 1.2, beta: 0.06, derivateCutoff: 1 };

  it('returns the first sample unchanged', () => {
    const f = new OneEuroFilter(opts);
    expect(f.filter(42, 0)).toBe(42);
  });

  it('suppresses jitter on a stationary signal', () => {
    // This is the property the whole filter exists for: a marker that is not
    // moving must not wobble.
    const rand = noise(12345);
    const f = new OneEuroFilter(opts);
    const raw: number[] = [];
    const filtered: number[] = [];

    for (let i = 0; i < 300; i++) {
      const sample = 1 + rand() * 0.004; // +/- 4 mm of noise around 1 m
      raw.push(sample);
      filtered.push(f.filter(sample, i * DT));
    }

    const settledRaw = raw.slice(50);
    const settledFiltered = filtered.slice(50);
    const rawRms = rms(settledRaw, 1);
    const filteredRms = rms(settledFiltered, 1);

    expect(filteredRms).toBeLessThan(rawRms * 0.35);
  });

  it('tracks a ramp with bounded lag', () => {
    const f = new OneEuroFilter(opts);
    let out = 0;
    const speed = 0.5; // m/s
    for (let i = 0; i < 200; i++) {
      out = f.filter(i * DT * speed, i * DT);
    }
    const truth = 199 * DT * speed;
    // Steady-state lag must stay small; a fixed low-pass smooth enough to kill
    // the jitter above would be far worse here.
    expect(Math.abs(out - truth)).toBeLessThan(0.1);
  });

  it('follows faster when beta is larger', () => {
    const slow = new OneEuroFilter({ ...opts, beta: 0 });
    const fast = new OneEuroFilter({ ...opts, beta: 2 });
    let slowOut = 0;
    let fastOut = 0;
    for (let i = 0; i < 60; i++) {
      const target = i * DT * 2;
      slowOut = slow.filter(target, i * DT);
      fastOut = fast.filter(target, i * DT);
    }
    const truth = 59 * DT * 2;
    expect(Math.abs(fastOut - truth)).toBeLessThan(Math.abs(slowOut - truth));
  });

  it('smooths more heavily when minCutoff is lower', () => {
    const rand1 = noise(999);
    const rand2 = noise(999);
    const heavy = new OneEuroFilter({ ...opts, minCutoff: 0.2 });
    const light = new OneEuroFilter({ ...opts, minCutoff: 6 });
    const heavyOut: number[] = [];
    const lightOut: number[] = [];
    for (let i = 0; i < 300; i++) {
      heavyOut.push(heavy.filter(1 + rand1() * 0.004, i * DT));
      lightOut.push(light.filter(1 + rand2() * 0.004, i * DT));
    }
    expect(rms(heavyOut.slice(60), 1)).toBeLessThan(rms(lightOut.slice(60), 1));
  });

  it('survives a duplicated timestamp without producing NaN', () => {
    // Two rAF callbacks can land on the same video frame, so dt = 0 is real.
    const f = new OneEuroFilter(opts);
    f.filter(1, 0);
    const out = f.filter(1.01, 0);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('survives a long gap, as after the tab was backgrounded', () => {
    const f = new OneEuroFilter(opts);
    f.filter(1, 0);
    const out = f.filter(1.5, 600); // ten minutes later
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(1);
    expect(out).toBeLessThanOrEqual(1.5);
  });

  it('is reusable after reset', () => {
    const f = new OneEuroFilter(opts);
    for (let i = 0; i < 50; i++) f.filter(5, i * DT);
    f.reset();
    expect(f.filter(-3, 0)).toBe(-3);
  });

  it('takes a configure() change into effect immediately', () => {
    const f = new OneEuroFilter(opts);
    for (let i = 0; i < 30; i++) f.filter(0, i * DT);
    f.configure({ minCutoff: 60 });
    const out = f.filter(1, 30 * DT);
    // With a very high cutoff the filter is nearly pass-through.
    expect(out).toBeGreaterThan(0.6);
  });
});

describe('OneEuroVec3', () => {
  it('filters axes independently', () => {
    const v = new OneEuroVec3({ minCutoff: 1, beta: 0, derivateCutoff: 1 });
    v.filter([0, 0, 0], 0);
    let out: [number, number, number] = [0, 0, 0];
    for (let i = 1; i < 200; i++) out = v.filter([1, -2, 3], i * DT);
    expect(out[0]).toBeCloseTo(1, 3);
    expect(out[1]).toBeCloseTo(-2, 3);
    expect(out[2]).toBeCloseTo(3, 3);
  });

  it('resets all three axes', () => {
    const v = new OneEuroVec3({ minCutoff: 1, beta: 0, derivateCutoff: 1 });
    for (let i = 0; i < 40; i++) v.filter([9, 9, 9], i * DT);
    v.reset();
    expect(v.filter([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });
});
