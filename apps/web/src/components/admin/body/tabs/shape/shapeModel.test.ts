import { describe, expect, it } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { MASCOMA_BAY_PROVENANCE, MASCOMA_SUB_AREAS, on } from '../../frame/bodyFixtures';
import { MASCOMA_POLYGON } from '../../frame/mascomaFixtures';
import {
  CAPPED_NONE,
  CAPPED_SOME,
  campaignText,
  NOT_CHECKED,
  shapeBays,
  shapeMapScene,
  shapeMerge,
  shapeOutline,
  vertexCount,
} from './shapeModel';

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
  it('lists the listed bays in whole acres, addressed for ?lit=, each saying how it was made', () => {
    expect(shapeBays(MASCOMA_SUB_AREAS, MASCOMA_BAY_PROVENANCE)).toEqual([
      {
        id: 'bay:bay-north',
        name: 'Mascoma North',
        acres: '612',
        sub: 'Seeded · 2 Sep · Teagan',
        attention: null,
      },
      {
        id: 'bay:bay-south',
        name: 'Mascoma South',
        acres: '531',
        sub: 'Seeded · 2 Sep · Teagan',
        attention: null,
      },
    ]);
  });

  it('gives a bay under an acre its tenth — never a zero for water that is there', () => {
    const small = { _id: 's', name: 'Cove', surfaceAreaSqM: 1700, removed: false };
    expect(shapeBays([small])[0]?.acres).toBe('0.4');
  });

  it('says only the day while how each was made is unread, and each way in its own words', () => {
    expect(shapeBays(MASCOMA_SUB_AREAS).map((b) => b.sub)).toEqual([
      'Added · 2 Sep',
      'Added · 2 Sep',
    ]);
    const bay = { _id: 'a', name: 'A', surfaceAreaSqM: 4047, removed: false, createdAt: on(10, 1) };
    const made = (createdVia: 'chord' | 'drawn' | 'catalog' | null, createdBy = null) => [
      { subAreaId: 'a' as never, createdAt: on(10, 1), createdVia, createdBy },
    ];
    expect(shapeBays([bay], made('chord'))[0]?.sub).toBe('Drawn by chord · 1 Oct');
    expect(shapeBays([bay], made('drawn'))[0]?.sub).toBe('Drawn · 1 Oct');
    expect(shapeBays([bay], made('catalog'))[0]?.sub).toBe('From the catalog · 1 Oct');
    // No creating row: a chord's stored mouth still says how; else only when.
    expect(shapeBays([bay], made(null))[0]?.sub).toBe('Added · 1 Oct');
    expect(shapeBays([{ ...bay, mouth: {} }], made(null))[0]?.sub).toBe('Drawn by chord · 1 Oct');
    // Nothing recorded at all: no sub-line, never a guess.
    expect(
      shapeBays([{ _id: 'b', name: 'B', surfaceAreaSqM: 4047, removed: false }])[0]?.sub,
    ).toBeNull();
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

describe('merge', () => {
  const failure: ReadFailure = { failed: true, pending: false, retry: () => {} };
  const pond = { id: 'k1', name: 'Crystal Lake', polygon: MASCOMA_POLYGON };

  it('shows no block only when the test ran over everything near and found nothing', () => {
    expect(shapeMerge({ touchingBodyIds: [], touchingCapped: false }, [])).toBeNull();
  });

  it('keeps the block, and says so, when the test couldn’t run or stopped short', () => {
    expect(shapeMerge({ touchingBodyIds: null, touchingCapped: false }, undefined)).toEqual({
      touching: [],
      note: NOT_CHECKED,
    });
    expect(shapeMerge({ touchingBodyIds: [], touchingCapped: true }, [])).toEqual({
      touching: [],
      note: CAPPED_NONE,
    });
    expect(shapeMerge({ touchingBodyIds: ['k1'], touchingCapped: true }, [pond])?.note).toBe(
      CAPPED_SOME,
    );
  });

  it('lists each touching body, addressed for ?lit=, as its reads land', () => {
    const facts = { touchingBodyIds: ['k1'], touchingCapped: false };
    expect(shapeMerge(facts, [pond])).toEqual({
      touching: [{ lit: 'neighbor:k1', id: 'k1', name: 'Crystal Lake' }],
      note: null,
    });
    expect(shapeMerge(facts, undefined)?.touching).toBeUndefined();
    const failed = shapeMerge(facts, failure);
    expect(failed?.touching).toBe(failure);
  });
});

describe('the map', () => {
  it('draws nothing of its own but lights a lit bay or neighbor', () => {
    expect(shapeMapScene(null, 'bay:x')).toEqual({ items: [], lit: 'bay:x' });
    expect(shapeMapScene(null, 'neighbor:x')).toEqual({ items: [], lit: 'neighbor:x' });
    expect(shapeMapScene(null, 'ask:x')).toEqual({ items: [], lit: null });
    expect(shapeMapScene(null, null)).toEqual({ items: [], lit: null });
  });
});
