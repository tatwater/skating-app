import { describe, expect, it } from 'vitest';
import {
  bodyLabel,
  type ComparableBody,
  compareBodies,
  describeAgreement,
  differingFieldCount,
} from './bodyCompare';

/**
 * The merge card is the last thing between a moderator and an irreversible re-pointing of every
 * report on a lake, so these tests are all about the table not *understating* a difference — a row
 * that reads as agreement when one side is silent, or a shared blank counted as a disagreement, both
 * make the "N differences" headline a lie in the direction that gets a merge waved through.
 */

function body(overrides: Partial<ComparableBody> = {}): ComparableBody {
  return {
    _id: 'a',
    name: 'Duncan Lake',
    type: 'lakePond',
    source: 'osm',
    centroid: { lat: 43.7, lng: -71.2 },
    bbox: { minLat: 43.69, minLng: -71.21, maxLat: 43.71, maxLng: -71.19 },
    dedupStatus: 'near_certain',
    createdAt: Date.UTC(2026, 7, 1),
    ...overrides,
  };
}

const rowFor = (rows: ReturnType<typeof compareBodies>, key: string) => {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
};

describe('compareBodies', () => {
  it('treats a value on one side against silence on the other as a difference', () => {
    const rows = compareBodies([body({ nhdId: '141034051' }), body({ _id: 'b' })]);
    const nhd = rowFor(rows, 'nhdId');
    expect(nhd.values).toEqual(['141034051', null]);
    expect(nhd.differs).toBe(true);
    expect(nhd.empty).toBe(false);
  });

  it('never calls a shared silence a difference', () => {
    const rows = compareBodies([body(), body({ _id: 'b' })]);
    const depth = rowFor(rows, 'meanDepthM');
    expect(depth.empty).toBe(true);
    expect(depth.differs).toBe(false);
  });

  it('reads an absent geometrySource as the import source, so the two never look apart', () => {
    const rows = compareBodies([body({ geometrySource: 'osm' }), body({ _id: 'b' })]);
    expect(rowFor(rows, 'geometrySource').differs).toBe(false);
  });

  it('counts only genuine disagreements', () => {
    const rows = compareBodies([
      body({ osmId: 'way/46908853', surfaceAreaSqM: 342_537 }),
      body({ _id: 'b', osmId: 'relation/13068809', surfaceAreaSqM: 342_537 }),
    ]);
    // osmId differs; area is identical; everything else is a shared blank or a shared value.
    expect(differingFieldCount(rows)).toBe(1);
    expect(rowFor(rows, 'surfaceAreaSqM').differs).toBe(false);
  });

  it('formats area in acres and lengths in metres — the units the corpus rules are written in', () => {
    const rows = compareBodies([body({ surfaceAreaSqM: 342_537.25, longAxisM: 1234.6 })]);
    expect(rowFor(rows, 'surfaceAreaSqM').values[0]).toBe('84.6 acres');
    expect(rowFor(rows, 'longAxisM').values[0]).toBe('1,235 m');
  });

  it('leaves the name cell empty for an unnamed body rather than inventing one', () => {
    const rows = compareBodies([body({ name: '' }), body({ _id: 'b', name: 'Duncan Lake' })]);
    expect(rowFor(rows, 'name').values).toEqual([null, 'Duncan Lake']);
    expect(rowFor(rows, 'name').differs).toBe(true);
  });
});

describe('bodyLabel', () => {
  it('says so when a body has no name — 37 of the first hundred in this queue have none', () => {
    expect(bodyLabel({ name: '' })).toBe('(unnamed)');
    expect(bodyLabel({ name: '   ' })).toBe('(unnamed)');
    expect(bodyLabel({ name: 'Bowers Pond' })).toBe('Bowers Pond');
  });
});

describe('describeAgreement', () => {
  it('describes the geometry without ever returning a verdict', () => {
    const text = describeAgreement({ iou: 0.94, centroidDistanceM: 12, areaRatio: 1.0 });
    expect(text).toBe('94% overlap · centres 12 m apart · same area');
    expect(text).not.toMatch(/duplicate/i);
  });

  it('switches to kilometres once the centres are far apart, and names the area gap', () => {
    expect(describeAgreement({ iou: null, centroidDistanceM: 4200, areaRatio: 4.13 })).toBe(
      'centres 4.2 km apart · one is 4.13× the other',
    );
  });
});
