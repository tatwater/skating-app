import { describe, expect, it } from 'vitest';
import { silhouetteProjection } from './bodySilhouette';
import { compassRing, MIN_RING_RADIUS_PX, onRing, ringSectorAtXY } from './compassRing';

const bbox = { minLat: 43.6, maxLat: 43.7, minLng: -72.2, maxLng: -72.1 };
const origin = { lat: 43.65, lng: -72.15 };

describe('compassRing', () => {
  it('draws eight arcs around the origin, N centered at the top', () => {
    const p = silhouetteProjection(bbox, 400, 400, 12);
    const ring = compassRing(p, origin);
    expect(ring).not.toBeNull();
    if (!ring) return;
    expect(ring.segments).toHaveLength(8);
    expect(ring.segments[0]?.sector).toBe('N');
    const [cx, cy] = p.toXY([origin.lng, origin.lat]);
    expect(ring.cx).toBeCloseTo(cx);
    expect(ring.cy).toBeCloseTo(cy);
    // The N label sits straight above the center; the S label straight below.
    const n = ring.segments[0]?.label as [number, number];
    const s = ring.segments[4]?.label as [number, number];
    expect(n[0]).toBeCloseTo(cx, 5);
    expect(n[1]).toBeLessThan(cy);
    expect(s[0]).toBeCloseTo(cx, 5);
    expect(s[1]).toBeGreaterThan(cy);
    // Each arc is a path with one arc command and ends short of the next by the gap.
    for (const seg of ring.segments) expect(seg.d).toMatch(/^M [\d.]+ [\d.]+ A /);
  });

  it('fits inside the drawing and leaves room for the labels', () => {
    const p = silhouetteProjection(bbox, 300, 200, 12);
    const ring = compassRing(p, origin);
    if (!ring) throw new Error('expected a ring');
    for (const seg of ring.segments) {
      expect(seg.label[0]).toBeGreaterThanOrEqual(0);
      expect(seg.label[1]).toBeGreaterThanOrEqual(0);
      expect(seg.label[0]).toBeLessThanOrEqual(300);
      expect(seg.label[1]).toBeLessThanOrEqual(200);
    }
  });

  it('is null when the origin is too close to an edge for the smallest ring', () => {
    const p = silhouetteProjection(bbox, 400, 400, 12);
    // An origin at the very top of the bbox.
    expect(compassRing(p, { lat: bbox.maxLat, lng: -72.15 })).toBeNull();
    expect(compassRing(p, origin, { radius: MIN_RING_RADIUS_PX - 1 })).toBeNull();
    expect(compassRing(p, origin, { radius: MIN_RING_RADIUS_PX })).not.toBeNull();
  });

  it('reads the sector from the bearing, the same cut as the wedges', () => {
    const ring = { cx: 100, cy: 100, r: 50 };
    expect(ringSectorAtXY(ring, [100, 40])).toBe('N');
    expect(ringSectorAtXY(ring, [160, 100])).toBe('E');
    expect(ringSectorAtXY(ring, [100, 160])).toBe('S');
    expect(ringSectorAtXY(ring, [40, 100])).toBe('W');
    expect(ringSectorAtXY(ring, [140, 60])).toBe('NE');
    expect(ringSectorAtXY(ring, [60, 140])).toBe('SW');
  });

  it('knows the arc from the water inside it', () => {
    const ring = { cx: 100, cy: 100, r: 50 };
    expect(onRing(ring, [100, 52])).toBe(true);
    expect(onRing(ring, [100, 45])).toBe(true);
    expect(onRing(ring, [100, 100])).toBe(false);
    expect(onRing(ring, [100, 30])).toBe(false);
  });
});
