import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from './geometry';
import { seamFeature, seamLengthMeters, seamLineFor } from './imagerySeam';

/** A square lake, ~2.2 km across at this latitude. */
const LAKE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.31, 44.49],
      [-73.29, 44.49],
      [-73.29, 44.51],
      [-73.31, 44.51],
      [-73.31, 44.49],
    ],
  ],
};

/** A granule whose eastern edge runs straight down the middle of the lake. */
const BISECTING: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.5, 44.4],
      [-73.3, 44.4],
      [-73.3, 44.6],
      [-73.5, 44.6],
      [-73.5, 44.4],
    ],
  ],
};

/** A granule that swallows the lake whole — no edge crosses the water. */
const COVERING: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.5, 44.4],
      [-73.1, 44.4],
      [-73.1, 44.6],
      [-73.5, 44.6],
      [-73.5, 44.4],
    ],
  ],
};

/** A granule nowhere near it. */
const ELSEWHERE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-69.8, 45.5],
      [-69.6, 45.5],
      [-69.6, 45.7],
      [-69.8, 45.7],
      [-69.8, 45.5],
    ],
  ],
};

describe('seamLineFor — the join, and only the part in the water', () => {
  it('draws a line where the granule edge crosses the lake', () => {
    const seam = seamLineFor(BISECTING, LAKE);
    expect(seam).not.toBeNull();
    expect(seam?.type).toBe('MultiLineString');
    expect(seam?.coordinates.length).toBeGreaterThan(0);
  });

  it('⚠ puts every vertex inside the lake, never on the bank', () => {
    // The whole reason this is not "the outline of the intersection": that outline is part granule
    // edge and part shoreline, and tracing the shore a second time in another colour says something
    // the seam does not mean.
    const seam = seamLineFor(BISECTING, LAKE);
    for (const line of seam?.coordinates ?? []) {
      for (const [lng, lat] of line as [number, number][]) {
        expect(pointInPolygon({ lat, lng }, LAKE)).toBe(true);
      }
    }
  });

  it('follows the edge that actually bisects, at roughly the lake’s width', () => {
    // The lake spans 44.49–44.51, about 2.2 km. A seam much shorter would mean the walk stopped
    // early; much longer would mean it wandered outside.
    const seam = seamLineFor(BISECTING, LAKE);
    expect(seam).not.toBeNull();
    if (!seam) return;
    const length = seamLengthMeters(seam);
    expect(length).toBeGreaterThan(1800);
    expect(length).toBeLessThan(2600);
  });

  it('returns null when the frame covers the lake outright', () => {
    // The common and correct answer. A caller renders nothing rather than falling back to something.
    expect(seamLineFor(COVERING, LAKE)).toBeNull();
  });

  it('returns null for a granule nowhere near the lake', () => {
    expect(seamLineFor(ELSEWHERE, LAKE)).toBeNull();
  });

  it('is stable under sampling resolution, to within the spacing', () => {
    const fine = seamLineFor(BISECTING, LAKE, { sampleMeters: 5 });
    const coarse = seamLineFor(BISECTING, LAKE, { sampleMeters: 100 });
    expect(fine).not.toBeNull();
    expect(coarse).not.toBeNull();
    if (!fine || !coarse) return;
    expect(Math.abs(seamLengthMeters(fine) - seamLengthMeters(coarse))).toBeLessThan(250);
  });

  it('handles a footprint with two edges through the water', () => {
    // A narrow granule crossing the lake enters and leaves, so both its edges cut the water and the
    // result is two lines rather than one.
    const narrow: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73.305, 44.4],
          [-73.295, 44.4],
          [-73.295, 44.6],
          [-73.305, 44.6],
          [-73.305, 44.4],
        ],
      ],
    };
    const seam = seamLineFor(narrow, LAKE);
    expect(seam?.coordinates.length).toBe(2);
  });
});

describe('seamFeature', () => {
  it('wraps the geometry so a client hands it straight to a source', () => {
    const feature = seamFeature(BISECTING, LAKE);
    expect(feature?.type).toBe('Feature');
    expect(feature?.geometry.type).toBe('MultiLineString');
  });

  it('passes null through, so "no seam" stays one answer rather than two', () => {
    expect(seamFeature(COVERING, LAKE)).toBeNull();
  });
});

describe('seamLengthMeters', () => {
  it('measures a LineString and a MultiLineString the same way', () => {
    const single = seamLengthMeters({
      type: 'LineString',
      coordinates: [
        [-73.3, 44.49],
        [-73.3, 44.51],
      ],
    });
    const multi = seamLengthMeters({
      type: 'MultiLineString',
      coordinates: [
        [
          [-73.3, 44.49],
          [-73.3, 44.5],
        ],
        [
          [-73.3, 44.5],
          [-73.3, 44.51],
        ],
      ],
    });
    expect(Math.abs(single - multi)).toBeLessThan(1);
  });

  it('is zero for a degenerate line', () => {
    expect(seamLengthMeters({ type: 'MultiLineString', coordinates: [] })).toBe(0);
  });
});
