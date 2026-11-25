import { HAZARD_MAX_VERTICES, hazardFootprint } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEATURE_BAND_M,
  DEFAULT_FEATURE_RADIUS_M,
  FEATURE_SIZE_MAX_M,
  FEATURE_SIZE_MIN_M,
  featureModeBar,
  featurePreview,
  featureReason,
  featureSavedTitle,
  featureShape,
  featureTaskHeading,
  featureTaskNote,
  redrawTarget,
  saveBlocker,
  sizeField,
  sizeOf,
  startFeatureDraft,
  startRedrawDraft,
  withPaste,
  withPoint,
  withTraced,
  withWay,
} from './featureDraft';

const AT = { lat: 43.63, lng: -72.16 };
const LINE: GeoJSON.LineString = {
  type: 'LineString',
  coordinates: [
    [-72.16, 43.63],
    [-72.15, 43.64],
  ],
};
const RING: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.16, 43.63],
      [-72.15, 43.63],
      [-72.15, 43.64],
      [-72.16, 43.63],
    ],
  ],
};
const MULTI: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [RING.coordinates] };
const BOX = { minLat: 43.63, minLng: -72.16, maxLat: 43.64, maxLng: -72.15 };

describe('a new feature', () => {
  it('starts as a spring, a point, with the old editor’s radius and nothing placed', () => {
    const d = startFeatureDraft();
    expect(d).toMatchObject({
      way: 'point',
      type: 'spring_current',
      radius: String(DEFAULT_FEATURE_RADIUS_M),
      band: String(DEFAULT_FEATURE_BAND_M),
      geometry: null,
    });
    expect(featureTaskHeading(d)).toBe('New known feature');
    expect(featureTaskNote(d)).toMatch(/every winter, without fading/);
    expect(saveBlocker(d)).toBe('The point isn’t placed yet');
    expect(featureModeBar(d)).toEqual({ mode: 'Feature mode', line: 'Click where it is.' });
    expect(featurePreview(d)).toBeNull();
    expect(sizeField(d)).toBe('radius');
  });

  it('a placed point saves with its radius, and previews as its circle', () => {
    const d = withPoint(startFeatureDraft(), AT);
    expect(saveBlocker(d)).toBeNull();
    const shape = featureShape(d);
    expect(shape).toEqual({
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [AT.lng, AT.lat] },
      radiusMeters: 30,
    });
    expect(featurePreview(d)).toEqual(hazardFootprint(shape as never));
    expect(featureModeBar(d).line).toMatch(/Drag the mark/);
  });

  it('a radius out of bounds waits, and previews the bare point', () => {
    for (const radius of ['0', '', 'x', String(FEATURE_SIZE_MAX_M + 1)]) {
      const d = { ...withPoint(startFeatureDraft(), AT), radius };
      expect(saveBlocker(d)).toBe('The radius is 1 to 5,000 m');
      expect(featureShape(d)).toBeNull();
      expect(featurePreview(d)).toEqual({ type: 'Point', coordinates: [AT.lng, AT.lat] });
    }
  });

  it('a line saves with its band, and previews as the corridor', () => {
    const d = withTraced(withWay(startFeatureDraft(), 'line'), LINE);
    expect(sizeField(d)).toBe('band');
    expect(featureShape(d)).toEqual({ geometryKind: 'line', geometry: LINE, bufferMeters: 15 });
    expect(featurePreview(d)?.type).toBe('Polygon');
    const short = withTraced(d, {
      type: 'LineString',
      coordinates: [
        [-72.16, 43.63],
        [-72.16, 43.63],
      ],
    });
    expect(saveBlocker(short)).toBe('A line needs two different points');
    expect(featurePreview(short)?.type).toBe('LineString');
    expect(saveBlocker({ ...d, band: '9000' })).toBe('The band is 1 to 5,000 m');
  });

  it('an outline saves as it is, with no size, and a bowtie waits', () => {
    const d = withTraced(withWay(startFeatureDraft(), 'polygon'), RING);
    expect(sizeField(d)).toBeNull();
    expect(featureShape(d)).toEqual({ geometryKind: 'polygon', geometry: RING });
    expect(featurePreview(d)).toEqual(RING);
    const bowtie: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    expect(saveBlocker(withTraced(d, bowtie))).toMatch(/can’t cross itself/);
  });

  it('a shape past the position cap waits, by its count', () => {
    const long: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: Array.from({ length: HAZARD_MAX_VERTICES + 1 }, (_, i) => [i / 1e4, 0]),
    };
    expect(saveBlocker(withTraced(withWay(startFeatureDraft(), 'line'), long))).toBe(
      `A known feature is at most ${HAZARD_MAX_VERTICES} points`,
    );
  });

  it('changing the way starts the shape over and keeps the fields', () => {
    const d = { ...withPoint(startFeatureDraft(), AT), type: 'gas_hole' as const, note: 'Delta' };
    const line = withWay(d, 'line');
    expect(line.session).not.toBe(d.session);
    expect(line).toMatchObject({ way: 'line', geometry: null, type: 'gas_hole', note: 'Delta' });
    expect(saveBlocker(line)).toBe('Nothing drawn yet');
    expect(withWay(line, 'line')).toBe(line);
  });

  it('the draw engine failing points to the paste', () => {
    const d = { ...withWay(startFeatureDraft(), 'polygon'), unavailable: true };
    expect(featureModeBar(d).line).toMatch(/Paste the outline/);
    expect(featureModeBar({ ...d, way: 'line' }).line).toMatch(/Paste the line/);
  });

  it('the mode bar says what each way wants next', () => {
    const polygon = withWay(startFeatureDraft(), 'polygon');
    expect(featureModeBar(polygon).line).toMatch(/click the first point again/);
    expect(featureModeBar(withTraced(polygon, RING)).line).toMatch(/middle of an edge/);
    const line = withWay(startFeatureDraft(), 'line');
    expect(featureModeBar(line).line).toMatch(/click the last point again/);
    expect(featureModeBar(withTraced(line, LINE)).line).toMatch(/middle of a stretch/);
    const paste = withWay(startFeatureDraft(), 'paste');
    expect(featureModeBar(paste).line).toBe('Paste a shape in the panel.');
    expect(featureModeBar(withPaste(paste, JSON.stringify(RING))).line).toMatch(/as it will be/);
  });

  it('its reason and receipt name the type', () => {
    const d = { ...startFeatureDraft(), type: 'gas_hole' as const };
    expect(featureReason(d)).toBe('Authored by hand: Gas hole.');
    expect(featureSavedTitle(d)).toBe('Known feature added · Gas hole');
  });
});

