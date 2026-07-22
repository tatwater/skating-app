import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { distanceToPolygonMeters, type LatLng } from './geometry';
import {
  clusterPutIns,
  DEFAULT_PUTIN_MERGE_METERS,
  type DirectionsPlatform,
  directionsUrl,
  snapToEdge,
} from './putIn';

/** A ~0.02° square (~2 km) around `[lng0,lat0]` as a GeoJSON Polygon. */
function square(lat0: number, lng0: number, half = 0.01): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng0 - half, lat0 - half],
        [lng0 + half, lat0 - half],
        [lng0 + half, lat0 + half],
        [lng0 - half, lat0 + half],
        [lng0 - half, lat0 - half],
      ],
    ],
  };
}

describe('clusterPutIns', () => {
  it('collapses nearby points into a single marker at their centroid', () => {
    // Three points within a few metres of each other.
    const points: LatLng[] = [
      { lat: 44.0, lng: -72.0 },
      { lat: 44.00002, lng: -72.00002 },
      { lat: 43.99998, lng: -71.99998 },
    ];
    const clusters = clusterPutIns(points);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.reportCount).toBe(3);
    expect(clusters[0]?.coord.lat).toBeCloseTo(44.0, 4);
    expect(clusters[0]?.coord.lng).toBeCloseTo(-72.0, 4);
  });

  it('keeps far-apart points as separate markers', () => {
    const clusters = clusterPutIns([
      { lat: 44.0, lng: -72.0 },
      { lat: 44.5, lng: -72.5 },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.reportCount === 1)).toBe(true);
  });

  it('honours a custom merge distance', () => {
    // ~78 m apart at this latitude: merged under the 150 m default, split under 10 m.
    const points: LatLng[] = [
      { lat: 44.0, lng: -72.0 },
      { lat: 44.0007, lng: -72.0 },
    ];
    expect(clusterPutIns(points)).toHaveLength(1);
    expect(clusterPutIns(points, 10)).toHaveLength(2);
  });

  it('returns nothing for no points', () => {
    expect(clusterPutIns([])).toEqual([]);
  });

  it('exposes a sensible default merge distance', () => {
    expect(DEFAULT_PUTIN_MERGE_METERS).toBe(150);
  });
});

describe('snapToEdge', () => {
  const box = square(44.0, -72.0); // edges at ±0.01°

  it('pulls an interior point out to the nearest edge', () => {
    // A point just inside the west edge snaps to that edge (lng ≈ -72.01), keeping its latitude.
    const snapped = snapToEdge({ lat: 44.0, lng: -72.009 }, box);
    expect(snapped.lng).toBeCloseTo(-72.01, 4);
    expect(snapped.lat).toBeCloseTo(44.0, 4);
  });

  it('snaps a point close to the north edge onto that edge', () => {
    // (44.009,-72.0): 0.001° below the north edge (~111 m), but 0.01° from the E/W edges (~800 m),
    // so the north edge (lat 44.01) wins.
    const snapped = snapToEdge({ lat: 44.009, lng: -72.0 }, box);
    expect(snapped.lat).toBeCloseTo(44.01, 4);
    expect(snapped.lng).toBeCloseTo(-72.0, 4);
  });

  it('handles a MultiPolygon by snapping to the closest component', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square(44.0, -72.0).coordinates, square(44.0, -71.0).coordinates],
    };
    // Query nearer the eastern component snaps to it.
    const snapped = snapToEdge({ lat: 44.0, lng: -71.005 }, multi);
    expect(snapped.lng).toBeCloseTo(-71.01, 4);
  });

  it('tolerates a zero-length edge (a repeated consecutive vertex)', () => {
    // The first two vertices coincide, so one segment is degenerate (len² = 0) — must not divide by 0.
    const withDupe: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.01, 43.99],
          [-72.01, 43.99],
          [-71.99, 43.99],
          [-71.99, 44.01],
          [-72.01, 44.01],
          [-72.01, 43.99],
        ],
      ],
    };
    const snapped = snapToEdge({ lat: 43.995, lng: -72.02 }, withDupe);
    expect(Number.isFinite(snapped.lat)).toBe(true);
    expect(snapped.lng).toBeCloseTo(-72.01, 4);
  });

  it('returns the coord unchanged for a degenerate (edge-less) polygon', () => {
    const degenerate: Polygon = { type: 'Polygon', coordinates: [[[-72.0, 44.0]]] };
    const coord = { lat: 44.0, lng: -72.0 };
    expect(snapToEdge(coord, degenerate)).toEqual(coord);
  });

  it('lands the snapped point on the polygon boundary (≤1 m off)', () => {
    const snapped = snapToEdge({ lat: 44.005, lng: -72.004 }, box);
    // A point on/inside the boundary reads distance 0; the projection round-trip keeps it ≤1 m.
    expect(distanceToPolygonMeters(snapped, box)).toBeLessThan(1);
  });
});

describe('directionsUrl', () => {
  const coord = { lat: 44.25, lng: -72.5 };

  it('uses Apple Maps on iOS', () => {
    expect(directionsUrl(coord, 'ios')).toBe('https://maps.apple.com/?daddr=44.25,-72.5');
  });

  it('uses Google Maps on Android and web', () => {
    for (const platform of ['android', 'web'] as DirectionsPlatform[]) {
      expect(directionsUrl(coord, platform)).toBe(
        'https://www.google.com/maps/dir/?api=1&destination=44.25,-72.5',
      );
    }
  });
});
