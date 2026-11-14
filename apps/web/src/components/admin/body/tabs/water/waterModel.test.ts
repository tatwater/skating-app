import { describe, expect, it } from 'vitest';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
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
  waterMapScene,
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
      // The other sources' offers aren't stored: not recorded, never "none".
      others: null,
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
    expect(depth.others).toBe('kept');
  });

  it('never calls a rejected measurement (a rung with no number) the one in use', () => {
    const depth = depthOf({ name: 'x', meanDepthSource: 'operator' });
    expect(depth).toEqual({ rungs: [], meanFrom: null, maxFrom: null, others: null });
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
    const data = waterFrom(
      {
        name: 'Mascoma Lake',
        states: ['NH'],
        interiorPoint: { lat: 43.6, lng: -72.1 },
        weatherSamplePoints: [],
        bbox: MASCOMA_BBOX,
      },
      undefined,
    );
    expect(data.sampling).toEqual({
      interior: { lat: 43.6, lng: -72.1 },
      points: null,
      acrossKm: expect.closeTo(4.9, 1),
      wide: false,
    });
    expect([data.state, data.bathymetry]).toEqual(['NH', undefined]);
    const bare = waterFrom({ name: 'x' }, undefined);
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

describe('the bathymetry state', () => {
  it('says whether contour lines were drawn; their lack is the record’s gap', () => {
    expect(waterFrom({ name: 'x' }, { hasBathymetry: true }).bathymetry).toEqual({
      searched: null,
      found: 'Contour lines drawn',
      missing: false,
    });
    expect(waterFrom({ name: 'x' }, { hasBathymetry: false }).bathymetry).toMatchObject({
      found: 'No contour lines',
      missing: true,
    });
  });

  it('keeps the read’s state: loading stays loading, a failure is named', () => {
    expect(waterFrom({ name: 'x' }, undefined).failures).toEqual([]);
    const failed = waterFrom({ name: 'x' }, FAILED_READ);
    expect(failed.bathymetry).toBe(FAILED_READ);
    expect(failed.failures).toEqual(['the bathymetry state']);
  });
});

describe('waterMapScene', () => {
  it('adds the interior point and the box’s two spans, with Samples on', () => {
    const scene = waterMapScene(MASCOMA_WATER, 'sample:interior');
    expect(scene.items.map((i) => i.id)).toEqual([
      'sample:interior',
      'dimension:ew',
      'measure:ew',
      'dimension:ns',
      'measure:ns',
    ]);
    expect(scene.items[0]).toMatchObject({
      kind: 'point',
      mark: 'sample',
      layer: 'samples',
      at: [-72.136005675, 43.617368284786984],
      name: 'Interior point',
    });
    expect(scene.items[2]).toMatchObject({ text: '4.9 km', style: 'measure' });
    expect(scene.items[4]).toMatchObject({ text: '4.9 km', angle: -90 });
    expect(scene.lit).toBe('sample:interior');
    expect(scene.layers).toEqual({ samples: true });
  });

  it('leaves a hand-set grid to the frame, keeping its lit point; nothing without either', () => {
    const scene = waterMapScene(CHAMPLAIN_WATER, 'sample:2');
    expect(scene.items.some((i) => i.kind === 'point')).toBe(false);
    expect(scene.lit).toBe('sample:2');
    expect(waterMapScene(CHAMPLAIN_WATER, 'depth:osm_tag').lit).toBeNull();
    const none = waterMapScene(
      { ...MASCOMA_WATER, box: null, sampling: { ...MASCOMA_WATER.sampling, interior: null } },
      null,
    );
    expect(none).toEqual({ items: [], lit: null, layers: { samples: true } });
  });
});
