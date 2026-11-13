import { describe, expect, it } from 'vitest';

import { MASCOMA_SUB_AREAS } from '../../frame/bodyFixtures';
import { MASCOMA_POLYGON } from '../../frame/mascomaFixtures';
import { campaignText, shapeBays, shapeMapScene, shapeOutline, vertexCount } from './shapeModel';

describe('the outline', () => {
  it('writes its source out and counts its rings and vertices', () => {
    expect(
      shapeOutline({ polygon: MASCOMA_POLYGON, source: 'osm', lastCampaignId: 'a07a-20261012' }),
    ).toEqual({
      source: { name: 'OpenStreetMap', tag: 'OSM' },
      rings: 'The shore and 3 islands',
      vertices: '234 vertices',
      lastImport: '12 Oct campaign',
    });
  });

  it('prefers whose polygon it is over where the row came from', () => {
    expect(
      shapeOutline({ polygon: MASCOMA_POLYGON, source: 'osm', geometrySource: 'nhd' }).source,
    ).toEqual({
      name: 'National Hydrography Dataset',
      tag: 'NHD',
    });
    expect(shapeOutline({ polygon: MASCOMA_POLYGON, source: 'mystery' }).source).toEqual({
      name: 'mystery',
      tag: 'MYSTERY',
    });
  });

  it('draws no last import for a body no campaign has touched', () => {
    expect(shapeOutline({ polygon: MASCOMA_POLYGON, source: 'user' }).lastImport).toBeNull();
  });

  it('counts vertices without each ring’s closing repeat', () => {
    expect(
      vertexCount({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    ).toBe(3);
  });

  it('reads a campaign’s date, else its id', () => {
    expect(campaignText('n7-3-20260809')).toBe('9 Aug campaign');
    expect(campaignText('a07a-20260917')).toBe('17 Sep campaign');
    expect(campaignText('seed')).toBe('seed');
    expect(campaignText('x-20261340')).toBe('x-20261340');
  });
});

describe('the bays', () => {
  it('lists the listed bays in whole acres, addressed for ?lit=', () => {
    expect(shapeBays(MASCOMA_SUB_AREAS)).toEqual([
      { id: 'bay:bay-north', name: 'Mascoma North', acres: '612', sub: null, attention: null },
      { id: 'bay:bay-south', name: 'Mascoma South', acres: '531', sub: null, attention: null },
    ]);
  });

  it('leaves a removed bay to History, and says what waits on a person', () => {
    const rows = shapeBays([
      { _id: 'a', name: 'A', surfaceAreaSqM: 4047, removed: true },
      { _id: 'b', name: 'B', surfaceAreaSqM: 4047, removed: false, mouth: {}, mouthStale: 'islet' },
      {
        _id: 'c',
        name: 'C',
        surfaceAreaSqM: 4047,
        removed: false,
        mouth: {},
        mouthReview: { outcome: 'kept' },
      },
    ]);
    expect(rows.map((r) => [r.id, r.sub, r.attention])).toEqual([
      ['bay:b', 'Drawn by chord', 'Its chord no longer fits the shore'],
      ['bay:c', 'Drawn by chord', 'A re-fit waits on a person'],
    ]);
  });
});

describe('the map', () => {
  it('draws nothing of its own but lights a lit bay', () => {
    expect(shapeMapScene(null, 'bay:x')).toEqual({ items: [], lit: 'bay:x' });
    expect(shapeMapScene(null, 'ask:x')).toEqual({ items: [], lit: null });
    expect(shapeMapScene(null, null)).toEqual({ items: [], lit: null });
  });
});
