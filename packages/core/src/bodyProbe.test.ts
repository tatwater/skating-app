import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { probeCoverage } from './bodyProbe';
import { containedFraction, type LatLng } from './geometry';

/** An axis-aligned square, south-west corner + side in degrees. */
function square(lng: number, lat: number, side: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + side, lat],
        [lng + side, lat + side],
        [lng, lat + side],
        [lng, lat],
      ],
    ],
  };
}

/** An evenly-spaced sounding grid filling a square region. */
function soundings(lng: number, lat: number, side: number, n: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({ lng: lng + (side * (i + 0.5)) / n, lat: lat + (side * (j + 0.5)) / n });
    }
  }
  return out;
}

describe('probeCoverage', () => {
  // The lake as surveyed: a 0.02° square, densely sounded.
  const TRUE_LAKE = square(-70, 44, 0.02);
  const SURVEY = soundings(-70, 44, 0.02, 20);

  it('reports a small gap for a polygon that matches the surveyed water', () => {
    const fit = probeCoverage(TRUE_LAKE, SURVEY);
    expect(fit).not.toBeNull();
    // Probe spacing is ~0.02°/32 ≈ 70 m and sounding spacing ~0.001° ≈ 80 m, so every probe has a
    // measurement within roughly one spacing.
    expect(fit?.gapM).toBeLessThan(150);
    expect(fit?.ratio).toBeLessThan(0.15);
  });

  it('**catches the over-draw that containedFraction cannot see** — the reason this exists', () => {
    // A polygon covering the lake AND the field next to it. It contains every single sounding, so
    // containment scores it perfect; probing its own area finds half of it nowhere near a
    // measurement. This asymmetry is the entire argument for having two metrics.
    const overDrawn = square(-70, 44, 0.04); // 4× the area, same survey

    expect(containedFraction(SURVEY, overDrawn)).toBe(1);
    expect(containedFraction(SURVEY, TRUE_LAKE)).toBe(1);

    const tight = probeCoverage(TRUE_LAKE, SURVEY);
    const loose = probeCoverage(overDrawn, SURVEY);
    expect(loose?.gapM).toBeGreaterThan((tight?.gapM ?? 0) * 3);
  });

  it('does not punish a polygon merely for being large, only for being unmeasured', () => {
    // The same 4× polygon, but genuinely surveyed throughout. Size alone must not lose.
    const bigLake = square(-70, 44, 0.04);
    const fullSurvey = soundings(-70, 44, 0.04, 40);
    const fit = probeCoverage(bigLake, fullSurvey);
    expect(fit?.gapM).toBeLessThan(150);
  });

  it('scales by sqrt(area), so a big well-surveyed lake and a small one compare equally', () => {
    const small = probeCoverage(square(-70, 44, 0.01), soundings(-70, 44, 0.01, 20));
    const big = probeCoverage(square(-70, 44, 0.04), soundings(-70, 44, 0.04, 80));
    // Same relative density, so the dimensionless ratios should sit in the same neighbourhood even
    // though the raw metre gaps differ fourfold.
    expect(small?.ratio).toBeGreaterThan(0);
    expect(big?.ratio).toBeGreaterThan(0);
    expect(Math.abs((small?.ratio ?? 0) - (big?.ratio ?? 0))).toBeLessThan(0.05);
  });

  it('finds a hole in the middle of an otherwise well-surveyed lake', () => {
    // A survey covering everything except a central block. The p95 probe should sit in that hole.
    const holed = SURVEY.filter(
      (p) => !(p.lng > -69.994 && p.lng < -69.986 && p.lat > 44.006 && p.lat < 44.014),
    );
    const full = probeCoverage(TRUE_LAKE, SURVEY);
    const holey = probeCoverage(TRUE_LAKE, holed);
    expect(holey?.gapM).toBeGreaterThan((full?.gapM ?? 0) * 2);
  });

  it('abstains rather than scoring zero when it cannot be asked', () => {
    // `null` must not read as "gap of 0" — a caller comparing candidates would hand the win to
    // whichever polygon was too thin to probe.
    expect(probeCoverage(TRUE_LAKE, [])).toBeNull();
    // A degenerate polygon with no extent.
    expect(probeCoverage(square(-70, 44, 0), SURVEY)).toBeNull();
  });

  it('handles a MultiPolygon by probing every part', () => {
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [square(-70, 44, 0.01).coordinates, square(-69.9, 44, 0.01).coordinates],
    };
    const both = [...soundings(-70, 44, 0.01, 15), ...soundings(-69.9, 44, 0.01, 15)];
    const fit = probeCoverage(multi, both);
    expect(fit).not.toBeNull();
    expect(fit?.probes).toBeGreaterThan(10);
    expect(fit?.gapM).toBeLessThan(200);

    // Survey only the first part: the second is unmeasured and the gap must climb.
    const half = probeCoverage(multi, soundings(-70, 44, 0.01, 15));
    expect(half?.gapM).toBeGreaterThan((fit?.gapM ?? 0) * 5);
  });

  it('never returns a probe count of zero alongside a finite gap', () => {
    const fit = probeCoverage(TRUE_LAKE, SURVEY);
    expect(fit?.probes).toBeGreaterThan(0);
  });

  it('agrees with a brute-force nearest-distance search', () => {
    // The grid index is an optimisation; it must not change the answer. Small inputs so the naive
    // loop is affordable here and would be ruinous at bake-off scale.
    const pts = soundings(-70, 44, 0.02, 6);
    const viaIndex = probeCoverage(TRUE_LAKE, pts, { grid: 8 });
    expect(viaIndex).not.toBeNull();
    // Reproduce the same probes and distances without the index.
    const R = 6_371_000;
    const hav = (a: LatLng, b: LatLng) => {
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const la = (a.lat * Math.PI) / 180;
      const lb = (b.lat * Math.PI) / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const brute: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const probe = { lng: -70 + (0.02 * (i + 0.5)) / 8, lat: 44 + (0.02 * (j + 0.5)) / 8 };
        let best = Number.POSITIVE_INFINITY;
        for (const p of pts) best = Math.min(best, hav(probe, p));
        brute.push(best);
      }
    }
    brute.sort((a, b) => a - b);
    const expected = brute[Math.min(brute.length - 1, Math.floor(brute.length * 0.95))] ?? 0;
    expect(viaIndex?.gapM).toBeCloseTo(expected, 0);
  });
});