describe('the paste', () => {
  const paste = (text: string) => withPaste(withWay(startFeatureDraft(), 'paste'), text);

  it('takes an outline, a multi-part outline or a line, bare or in a Feature', () => {
    expect(featureShape(paste(JSON.stringify(RING)))?.geometryKind).toBe('polygon');
    expect(featureShape(paste(JSON.stringify(MULTI)))?.geometryKind).toBe('polygon');
    const line = paste(JSON.stringify({ type: 'Feature', geometry: LINE, properties: {} }));
    expect(sizeField(line)).toBe('band');
    expect(featureShape(line)).toEqual({ geometryKind: 'line', geometry: LINE, bufferMeters: 15 });
  });

  it('says why a paste isn’t a shape, before anything else', () => {
    expect(saveBlocker(paste('{'))).toBe('That isn’t valid JSON.');
    expect(saveBlocker(paste('{}'))).toBe('There’s no geometry in that.');
    expect(saveBlocker(paste('{"type":"Point","coordinates":[0,0]}'))).toBe(
      'A known feature is pasted as a Polygon, a MultiPolygon or a LineString, not a Point.',
    );
    const cleared = withPaste(paste('{'), '  ');
    expect(cleared.refusal).toBeNull();
    expect(saveBlocker(cleared)).toBe('Nothing pasted yet');
  });
});

describe('a redraw', () => {
  const row = {
    _id: 'f1',
    type: 'spring_current',
    bbox: BOX,
  };

  it('opens a point on its own mark and radius, framed on its box', () => {
    const d = startRedrawDraft(
      redrawTarget({
        ...row,
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [AT.lng, AT.lat] },
        radiusMeters: 60,
      }),
    );
    expect(d).toMatchObject({ way: 'point', radius: '60', focus: { bbox: BOX } });
    expect(saveBlocker(d)).toBeNull();
    expect(featureTaskHeading(d)).toBe('Redraw · Spring / current');
    expect(featureTaskNote(d)).toBe('The new shape replaces the old one.');
    expect(featureModeBar(d).mode).toBe('Redraw');
    expect(featureReason(d)).toBe('Redrawn by hand: Spring / current.');
    expect(featureSavedTitle(d)).toBe('Shape redrawn · Spring / current');
  });

  it('opens a line on its own line and band; going back to its way puts the line back', () => {
    const d = startRedrawDraft(
      redrawTarget({ ...row, geometryKind: 'line', geometry: LINE, bufferMeters: 40 }),
    );
    expect(d).toMatchObject({ way: 'line', geometry: LINE, band: '40' });
    const point = withWay(d, 'point');
    expect(point.geometry).toBeNull();
    expect(withWay(point, 'line').geometry).toEqual(LINE);
  });

  it('opens an outline to edit, keeping the band it had', () => {
    const d = startRedrawDraft(
      redrawTarget({ ...row, geometryKind: 'polygon', geometry: RING, bufferMeters: 5 }),
    );
    expect(featureShape(d)).toEqual({ geometryKind: 'polygon', geometry: RING, bufferMeters: 5 });
    // As a point instead: a radius, no band.
    expect(featureShape(withPoint(withWay(d, 'point'), AT))).toMatchObject({
      geometryKind: 'point_radius',
      radiusMeters: DEFAULT_FEATURE_RADIUS_M,
    });
  });

  it('a feature in several parts is drawn again from nothing, and says so', () => {
    const d = startRedrawDraft(redrawTarget({ ...row, geometryKind: 'polygon', geometry: MULTI }));
    expect(d).toMatchObject({ way: 'polygon', geometry: null });
    expect(featureTaskNote(d)).toMatch(/several parts/);
    expect(featureTaskNote(withWay(d, 'point'))).toBe('The new shape replaces the old one.');
  });

  it('a type the labels don’t know is named as stored; no box, no framing', () => {
    const t = redrawTarget({
      _id: 'f2',
      type: 'mystery',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    expect(t.label).toBe('mystery');
    expect(startRedrawDraft(t)).toMatchObject({
      radius: String(DEFAULT_FEATURE_RADIUS_M),
      focus: null,
    });
  });
});

describe('sizeOf', () => {
  it('takes exactly the meters the server takes, from the floor to the ceiling', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (m) => {
        const got = sizeOf(String(m));
        const inside = Number.isFinite(m) && m >= FEATURE_SIZE_MIN_M && m <= FEATURE_SIZE_MAX_M;
        expect(got).toBe(inside ? m : null);
      }),
    );
    expect(sizeOf('  ')).toBeNull();
  });
});
