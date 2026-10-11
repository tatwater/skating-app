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

const { chordSubArea, rederiveChordSubArea } = await import('./subAreaChord');

describe('rederiveChordSubArea when the overlap cannot be measured (D215)', () => {
  it('refuses rather than fall back to the stored click — the caller keeps the old outline', () => {
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
    const byClick = chordSubArea(lake, mouth);
    if (!byClick.ok) throw new Error('the fixture bay must derive');
    expect(rederiveChordSubArea(lake, mouth, byClick.polygon)).toEqual({
      ok: false,
      reason: 'clip_failed',
    });
  });
});
