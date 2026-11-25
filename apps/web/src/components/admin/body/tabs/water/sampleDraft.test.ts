import {
  DEFAULT_SAMPLE_SPACING_KM,
  MAX_SUGGESTED_SAMPLE_POINTS,
  pointInPolygon,
  suggestSamplePoints,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  SAMPLE_SPACING_MAX_KM,
  SAMPLE_SPACING_MIN_KM,
  sampleGeometry,
  sampleModeBar,
  sampleSavedTitle,
  sampleSummary,
  spacingBlocker,
  spacingOf,
  startSampleDraft,
  suggest,
} from './sampleDraft';

/** A box about 33 km by 24 km at 43.5°N. */
const WIDE: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.3, 43.4],
      [-72.0, 43.4],
      [-72.0, 43.7],
      [-72.3, 43.7],
      [-72.3, 43.4],
    ],
  ],
};
/** Two specks at a wide box's far corners, which a centered grid falls between. */
const square = (lng: number, lat: number) => [
  [
    [lng, lat],
    [lng + 0.001, lat],
    [lng + 0.001, lat + 0.001],
    [lng, lat + 0.001],
    [lng, lat],
  ],
];
const SLIVER: GeoJSON.MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [square(-72.3, 43.4), square(-72.001, 43.699)],
};
const BOX = { minLat: 43.4, minLng: -72.3, maxLat: 43.7, maxLng: -72.0 };
const STORED = [{ lat: 43.5, lng: -72.1 }];

describe('the suggested grid', () => {
  it('opens on core’s grid at the default spacing, expecting the points stored, framed on the box', () => {
    const d = startSampleDraft(WIDE, STORED, BOX);
    expect(d.spacing).toBe(String(DEFAULT_SAMPLE_SPACING_KM));
    expect(d.points).toEqual(suggestSamplePoints(WIDE, DEFAULT_SAMPLE_SPACING_KM).points);
    expect(d.points.length).toBeGreaterThan(1);
    expect(d.expected).toEqual(STORED);
    expect(d.expected).not.toBe(STORED);
    expect(d.focus).toEqual({ bbox: BOX });
    expect(sampleSummary(d)).toBe(`${d.points.length} points on the water, 11 km apart.`);
    expect(sampleModeBar(d)).toEqual({
      mode: 'Sample points',
      line: 'The hollow rings are the suggestion. Save them to sample there.',
    });
    expect(sampleGeometry(d)).toEqual({
      type: 'MultiPoint',
      coordinates: d.points.map((p) => [p.lng, p.lat]),
    });
  });

  it('suggests again at a new spacing, a new session that keeps the view', () => {
    const d = startSampleDraft(WIDE, [], null);
    const again = suggest({ ...d, spacing: '20' }, WIDE);
    expect(again.session).not.toBe(d.session);
    expect(again.km).toBe(20);
    expect(again.points.length).toBeLessThan(d.points.length);
    expect(again.focus).toBeNull();
    // The summary names the grid's spacing, not a number typed since.
    expect(sampleSummary({ ...again, spacing: '3' })).toMatch(/20 km apart/);
  });

  it('a spacing it doesn’t take holds the grid and says why', () => {
    const d = startSampleDraft(WIDE, [], null);
    for (const spacing of ['', '0', '0.5', '101', 'x']) {
      const typed = { ...d, spacing };
      expect(suggest(typed, WIDE)).toBe(typed);
      expect(spacingBlocker(typed)).toBe('The spacing is 1 to 100 km');
    }
    expect(spacingBlocker(d)).toBeNull();
  });

  it('a grid that misses the water is one point, and says so', () => {
    const d = startSampleDraft(SLIVER, [], null);
    expect(d.fellBack).toBe(true);
    expect(d.points).toHaveLength(1);
    expect(sampleSummary(d)).toMatch(/No grid point landed on the water/);
    expect(sampleModeBar(d).line).toMatch(/The hollow ring is/);
  });

  it('a grid cut short says it is the most a body carries', () => {
    const d = suggest({ ...startSampleDraft(WIDE, [], null), spacing: '1' }, WIDE);
    expect(d.truncated).toBe(true);
    expect(d.points).toHaveLength(MAX_SUGGESTED_SAMPLE_POINTS);
    expect(sampleSummary(d)).toMatch(/the most a body can carry/);
  });

  it('every suggested point is on the water, at any spacing it takes', () => {
    fc.assert(
      fc.property(fc.integer({ min: SAMPLE_SPACING_MIN_KM, max: SAMPLE_SPACING_MAX_KM }), (km) => {
        const d = suggest({ ...startSampleDraft(WIDE, [], null), spacing: String(km) }, WIDE);
        expect(d.points.length).toBeGreaterThan(0);
        expect(d.points.length).toBeLessThanOrEqual(MAX_SUGGESTED_SAMPLE_POINTS);
        for (const p of d.points) expect(pointInPolygon(p, WIDE)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  it('spacingOf takes exactly the bounds', () => {
    expect(spacingOf(String(SAMPLE_SPACING_MIN_KM))).toBe(SAMPLE_SPACING_MIN_KM);
    expect(spacingOf(String(SAMPLE_SPACING_MAX_KM))).toBe(SAMPLE_SPACING_MAX_KM);
    expect(spacingOf(' ')).toBeNull();
  });

  it('the receipt says what was saved', () => {
    expect(sampleSavedTitle(STORED)).toBe('Sample points set · 1');
    expect(sampleSavedTitle([])).toBe('Sample points cleared');
  });
});
