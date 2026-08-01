import { describe, expect, it } from 'vitest';
import {
  compressAlong,
  effectiveAnisotropy,
  elongation,
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

describe('elongation', () => {
  it('is ~1 for a round cloud', () => {
    const round: { lng: number; lat: number }[] = [];
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      round.push({ lng: -70 + Math.cos(a) * 0.01, lat: 45 + (Math.sin(a) * 0.01) / 1.41 });
    }
    const frame = principalFrame(round);
    expect(elongation(round, frame)).toBeLessThan(1.4);
  });

  it('is high for a long straight lake', () => {
    const points = cigar(Math.PI / 6, 60, 6000, 400);
    expect(elongation(points, principalFrame(points))).toBeGreaterThan(3);
  });

  it('is LOW for a lake that bends — which is the property the cap relies on', () => {
    // A bend makes the cloud rounder, so a curved basin asks for less anisotropy on its own. That is
    // what stops a single straight axis being forced onto a lake that isn't straight.
    const bent: { lng: number; lat: number }[] = [];
    const mPerLng = 111_320 * Math.cos((45 * Math.PI) / 180);
    for (let i = 0; i < 60; i += 1) {
      const t = i / 59;
      const x = Math.cos(t * Math.PI) * 2000;
      const y = Math.sin(t * Math.PI) * 2000;
      bent.push({ lng: -70 + x / mPerLng, lat: 45 + y / 111_320 });
    }
    const straight = cigar(0, 60, 6000, 400);
    expect(elongation(bent, principalFrame(bent))).toBeLessThan(
      elongation(straight, principalFrame(straight)),
    );
  });

  it('never returns less than 1, so it can only ever relax the ratio', () => {
    expect(elongation([], principalFrame([]))).toBe(1);
    expect(elongation([{ lng: -70, lat: 45 }], principalFrame([{ lng: -70, lat: 45 }]))).toBe(1);
  });
});

describe('effectiveAnisotropy', () => {
  it("caps the configured ratio at the lake's own elongation", () => {
    // "Never assume more directionality than the shape exhibits."
    const points = cigar(0, 60, 4000, 1500);
    const frame = principalFrame(points);
    const measured = elongation(points, frame);
    expect(effectiveAnisotropy(points, frame, 8)).toBeCloseTo(measured, 6);
    expect(effectiveAnisotropy(points, frame, 8)).toBeLessThan(8);
  });

  it('does not raise a configured ratio below the elongation', () => {
    const points = cigar(0, 60, 6000, 300);
    const frame = principalFrame(points);
    expect(effectiveAnisotropy(points, frame, 1.5)).toBeCloseTo(1.5, 6);
  });

  it('lands at 1 for a round pond — isotropic, which is right for a basin with no axis', () => {
    const round: { lng: number; lat: number }[] = [];
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      round.push({ lng: -70 + Math.cos(a) * 0.01, lat: 45 + (Math.sin(a) * 0.01) / 1.41 });
    }
    const frame = principalFrame(round);
    expect(effectiveAnisotropy(round, frame, 4)).toBeLessThan(1.4);
  });

  it('never goes below 1, which would invert the anisotropy', () => {
    const points = cigar(0, 60, 4000, 400);
    expect(effectiveAnisotropy(points, principalFrame(points), 0.2)).toBe(1);
  });
});

describe('THALWEG_ANISOTROPY', () => {
  it('is greater than 1, or the whole transform is a no-op', () => {
    expect(THALWEG_ANISOTROPY).toBeGreaterThan(1);
  });
});
