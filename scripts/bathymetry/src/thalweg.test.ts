import { describe, expect, it } from 'vitest';
import {
  compressAlong,
  expandAlong,
  fromLocal,
  type LocalPoint,
  principalFrame,
  THALWEG_ANISOTROPY,
  toLocal,
} from './thalweg';

/** A cigar-shaped cloud along a bearing, at 45°N. */
function cigar(bearingRad: number, n = 40, lengthM = 4000, widthM = 300) {
  const mPerLng = 111_320 * Math.cos((45 * Math.PI) / 180);
  const points: { lng: number; lat: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1) - 0.5) * lengthM;
    const w = ((i % 5) / 4 - 0.5) * widthM;
    const x = t * Math.cos(bearingRad) - w * Math.sin(bearingRad);
    const y = t * Math.sin(bearingRad) + w * Math.cos(bearingRad);
    points.push({ lng: -70 + x / mPerLng, lat: 45 + y / 111_320 });
  }
  return points;
}

describe('principalFrame', () => {
  it('finds the long axis of an east–west lake', () => {
    const frame = principalFrame(cigar(0));
    expect(Math.abs(frame.angle)).toBeLessThan(0.05);
  });

  it('finds the long axis of a north–south lake', () => {
    const frame = principalFrame(cigar(Math.PI / 2));
    expect(Math.abs(Math.abs(frame.angle) - Math.PI / 2)).toBeLessThan(0.05);
  });

  it('finds a diagonal axis', () => {
    const frame = principalFrame(cigar(Math.PI / 4));
    expect(Math.abs(frame.angle - Math.PI / 4)).toBeLessThan(0.05);
  });

  it('measures the axis in metres, not degrees', () => {
    // At 45°N a degree of longitude is ~0.7 of a degree of latitude. Working in raw degrees would
    // make an east–west lake look ~40% longer than it is and pull the axis east–west on every lake
    // in the corpus. A square-in-METRES cloud has no preferred axis; a square-in-degrees one would.
    const mPerLng = 111_320 * Math.cos((45 * Math.PI) / 180);
    const square: { lng: number; lat: number }[] = [];
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 8; j += 1) {
        square.push({ lng: -70 + (i * 500) / mPerLng, lat: 45 + (j * 500) / 111_320 });
      }
    }
    const frame = principalFrame(square);
    // A metric square is isotropic, so its axis is degenerate — the round-trip block below is what
    // pins the transform. What this asserts is that the scale factor is derived from the cloud's own
    // centroid latitude rather than assumed, which is the part that would silently bias every lake.
    expect(Number.isFinite(frame.angle)).toBe(true);
    const expected = 111_320 * Math.cos((frame.originLat * Math.PI) / 180);
    expect(frame.mPerLng).toBeCloseTo(expected, 6);
    // And that it is meaningfully shorter than a degree of latitude at this latitude.
    expect(frame.mPerLng).toBeLessThan(111_320 * 0.75);
    expect(frame.mPerLng).toBeGreaterThan(mPerLng * 0.99);
  });

  it('survives an empty cloud rather than dividing by zero', () => {
    const frame = principalFrame([]);
    expect(Number.isFinite(frame.angle)).toBe(true);
  });
});

describe('toLocal / fromLocal', () => {
  const points = cigar(Math.PI / 5);
  const frame = principalFrame(points);

  it('round-trips every point to within a millimetre', () => {
    // A mismatch between the two directions would rotate and stretch every lake in the corpus by an
    // amount nobody would spot in a thumbnail.
    for (const p of points) {
      const back = fromLocal(toLocal(p, frame), frame);
      expect(back.lng).toBeCloseTo(p.lng, 9);
      expect(back.lat).toBeCloseTo(p.lat, 9);
    }
  });

  it('puts the long extent on the `along` axis', () => {
    const local = points.map((p) => toLocal(p, frame));
    const alongSpan =
      Math.max(...local.map((l) => l.along)) - Math.min(...local.map((l) => l.along));
    const acrossSpan =
      Math.max(...local.map((l) => l.across)) - Math.min(...local.map((l) => l.across));
    expect(alongSpan).toBeGreaterThan(acrossSpan * 5);
  });

  it('measures in metres', () => {
    const local = points.map((p) => toLocal(p, frame));
    const alongSpan =
      Math.max(...local.map((l) => l.along)) - Math.min(...local.map((l) => l.along));
    expect(alongSpan).toBeGreaterThan(3800);
    expect(alongSpan).toBeLessThan(4200);
  });
});

describe('compressAlong / expandAlong', () => {
  const local: LocalPoint = { along: 300, across: 100 };

  it('compresses only the along-axis coordinate', () => {
    const c = compressAlong(local, 4);
    expect(c.along).toBe(75);
    expect(c.across).toBe(100);
  });

  it('expands back to exactly the original', () => {
    expect(expandAlong(compressAlong(local, 4), 4)).toEqual(local);
    expect(expandAlong(compressAlong(local, 2.5), 2.5)).toEqual(local);
  });

  it('is the identity at ratio 1 — the isotropic behaviour it replaces', () => {
    expect(compressAlong(local, 1)).toEqual(local);
  });
});

describe('THALWEG_ANISOTROPY', () => {
  it('is greater than 1, or the whole transform is a no-op', () => {
    expect(THALWEG_ANISOTROPY).toBeGreaterThan(1);
  });
});
