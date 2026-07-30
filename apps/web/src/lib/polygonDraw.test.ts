import { describe, expect, it } from 'vitest';
import { parsePastedPolygon } from './polygonDraw';
import { boundsForBody } from './waterMap';

/** A ring the parser should accept in any of the three wrappers people actually paste. */
const RING = [
  [-73.2, 44.2],
  [-73.0, 44.2],
  [-73.0, 44.4],
  [-73.2, 44.4],
  [-73.2, 44.2],
];
const POLYGON = { type: 'Polygon', coordinates: [RING] };

describe('parsePastedPolygon', () => {
  it('accepts a bare geometry', () => {
    const result = parsePastedPolygon(JSON.stringify(POLYGON));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.polygon.type).toBe('Polygon');
  });

  it('accepts a Feature and a one-feature FeatureCollection', () => {
    // All three wrappers are things people paste; insisting on the right one would be pedantry at
    // the exact moment someone is working around a broken draw control.
    const feature = { type: 'Feature', properties: {}, geometry: POLYGON };
    expect(parsePastedPolygon(JSON.stringify(feature)).ok).toBe(true);
    expect(
      parsePastedPolygon(JSON.stringify({ type: 'FeatureCollection', features: [feature] })).ok,
    ).toBe(true);
  });

  it('accepts a MultiPolygon — a bay with an island is two rings', () => {
    const result = parsePastedPolygon(
      JSON.stringify({ type: 'MultiPolygon', coordinates: [[RING]] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.polygon.type).toBe('MultiPolygon');
  });

  it('rejects a non-areal geometry by name, so the operator knows what they pasted', () => {
    const result = parsePastedPolygon(JSON.stringify({ type: 'LineString', coordinates: RING }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/LineString/);
  });

  it('rejects junk and a multi-feature collection rather than guessing', () => {
    expect(parsePastedPolygon('not json').ok).toBe(false);
    expect(parsePastedPolygon('42').ok).toBe(false);
    const two = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: POLYGON },
        { type: 'Feature', properties: {}, geometry: POLYGON },
      ],
    };
    // Two shapes is ambiguous, and picking one silently is how the wrong bay gets saved.
    expect(parsePastedPolygon(JSON.stringify(two)).ok).toBe(false);
  });
});

describe('boundsForBody', () => {
  it('pads a bbox by a fraction of its own extent, so the lock frames the lake', () => {
    const [[minLng, minLat], [maxLng, maxLat]] = boundsForBody(
      { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      0.1,
    );
    expect(minLng).toBeCloseTo(-73.6, 6);
    expect(maxLng).toBeCloseTo(-72.4, 6);
    expect(minLat).toBeCloseTo(43.9, 6);
    expect(maxLat).toBeCloseTo(45.1, 6);
  });

  it('scales the margin with the body — a cove and a great lake both get usable context', () => {
    const cove = boundsForBody({ minLat: 44.0, minLng: -73.5, maxLat: 44.01, maxLng: -73.49 });
    const great = boundsForBody({ minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 });
    const covePad = cove[1][0] - -73.49;
    const greatPad = great[1][0] - -72.5;
    expect(covePad).toBeLessThan(greatPad);
    expect(covePad).toBeGreaterThan(0);
  });

  it('survives a degenerate bbox rather than producing bounds MapLibre rejects', () => {
    const [[minLng, minLat], [maxLng, maxLat]] = boundsForBody({
      minLat: 44,
      minLng: -73,
      maxLat: 44,
      maxLng: -73,
    });
    expect(maxLng).toBeGreaterThan(minLng);
    expect(maxLat).toBeGreaterThan(minLat);
  });
});
