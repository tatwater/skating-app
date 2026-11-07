import { describe, expect, it } from 'vitest';

import { endLabelYs, spreadLabels, stageSummary, type Trace, traceGeometry } from './trace-chart';

const traces: Trace[] = [
  { key: 'a', label: 'A', values: [34, 31, 19, null, 28, 33] },
  { key: 'b', label: 'B', values: [40, 38, 27, 32, 34, 38] },
];

describe('traceGeometry', () => {
  it('keeps every point inside the plot: the inset on all sides and the label gutter', () => {
    for (const [width, height, inset, gutter] of [
      [320, 56, 0.5, 0],
      [480, 120, 6, 72],
      [90, 24, 1, 30],
    ] as const) {
      const g = traceGeometry({ traces, rules: [{ value: 20 }], width, height, inset, gutter });
      for (const run of g.runs.flat())
        for (const p of run) {
          expect(p.x).toBeGreaterThanOrEqual(inset);
          expect(p.x).toBeLessThanOrEqual(width - gutter - inset);
          expect(p.y).toBeGreaterThanOrEqual(inset);
          expect(p.y).toBeLessThanOrEqual(height - inset);
        }
      // The extremes land exactly on the plot's edges.
      expect(g.y(40)).toBeCloseTo(inset, 9);
      expect(g.y(19)).toBeCloseTo(height - inset, 9);
    }
  });

  it('splits a trace at a gap instead of bridging it', () => {
    const g = traceGeometry({ traces, width: 200, height: 50, inset: 1, gutter: 0 });
    expect(g.runs[0]?.map((r) => r.length)).toEqual([3, 2]);
    expect(g.runs[1]?.map((r) => r.length)).toEqual([6]);
  });

  it('clamps to a fixed domain, so an outlier stays inside the drawing', () => {
    const g = traceGeometry({
      traces,
      domain: [20, 35],
      width: 200,
      height: 50,
      inset: 2,
      gutter: 0,
    });
    expect(g.y(19)).toBe(48);
    expect(g.y(40)).toBe(2);
  });

  it('draws a band as one closed path, and nothing for no data', () => {
    const g = traceGeometry({
      traces: [],
      band: { lo: [1, 2], hi: [3, 4] },
      width: 100,
      height: 20,
      inset: 0,
      gutter: 0,
    });
    expect(g.band).toMatch(/^M.* Z$/);
    const empty = traceGeometry({ traces: [], width: 100, height: 20, inset: 0, gutter: 0 });
    expect(empty.band).toBeNull();
    expect(empty.y(0)).toBeGreaterThanOrEqual(0);
    const flat = traceGeometry({
      traces: [{ key: 'f', label: 'F', values: [5] }],
      width: 100,
      height: 20,
      inset: 0,
      gutter: 0,
    });
    expect(flat.x(0)).toBe(0);
    expect(flat.ends[0]).toEqual({ x: 0, y: 10 });
  });

  it('has no end for a trace that ends in a gap', () => {
    const g = traceGeometry({
      traces: [{ key: 'g', label: 'G', values: [1, null] }],
      width: 100,
      height: 20,
      inset: 0,
      gutter: 0,
    });
    expect(g.ends[0]).toBeNull();
  });
});

describe('spreadLabels', () => {
  it('keeps labels a gap apart and inside the bounds, in their order', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const ys = Array.from(
        { length: 1 + (seed % 6) },
        (_, i) => ((seed * 37 + i * 53) % 120) - 10,
      );
      const out = spreadLabels(ys, 11, 6, 114);
      const sorted = [...out].sort((a, b) => a - b);
      for (let k = 1; k < sorted.length; k++)
        expect((sorted[k] as number) - (sorted[k - 1] as number)).toBeGreaterThanOrEqual(11 - 1e-9);
      // Order is kept: a label whose end is higher (once clamped to the bounds) never lands lower.
      const clamp = (y: number) => Math.min(Math.max(y, 6), 114);
      for (const [i, a] of ys.entries())
        for (const [j, b] of ys.entries())
          if (clamp(a) < clamp(b)) expect(out[i] as number).toBeLessThan(out[j] as number);
      // Within the floor whenever the stack fits.
      if (ys.length * 11 <= 108) for (const y of out) expect(y).toBeLessThanOrEqual(114 + 1e-9);
      if (ys.length * 11 <= 108) for (const y of out) expect(y).toBeGreaterThanOrEqual(6 - 1e-9);
    }
  });
});

describe('endLabelYs', () => {
  it('spreads only the labels that draw; a trace ending in a gap holds no slot', () => {
    const ends = [null, { x: 90, y: 10 }, { x: 90, y: 30 }];
    // Without the gap's phantom at the top, neither real label moves.
    expect(endLabelYs(ends, 11, 6, 114)).toEqual([undefined, 10, 30]);
    expect(endLabelYs([null, null], 11, 6, 114)).toEqual([undefined, undefined]);
  });
});

describe('stageSummary', () => {
  it('counts the states in the order they first appear, skipping the gap', () => {
    expect(stageSummary(['done', 'done', 'run', 'waiting', '|', 'waiting'])).toBe(
      '2 done, 1 running, 2 waiting',
    );
    expect(stageSummary(['late', 'stalled', 'failed'])).toBe('1 late, 1 stalled, 1 failed');
  });
});
