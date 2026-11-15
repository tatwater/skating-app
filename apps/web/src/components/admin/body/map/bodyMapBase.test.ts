import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MASCOMA_BASE_INPUT } from '../frame/bodyFixtures';
import { MASCOMA_NORTH, MASCOMA_SOUTH } from '../frame/mascomaFixtures';
import { basinLabel, bodyMapBase } from './bodyMapBase';

describe('bodyMapBase', () => {
  it('addresses every item the way ?lit= does, and files it under its layer', () => {
    const scene = bodyMapBase({
      ...MASCOMA_BASE_INPUT,
      bays: [
        {
          id: 'bay-north',
          name: 'Mascoma North',
          polygon: MASCOMA_NORTH,
          mouth: { a: { lat: 1, lng: 2 }, b: { lat: 3, lng: 4 } },
        },
      ],
      samplePoints: [{ lat: 43.62, lng: -72.15 }],
    });
    const byId = new Map(scene.items.map((i) => [i.id, i]));
    expect(byId.get('body:j57mascoma0000000000000000000000')).toMatchObject({
      layer: 'outline',
      style: 'body',
    });
    expect(byId.get('bay:bay-north')).toMatchObject({ layer: 'bays', style: 'bay' });
    expect(byId.get('mouth:bay-north')).toMatchObject({
      kind: 'line',
      path: [
        [2, 1],
        [4, 3],
      ],
      style: 'mouth',
    });
    expect(byId.get('bay-name:bay-north')).toMatchObject({ kind: 'label', text: 'Mascoma North' });
    expect(byId.get('landmark:lm0')).toMatchObject({
      layer: 'marks',
      mark: 'island',
      name: 'Relham Island',
      hoverKicker: 'Island · OSM',
    });
    expect(byId.get('putIn:p1')).toMatchObject({
      layer: 'putIns',
      mark: 'putIn',
      name: 'Mascoma Lake Boat Launch',
    });
    expect(byId.get('lot:l0')).toMatchObject({ layer: 'putIns', mark: 'lot' });
    expect(byId.get('sample:0')).toMatchObject({ layer: 'samples', at: [-72.15, 43.62] });
    expect(new Set(scene.items.map((i) => i.id)).size).toBe(scene.items.length);
  });

  it('draws each body that touches this one as a quiet neighbor on the outline layer', () => {
    const scene = bodyMapBase({
      ...MASCOMA_BASE_INPUT,
      neighbors: [{ id: 'n1', name: 'Crystal Lake', polygon: MASCOMA_SOUTH }],
    });
    expect(scene.items.find((i) => i.id === 'neighbor:n1')).toMatchObject({
      kind: 'outline',
      layer: 'outline',
      style: 'neighbor',
      geometry: MASCOMA_SOUTH,
    });
    // None given (or none touching): nothing drawn.
    expect(bodyMapBase(MASCOMA_BASE_INPUT).items.some((i) => i.id.startsWith('neighbor:'))).toBe(
      false,
    );
  });

  it('names a landmark with no catalog by its kind alone', () => {
    const scene = bodyMapBase({
      ...MASCOMA_BASE_INPUT,
      landmarks: [{ id: 'x', name: 'Enfield', kind: 'settlement', point: { lat: 0, lng: 0 } }],
    });
    expect(scene.items.find((i) => i.id === 'landmark:x')).toMatchObject({ hoverKicker: 'Town' });
  });
});

describe('basinLabel', () => {
  it('runs Mascoma’s bays down their basins, northwest to southeast', () => {
    const north = basinLabel(MASCOMA_NORTH);
    const south = basinLabel(MASCOMA_SOUTH);
    // Screen degrees clockwise from east: both basins fall to the right, steeply.
    expect(north.angle).toBeGreaterThan(20);
    expect(north.angle).toBeLessThan(80);
    expect(south.angle).toBeGreaterThan(20);
    expect(south.angle).toBeLessThan(80);
    expect(north.at[1]).toBeGreaterThan(south.at[1]);
  });

  it('always reads left to right, and sits on the water (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0.001, max: 0.05, noNaN: true }),
        fc.double({ min: 0.001, max: 0.05, noNaN: true }),
        (tilt, w, h) => {
          const cx = -72;
          const cy = 43;
          const ring = [
            [cx - w, cy - h + tilt * w],
            [cx + w, cy - h - tilt * w],
            [cx + w, cy + h - tilt * w],
            [cx - w, cy + h + tilt * w],
            [cx - w, cy - h + tilt * w],
          ];
          const { angle, at } = basinLabel({ type: 'Polygon', coordinates: [ring] });
          expect(angle).toBeGreaterThan(-90);
          expect(angle).toBeLessThanOrEqual(90);
          expect(Math.abs(at[0] - cx)).toBeLessThan(w);
          expect(Math.abs(at[1] - cy)).toBeLessThan(h + Math.abs(tilt) * w);
        },
      ),
    );
  });

  it('reads a near-vertical basin as 90°, never the −90° rounding would carry it to', () => {
    // fast-check's counterexample: −89.96° rounded to a tenth was −90.0, out of (−90°, 90°].
    const [tilt, w, h] = [0.9130080365203957, 0.0018779228041964438, 0.010704908353208255];
    const ring = [
      [-72 - w, 43 - h + tilt * w],
      [-72 + w, 43 - h - tilt * w],
      [-72 + w, 43 + h - tilt * w],
      [-72 - w, 43 + h + tilt * w],
      [-72 - w, 43 - h + tilt * w],
    ];
    const { angle } = basinLabel({ type: 'Polygon', coordinates: [ring] });
    expect(angle).toBeGreaterThan(-90);
    expect(angle).toBeLessThanOrEqual(90);
  });

  it('falls back to a point on the water when the vertices’ mean is not', () => {
    // A crescent: its mean sits in the bite.
    const ring: GeoJSON.Position[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = (Math.PI * i) / 20;
      ring.push([Math.cos(t), Math.sin(t)]);
    }
    for (let i = 20; i >= 0; i--) {
      const t = (Math.PI * i) / 20;
      ring.push([0.8 * Math.cos(t), 0.8 * Math.sin(t)]);
    }
    ring.push([1, 0]);
    const { at } = basinLabel({ type: 'Polygon', coordinates: [ring] });
    const r = Math.hypot(at[0], at[1]);
    expect(r).toBeGreaterThanOrEqual(0.8 - 1e-6);
    expect(r).toBeLessThanOrEqual(1 + 1e-6);
  });
});
