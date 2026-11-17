import { describe, expect, it } from 'vitest';
import { type ReadFailure, readState } from '@/components/admin/reads/consoleReads';
import { MASCOMA_BAY_PROVENANCE, MASCOMA_SUB_AREAS, on } from '../../frame/bodyFixtures';
import { MASCOMA_POLYGON } from '../../frame/mascomaFixtures';
import {
  BAY_NOT_RECORDED,
  CAPPED_NONE,
  CAPPED_SOME,
  campaignText,
  NOT_COMPUTED_YET,
  shapeBays,
  shapeMapScene,
  shapeMerge,
  shapeMergeOf,
  shapeOutline,
  touchingNotComputed,
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
    // Nothing in the bays read and how each was made unread: no sub-line, never a guess.
    const bare = { _id: 'b', name: 'B', surfaceAreaSqM: 4047, removed: false };
    expect(shapeBays([bare])[0]?.sub).toBeNull();
    // Read, and none of it recorded for this bay: it says so.
    expect(shapeBays([bare], [])[0]?.sub).toBe(BAY_NOT_RECORDED);
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
  const pond = {
    id: 'k1',
    name: 'Crystal Lake',
    polygon: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
  };

  it('shows no block only when the test ran over everything near and found nothing', () => {
    expect(
      shapeMerge(
        { touchingBodyIds: [], touching: [], touchingCapped: false, geoComputedAt: 1 },
        [],
      ),
    ).toBeNull();
  });

  it('keeps the block, and says so, when the geometry isn’t computed yet or the test stopped short', () => {
    expect(
      shapeMerge(
        { touchingBodyIds: null, touching: null, touchingCapped: false, geoComputedAt: null },
        undefined,
      ),
    ).toEqual({
      touching: [],
      note: NOT_COMPUTED_YET,
    });
    expect(
      shapeMerge({ touchingBodyIds: [], touching: [], touchingCapped: true, geoComputedAt: 1 }, []),
    ).toEqual({
      touching: [],
      note: CAPPED_NONE,
    });
    expect(
      shapeMerge(
        { touchingBodyIds: ['k1'], touching: [], touchingCapped: true, geoComputedAt: 1 },
        [pond],
      )?.note,
    ).toBe(CAPPED_SOME);
  });

  it('lists each touching body, addressed for ?lit=, as its reads land', () => {
    const facts = {
      touchingBodyIds: ['k1'],
      touching: [],
      touchingCapped: false,
      geoComputedAt: 1,
    };
    expect(shapeMerge(facts, [pond])).toEqual({
      touching: [{ lit: 'neighbor:k1', id: 'k1', name: 'Crystal Lake' }],
      note: null,
    });
    expect(shapeMerge(facts, undefined)?.touching).toBeUndefined();
    const failed = shapeMerge(facts, failure);
    expect(failed?.touching).toBe(failure);
  });
});

describe('the touching read’s four answers (B01-3n)', () => {
  const failure: ReadFailure = { failed: true, pending: false, retry: () => {} };
  const of = (value: unknown) => shapeMergeOf(readState(value as never, touchingNotComputed));

  it('on its way: no block yet; failed: the failure, never none or not computed', () => {
    expect(of(undefined)).toBeUndefined();
    expect(of(failure)).toBe(failure);
  });

  it('a settled zero is a value — no block — never *not computed yet*', () => {
    expect(
      of({ touchingBodyIds: [], touching: [], touchingCapped: false, geoComputedAt: 1 }),
    ).toBeNull();
  });

  it('not computed is the nothing recorded, said in the block', () => {
    for (const facts of [
      { touchingBodyIds: null, touching: null, touchingCapped: false, geoComputedAt: null },
      { touchingBodyIds: [], touching: [], touchingCapped: false, geoComputedAt: null },
      { touchingBodyIds: null, touching: null, touchingCapped: false, geoComputedAt: 1 },
    ]) {
      expect(of(facts)).toEqual({ touching: [], note: NOT_COMPUTED_YET });
    }
  });

  it('a value names its neighbors from the read itself', () => {
    const merge = of({
      touchingBodyIds: ['k1'],
      touching: [{ waterBodyId: 'k1', name: 'Crystal Lake', ring: [[0, 0]] }],
      touchingCapped: false,
      geoComputedAt: 1,
    });
    expect(merge).toEqual({
      touching: [{ lit: 'neighbor:k1', id: 'k1', name: 'Crystal Lake' }],
      note: null,
    });
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
