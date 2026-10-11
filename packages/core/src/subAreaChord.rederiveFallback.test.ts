import type { Polygon } from 'geojson';
import { describe, expect, it, vi } from 'vitest';

// The clipper behind `coveredFraction` can choke on near-coincident outlines (the re-clip guards its
// own overlap the same way); here it always does.
// Unless `chokeOn` names one outline, the only one it then chokes on.
const clipper = vi.hoisted(() => ({ chokeOn: null as unknown }));
vi.mock('./geometry', async (original) => {
  const real = await original<typeof import('./geometry')>();
  return {
    ...real,
    coveredFraction: (
      inner: Parameters<typeof real.coveredFraction>[0],
      outer: Parameters<typeof real.coveredFraction>[1],
    ) => {
      if (clipper.chokeOn === null || outer === clipper.chokeOn)
        throw new Error('the clipper choked');
      return real.coveredFraction(inner, outer);
    },
  };
});

const { surfaceAreaSqM } = await import('./geometry');
const { chordSubArea, rederiveChordSubArea } = await import('./subAreaChord');

describe('rederiveChordSubArea when the overlap cannot be measured (D215)', () => {
  const lake: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-73.5, 44.0],
        [-72.5, 44.0],
        [-72.5, 45.0],
        [-73.5, 45.0],
        [-73.5, 44.0],
      ],
    ],
  };
  const mouth = {
    a: { lat: 44.2, lng: -72.5 },
    b: { lat: 44.0, lng: -72.7 },
    side: { lat: 44.05, lng: -72.55 },
    sagittaM: 0,
  };

  it('lets the old bay’s own open-water point pick the region — never the click — judged by area alone', () => {
    const corner = chordSubArea(lake, mouth);
    if (!corner.ok) throw new Error(corner.reason);
    const kept = rederiveChordSubArea(
      lake,
      { ...mouth, side: { lat: 44.5, lng: -73.0 } },
      corner.polygon,
    );
    if (!kept.ok) throw new Error(kept.reason);
    expect(surfaceAreaSqM(kept.polygon)).toBeCloseTo(surfaceAreaSqM(corner.polygon), -3);
    // Unmeasured overlap: judged by area alone, and a jump by area is never the same water.
    expect(kept).toMatchObject({ jumped: false, sameWater: true });
    const twice = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-72.6, 44.0],
          [-72.5, 44.0],
          [-72.5, 44.05],
          [-72.6, 44.05],
          [-72.6, 44.0],
        ],
      ],
    };
    expect(rederiveChordSubArea(lake, mouth, twice)).toMatchObject({
      ok: true,
      jumped: true,
      sameWater: false,
    });

    const rest = chordSubArea(lake, { ...mouth, side: { lat: 44.5, lng: -73.0 } });
    if (!rest.ok) throw new Error(rest.reason);
    const keptRest = rederiveChordSubArea(lake, mouth, rest.polygon);
    expect(keptRest.ok && surfaceAreaSqM(keptRest.polygon)).toBeCloseTo(
      surfaceAreaSqM(rest.polygon),
      -5,
    );
  });

  it('refuses when the old bay has no open-water point, or it lies in neither region', () => {
    const sliver: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.6, 44.1],
          [-72.6, 44.1],
          [-72.6, 44.1],
          [-72.6, 44.1],
        ],
      ],
    };
    expect(rederiveChordSubArea(lake, mouth, sliver)).toEqual({ ok: false, reason: 'clip_failed' });
    const offshore: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.4, 44.1],
          [-72.3, 44.1],
          [-72.3, 44.2],
          [-72.4, 44.2],
          [-72.4, 44.1],
        ],
      ],
    };
    expect(rederiveChordSubArea(lake, mouth, offshore)).toEqual({
      ok: false,
      reason: 'clip_failed',
    });
  });

  it('calls a jump not the same water when only measuring it against the lake fails', () => {
    clipper.chokeOn = lake;
    try {
      const corner = chordSubArea(lake, mouth);
      if (!corner.ok) throw new Error(corner.reason);
      // 0.2° out: a jump; the corner is chosen by measured overlap, but its surviving water is not.
      const moved: Polygon = {
        type: 'Polygon',
        coordinates: [
          [
            [-73.5, 44.0],
            [-72.3, 44.0],
            [-72.3, 45.0],
            [-73.5, 45.0],
            [-73.5, 44.0],
          ],
        ],
      };
      clipper.chokeOn = moved;
      expect(rederiveChordSubArea(moved, mouth, corner.polygon)).toMatchObject({
        ok: true,
        jumped: true,
        sameWater: false,
      });
    } finally {
      clipper.chokeOn = null;
    }
  });

  it('refuses a bowed mouth whose old bay’s point lies where the two bowed builds overlap', () => {
    const square: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73.0, 44.0],
          [-72.874, 44.0],
          [-72.874, 44.09],
          [-73.0, 44.09],
          [-73.0, 44.0],
        ],
      ],
    };
    const across = {
      a: { lat: 44.09, lng: -72.9383 },
      b: { lat: 44.0, lng: -72.9383 },
      sagittaM: 4_000,
    };
    for (const side of [
      { lat: 44.045, lng: -72.9 },
      { lat: 44.045, lng: -72.97 },
    ]) {
      const drawn = chordSubArea(square, { ...across, side });
      if (!drawn.ok) throw new Error(drawn.reason);
      const again = rederiveChordSubArea(square, { ...across, side }, drawn.polygon);
      // Either the same bay, found by its own point, or a refusal — never the other side.
      if (again.ok) {
        expect(surfaceAreaSqM(again.polygon)).toBeCloseTo(surfaceAreaSqM(drawn.polygon), -4);
      } else {
        expect(again.reason).toBe('clip_failed');
      }
    }
  });
});
