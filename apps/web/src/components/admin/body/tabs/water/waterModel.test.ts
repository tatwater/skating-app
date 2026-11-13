import { describe, expect, it } from 'vitest';

import { CHAMPLAIN_WATER, MASCOMA_BBOX, MASCOMA_WATER } from './waterFixtures';
import {
  acrossKm,
  depthFigure,
  depthOf,
  formatLatLng,
  isEstimate,
  samplingNote,
  sourceWords,
  waterFrom,
  waterMapDrawing,
} from './waterModel';

describe('depthOf', () => {
  it('makes one rung of a source that gave both measurements', () => {
    expect(
      depthOf({
        name: 'Mascoma Lake',
        meanDepthM: 9.4,
        maxDepthM: 24,
        meanDepthSource: 'state_agency',
        maxDepthSource: 'state_agency',
      }),
    ).toEqual({
      rungs: [{ source: 'state_agency', mean: 9.4, max: 24 }],
      meanFrom: 'state_agency',
      maxFrom: 'state_agency',
    });
  });

  it('ranks the candidates with the winners, best first, and drops a source that offers nothing', () => {
    const depth = depthOf({ name: 'x', maxDepthM: 22, maxDepthSource: 'osm_tag' }, [
      { source: 'hydrolakes_modeled', mean: 8.1, max: null },
      { source: 'lagos_us', mean: null, max: 23 },
      { source: 'globathy', mean: null, max: null },
    ]);
    expect(depth.rungs.map((r) => r.source)).toEqual(['lagos_us', 'hydrolakes_modeled', 'osm_tag']);
    expect([depth.meanFrom, depth.maxFrom]).toEqual([null, 'osm_tag']);
  });

  it('never calls a rejected measurement (a rung with no number) the one in use', () => {
    const depth = depthOf({ name: 'x', meanDepthSource: 'operator' });
    expect(depth).toEqual({ rungs: [], meanFrom: null, maxFrom: null });
  });
});

describe('the words', () => {
  it('names each source as the ladder does, with a note where the name would mislead', () => {
    expect(sourceWords('state_agency', 'NH')).toEqual({ name: 'NH state survey', note: null });
    expect(sourceWords('state_agency', null).name).toBe('State survey');
    expect(sourceWords('hydrolakes_modeled', null)).toEqual({
      name: 'HydroLAKES',
      note: 'Modeled · an estimate',
    });
    expect(sourceWords('hydrolakes_reported', null).note).toBe('From its reported volume');
    expect(sourceWords('globathy', null).note).toBe('Modeled · an estimate');
    expect(sourceWords('operator', null)).toEqual({ name: 'A moderator', note: 'Entered by hand' });
    expect(sourceWords('lagos_us', null).name).toBe('LAGOS-US DEPTH');
    expect(sourceWords('osm_tag', null).name).toBe('OpenStreetMap');
  });

  it('reads a modeled source as an estimate, a measured one plainly', () => {
    expect(isEstimate('hydrolakes_modeled')).toBe(true);
    expect(isEstimate('state_agency')).toBe(false);
  });

  it('writes depths to a tenth under ten meters, whole above', () => {
    expect([depthFigure(9.43), depthFigure(24.2), depthFigure(10)]).toEqual(['9.4', '24', '10']);
  });

  it('writes a point with its hemispheres', () => {
    expect(formatLatLng({ lat: 43.617368, lng: -72.136006 })).toBe('43.6174°N 72.1360°W');
    expect(formatLatLng({ lat: -1, lng: 2 })).toBe('1.0000°S 2.0000°E');
  });
});

describe('sampling', () => {
  it('measures the box as the sample-cell rule does', () => {
    expect(acrossKm(MASCOMA_BBOX)).toBeCloseTo(4.9, 1);
  });

  it('reads the default point, the hand-set grid and the width off the record', () => {
    const data = waterFrom({
      name: 'Mascoma Lake',
      states: ['NH'],
      interiorPoint: { lat: 43.6, lng: -72.1 },
      weatherSamplePoints: [],
      bbox: MASCOMA_BBOX,
    });
    expect(data.sampling).toEqual({
      interior: { lat: 43.6, lng: -72.1 },
      points: null,
      acrossKm: expect.closeTo(4.9, 1),
      wide: false,
    });
    expect([data.state, data.bathymetry]).toEqual(['NH', null]);
    const bare = waterFrom({ name: 'x' });
    expect([bare.sampling.acrossKm, bare.sampling.wide, bare.box, bare.state]).toEqual([
      null,
      false,
      null,
      null,
    ]);
  });

  it('says why the body has the points it has', () => {
    expect(samplingNote('Mascoma Lake', MASCOMA_WATER.sampling)).toMatch(
      /^Mascoma Lake is 4.9 km across.*a second point is offered only on a body wider than that\.$/,
    );
    expect(samplingNote('Lake Champlain', CHAMPLAIN_WATER.sampling)).toMatch(/at each end\.$/);
    expect(samplingNote('x', { ...MASCOMA_WATER.sampling, acrossKm: null })).toBeNull();
  });
});

describe('waterMapDrawing', () => {
  it('draws the interior point with its plate, and the box’s two spans', () => {
    const d = waterMapDrawing(MASCOMA_WATER, 'sample:interior');
    expect(d.points).toEqual([
      {
        id: 'sample:interior',
        mark: 'sample-point',
        at: MASCOMA_WATER.sampling.interior,
        label: 'Interior point',
        caption: 'Weather samples here',
        lit: true,
      },
    ]);
    expect(d.boxes).toEqual([{ id: 'bbox', box: MASCOMA_BBOX, ew: '4.9 KM', ns: '4.9 KM' }]);
    expect(d.lit).toBe('sample:interior');
  });

  it('draws a hand-set grid in place of the interior point; nothing without either', () => {
    const d = waterMapDrawing(CHAMPLAIN_WATER, 'depth:osm_tag');
    expect(d.points.map((p) => p.label)).toEqual([
      'Sample point 1',
      'Sample point 2',
      'Sample point 3',
    ]);
    expect(d.lit).toBeNull();
    const none = waterMapDrawing(
      { ...MASCOMA_WATER, box: null, sampling: { ...MASCOMA_WATER.sampling, interior: null } },
      null,
    );
    expect(none).toEqual({ points: [], boxes: [], lit: null });
  });
});
