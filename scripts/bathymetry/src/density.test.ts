import { describe, expect, it } from 'vitest';
import { assessDensity, convexHull, MIN_SOUNDINGS, summariseDensity } from './density';

/** A filled grid of soundings over a square patch — the well-surveyed case. */
function grid(n: number, spanDeg = 0.02, originLng = -70, originLat = 45) {
  const points: { lng: number; lat: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      points.push({
        lng: originLng + (spanDeg * i) / (n - 1),
        lat: originLat + (spanDeg * j) / (n - 1),
      });
    }
  }
  return points;
}

describe('convexHull', () => {
  it('returns the corners of a filled square, not its interior', () => {
    const hull = convexHull(grid(5));
    expect(hull).toHaveLength(4);
  });

  it('passes through degenerate inputs rather than throwing', () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([{ lng: 1, lat: 1 }])).toHaveLength(1);
    expect(
      convexHull([
        { lng: 1, lat: 1 },
        { lng: 1, lat: 1 },
      ]),
    ).toHaveLength(1);
  });

  it('ignores a point inside the hull', () => {
    const hull = convexHull([
      { lng: 0, lat: 0 },
      { lng: 2, lat: 0 },
      { lng: 2, lat: 2 },
      { lng: 0, lat: 2 },
      { lng: 1, lat: 1 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull.some((p) => p.lng === 1 && p.lat === 1)).toBe(false);
  });
});

describe('assessDensity', () => {
  it('passes a densely and evenly surveyed lake', () => {
    const result = assessDensity({ lakeKey: 'dense', points: grid(12) });
    expect(result.verdict).toBe('ok');
    expect(result.gapRatio).toBeLessThan(0.15);
  });

  it('rejects a lake with too few soundings before looking at their spread', () => {
    const result = assessDensity({ lakeKey: 'sparse', points: grid(3).slice(0, 5) });
    expect(result.verdict).toBe('too-few-points');
    expect(result.reason).toContain(String(MIN_SOUNDINGS));
  });

  it('rejects a well-sampled corner that leaves the rest of the basin unmeasured', () => {
    // The failure the whole gate exists for: plenty of readings, clustered. An interpolator would
    // still produce smooth confident contours across the empty three-quarters.
    const clustered = [
      ...grid(6, 0.002), // 36 tight readings in one corner
      { lng: -70 + 0.05, lat: 45 + 0.05 }, // and one far away, to stretch the extent
      { lng: -70 + 0.05, lat: 45 },
      { lng: -70, lat: 45 + 0.05 },
    ];
    const result = assessDensity({ lakeKey: 'clustered', points: clustered });
    expect(result.verdict).toBe('too-sparse');
    expect(result.reason).toMatch(/worst-covered water is \d+ m from a sounding/);
  });

  it('is scale-free — the same shape passes at pond size and at Champlain size', () => {
    // gapRatio normalises by extent, so a 200 m pond and a 200 km lake are judged on the same terms.
    const pond = assessDensity({ lakeKey: 'pond', points: grid(10, 0.002) });
    const huge = assessDensity({ lakeKey: 'huge', points: grid(10, 0.9) });
    expect(pond.verdict).toBe('ok');
    expect(huge.verdict).toBe('ok');
    expect(pond.gapRatio).toBeCloseTo(huge.gapRatio, 1);
  });

  it('reports a degenerate lake where every sounding is at one spot', () => {
    const stacked = Array.from({ length: 20 }, () => ({ lng: -70, lat: 45 }));
    const result = assessDensity({ lakeKey: 'stacked', points: stacked });
    expect(result.verdict).toBe('degenerate');
    expect(result.reason).toContain('no spatial extent');
  });

  it('reports a single transect as degenerate — a profile is not a basin', () => {
    const line = Array.from({ length: 40 }, (_, i) => ({ lng: -70 + i * 0.001, lat: 45 }));
    const result = assessDensity({ lakeKey: 'line', points: line });
    expect(result.verdict).toBe('degenerate');
    expect(result.reason).toContain('line, not an area');
  });

  it('honours a caller-supplied threshold, so the gate can be swept over real data', () => {
    const clustered = [
      ...grid(6, 0.004),
      { lng: -70 + 0.04, lat: 45 + 0.04 },
      { lng: -70 + 0.04, lat: 45 },
      { lng: -70, lat: 45 + 0.04 },
    ];
    const strict = assessDensity({ lakeKey: 'x', points: clustered }, { maxGapRatio: 0.05 });
    const loose = assessDensity({ lakeKey: 'x', points: clustered }, { maxGapRatio: 0.9 });
    expect(strict.verdict).toBe('too-sparse');
    expect(loose.verdict).toBe('ok');
    // The measurement is the same either way — only the verdict moves.
    expect(strict.coverageGapM).toBeCloseTo(loose.coverageGapM, 5);
  });

  it('does not bound the gap it measures', () => {
    // The methodological bug caught while sizing this gate: filtering probes to those within
    // 0.25 × extent of a sounding made it impossible for any lake to score worse than 0.25, so the
    // measurement silently agreed with whatever threshold you picked. The hull does not do that.
    const clustered = [
      ...grid(5, 0.001),
      { lng: -70 + 0.2, lat: 45 + 0.2 },
      { lng: -70 + 0.2, lat: 45 },
      { lng: -70, lat: 45 + 0.2 },
    ];
    const result = assessDensity({ lakeKey: 'x', points: clustered });
    expect(result.gapRatio).toBeGreaterThan(0.25);
  });

  it('survives a lake with more soundings than a spread can pass as arguments', () => {
    // Vermont's densest lake carries 136,856 soundings and `Math.min(...lngs)` threw
    // "Maximum call stack size exceeded" on the first real run. Every test above uses a few hundred
    // points, so nothing here could have reached it — this is the regression, sized to the real data.
    const many = Array.from({ length: 140_000 }, (_, i) => ({
      lng: -73 + (i % 400) * 0.0001,
      lat: 44 + Math.floor(i / 400) * 0.0001,
    }));
    const result = assessDensity({ lakeKey: 'huge', points: many });
    expect(result.verdict).toBe('ok');
    expect(result.extentM).toBeGreaterThan(0);
  });

  it('names every rejected lake, per the no-silent-caps rule', () => {
    const result = assessDensity({ lakeKey: 'named', points: grid(2) });
    expect(result.lakeKey).toBe('named');
    expect(result.reason).toBeTruthy();
  });
});

describe('summariseDensity', () => {
  it('splits kept from dropped and counts by verdict', () => {
    const summary = summariseDensity([
      assessDensity({ lakeKey: 'a', points: grid(12) }),
      assessDensity({ lakeKey: 'b', points: grid(2) }),
      assessDensity({
        lakeKey: 'c',
        points: Array.from({ length: 20 }, () => ({ lng: -70, lat: 45 })),
      }),
    ]);
    expect(summary.kept.map((k) => k.lakeKey)).toEqual(['a']);
    expect(summary.dropped).toHaveLength(2);
    expect(summary.byVerdict.ok).toBe(1);
    expect(summary.byVerdict['too-few-points']).toBe(1);
    expect(summary.byVerdict.degenerate).toBe(1);
  });
});
