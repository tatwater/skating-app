import { describe, expect, it } from 'vitest';
import { buildShapePreview, type PreviewShape } from './shapePreview';

const square = (lng: number, lat: number, size: number): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + size, lat],
      [lng + size, lat + size],
      [lng, lat + size],
      [lng, lat],
    ],
  ],
});

const shape = (key: string, geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): PreviewShape => ({
  key,
  geometry,
});

/**
 * The preview's whole job is that two outlines which are one lake look like one outline. Everything
 * below guards the two ways that can lie: a per-shape transform (which would draw a difference that
 * isn't there) and a stretched fit (which would hide one that is).
 */
describe('buildShapePreview', () => {
  it('gives identical outlines identical path data', () => {
    const { paths } = buildShapePreview([
      shape('a', square(-71.2, 43.7, 0.01)),
      shape('b', square(-71.2, 43.7, 0.01)),
    ]);
    expect(paths[0]?.d).toBe(paths[1]?.d);
    expect(paths[0]?.d).toMatch(/^M[\d.,]+(L[\d.,]+)+Z$/);
  });

  it('projects both shapes with ONE transform, so a real offset stays visible', () => {
    const { paths } = buildShapePreview([
      shape('a', square(-71.2, 43.7, 0.01)),
      shape('b', square(-71.15, 43.7, 0.01)),
    ]);
    expect(paths[0]?.d).not.toBe(paths[1]?.d);
  });

  it('keeps every point inside the frame', () => {
    const { paths, width, height } = buildShapePreview(
      [shape('a', square(-71.2, 43.7, 0.02)), shape('b', square(-71.19, 43.71, 0.005))],
      { width: 300, height: 180 },
    );
    for (const path of paths) {
      for (const point of path.d.replace(/[MLZ]/g, ' ').trim().split(/\s+/)) {
        const [x, y] = point.split(',').map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
    }
  });

  it('preserves aspect — a square lake never renders as a rectangle', () => {
    const { paths } = buildShapePreview([shape('a', square(-71.2, 43.7, 0.01))], {
      width: 400,
      height: 100,
    });
    const points = (paths[0]?.d ?? '')
      .replace(/[MLZ]/g, ' ')
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number));
    const xs = points.map((p) => p[0] ?? 0);
    const ys = points.map((p) => p[1] ?? 0);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // A degree of longitude is shorter than a degree of latitude at 43.7°N, so the drawn square is
    // narrower than it is tall — by cos(lat), and by nothing else.
    expect(w / h).toBeCloseTo(Math.cos(43.705 * (Math.PI / 180)), 2);
  });

  it('draws every ring of a MultiPolygon, holes included', () => {
    const multi: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square(-71.2, 43.7, 0.01).coordinates, square(-71.18, 43.7, 0.005).coordinates],
    };
    const { paths } = buildShapePreview([shape('a', multi)]);
    expect((paths[0]?.d.match(/M/g) ?? []).length).toBe(2);
  });

  it('returns an empty path rather than throwing on a degenerate outline', () => {
    const { paths } = buildShapePreview([shape('a', { type: 'Polygon', coordinates: [] })]);
    expect(paths[0]?.d).toBe('');
  });
});
