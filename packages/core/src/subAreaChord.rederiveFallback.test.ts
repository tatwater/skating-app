import type { Polygon } from 'geojson';
import { describe, expect, it, vi } from 'vitest';

// The clipper behind `coveredFraction` can choke on near-coincident outlines (the re-clip guards its
// own overlap the same way); here it always does.
vi.mock('./geometry', async (original) => ({
  ...(await original<typeof import('./geometry')>()),
  coveredFraction: () => {
    throw new Error('the clipper choked');
  },
}));

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

  it('lets the old bay’s own open-water point pick the region — never the click — and claims no more', () => {
    const corner = chordSubArea(lake, mouth);
    if (!corner.ok) throw new Error(corner.reason);
    const kept = rederiveChordSubArea(
      lake,
      { ...mouth, side: { lat: 44.5, lng: -73.0 } },
      corner.polygon,
    );
    if (!kept.ok) throw new Error(kept.reason);
    expect(surfaceAreaSqM(kept.polygon)).toBeCloseTo(surfaceAreaSqM(corner.polygon), -3);
    expect(kept.sameWater).toBe(false);

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
});
