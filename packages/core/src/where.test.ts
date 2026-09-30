import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BAY_SECTORS, COMPASS_SECTORS, SECTORS, WHERE_EXTENTS } from './types';
import {
  describeLocatedChip,
  describeSighting,
  describeWhere,
  isCompassSector,
  validateWhere,
  WHERE_KINDS,
  WHERE_POINT_RADIUS_MAX_M,
  WHERE_POINT_RADIUS_MIN_M,
  type Where,
  type WhereValidationError,
  whereCoversBody,
  whereKind,
  whereOverlaps,
} from './where';

function validate(where: Where): { normalized: Where | null; fields: string[] } {
  const errors: WhereValidationError[] = [];
  const normalized = validateWhere(where, 'w', errors);
  return { normalized, fields: errors.map((e) => e.field) };
}

describe('validateWhere', () => {
  it('keeps a landmark point’s id and name, and refuses an id with no name or an overlong name', () => {
    const errors: WhereValidationError[] = [];
    expect(
      validateWhere(
        {
          point: {
            coord: { lat: 44.5, lng: -73.3 },
            radiusMeters: 75,
            name: '  Apple   Island ',
            landmarkId: ' lm1 ',
          },
        },
        'w',
        errors,
      ),
    ).toEqual({
      point: {
        coord: { lat: 44.5, lng: -73.3 },
        radiusMeters: 75,
        name: 'Apple Island',
        landmarkId: 'lm1',
      },
    });
    expect(
      validateWhere(
        { point: { coord: { lat: 44.5, lng: -73.3 }, radiusMeters: 75, landmarkId: 'lm1' } },
        'w',
        errors,
      ),
    ).toBeNull();
    expect(
      validateWhere(
        { point: { coord: { lat: 44.5, lng: -73.3 }, radiusMeters: 75, name: 'x'.repeat(81) } },
        'w',
        errors,
      ),
    ).toBeNull();
    expect(errors.map((e) => e.field)).toEqual(['w.point.name', 'w.point.name']);
  });

  it('accepts each part alone and any composition of them', () => {
    expect(validate({ extent: 'patches' }).normalized).toEqual({ extent: 'patches' });
    expect(validate({ subAreaId: ' sa1 ' }).normalized).toEqual({ subAreaId: 'sa1' });
    expect(validate({ sector: 'NW' }).normalized).toEqual({ sector: 'NW' });
    const point = { coord: { lat: 44.5, lng: -73.2 }, radiusMeters: 150, name: ' the point ' };
    expect(validate({ point }).normalized).toEqual({
      point: { coord: { lat: 44.5, lng: -73.2 }, radiusMeters: 150, name: 'the point' },
    });
    // "Patches, north end of Malletts Bay" — the composition D193 exists for.
    expect(validate({ extent: 'patches', subAreaId: 'sa1', sector: 'N' }).normalized).toEqual({
      extent: 'patches',
      subAreaId: 'sa1',
      sector: 'N',
    });
  });

  it('rejects an empty where — the whole body is spelled by absence', () => {
    const { normalized, fields } = validate({});
    expect(normalized).toBeNull();
    expect(fields).toEqual(['w']);
  });

  it('rejects unknown extents and sectors', () => {
    expect(validate({ extent: 'some' as never }).fields).toEqual(['w.extent']);
    expect(validate({ sector: 'up' as never }).fields).toEqual(['w.sector']);
  });

  it('head and mouth need a bay', () => {
    for (const sector of BAY_SECTORS) {
      expect(validate({ sector }).fields).toEqual(['w.sector']);
      expect(validate({ sector, subAreaId: 'sa1' }).normalized).toEqual({
        sector,
        subAreaId: 'sa1',
      });
      // A whitespace id is no id.
      expect(validate({ sector, subAreaId: '  ' }).fields).toEqual(['w.subAreaId', 'w.sector']);
    }
  });

  it('bounds the point radius and validates the coordinate', () => {
    const coord = { lat: 44, lng: -73 };
    expect(
      validate({ point: { coord, radiusMeters: WHERE_POINT_RADIUS_MIN_M } }).normalized,
    ).not.toBeNull();
    expect(
      validate({ point: { coord, radiusMeters: WHERE_POINT_RADIUS_MAX_M } }).normalized,
    ).not.toBeNull();
    expect(validate({ point: { coord, radiusMeters: 0 } }).fields).toEqual([
      'w.point.radiusMeters',
    ]);
    expect(
      validate({ point: { coord, radiusMeters: WHERE_POINT_RADIUS_MAX_M + 1 } }).fields,
    ).toEqual(['w.point.radiusMeters']);
    expect(validate({ point: { coord, radiusMeters: Number.NaN } }).fields).toEqual([
      'w.point.radiusMeters',
    ]);
    expect(validate({ point: { coord: { lat: 91, lng: 0 }, radiusMeters: 10 } }).fields).toEqual([
      'w.point.coord',
    ]);
    expect(validate({ point: { coord: undefined as never, radiusMeters: 10 } }).fields).toEqual([
      'w.point.coord',
    ]);
  });

  it('drops an empty point name', () => {
    expect(
      validate({ point: { coord: { lat: 44, lng: -73 }, radiusMeters: 10, name: '  ' } })
        .normalized,
    ).toEqual({ point: { coord: { lat: 44, lng: -73 }, radiusMeters: 10 } });
  });

  it('every legal composition of extent × sector round-trips (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...WHERE_EXTENTS), { nil: undefined }),
        fc.option(fc.constantFrom(...SECTORS), { nil: undefined }),
        fc.boolean(),
        (extent, sector, withBay) => {
          const where: Where = {};
          if (extent !== undefined) where.extent = extent;
          if (sector !== undefined) where.sector = sector;
          if (withBay) where.subAreaId = 'sa1';
          const { normalized, fields } = validate(where);
          const empty = extent === undefined && sector === undefined && !withBay;
          const bayNeeded =
            sector !== undefined && (BAY_SECTORS as readonly string[]).includes(sector) && !withBay;
          if (empty || bayNeeded) {
            expect(normalized).toBeNull();
            expect(fields.length).toBeGreaterThan(0);
          } else {
            expect(normalized).toEqual(where);
            expect(fields).toEqual([]);
          }
        },
      ),
    );
  });
});

describe('whereKind', () => {
  it('finest grain wins', () => {
    expect(whereKind({ extent: 'whole' })).toBe('whole');
    expect(whereKind({ subAreaId: 'sa1' })).toBe('subArea');
    expect(whereKind({ subAreaId: 'sa1', sector: 'N' })).toBe('sector');
    expect(
      whereKind({ sector: 'N', point: { coord: { lat: 44, lng: -73 }, radiusMeters: 10 } }),
    ).toBe('point');
    expect(WHERE_KINDS).toEqual(['whole', 'subArea', 'sector', 'point']);
  });
});

describe('isCompassSector', () => {
  it('is true for exactly the eight wedges', () => {
    for (const s of SECTORS) {
      expect(isCompassSector(s)).toBe((COMPASS_SECTORS as readonly string[]).includes(s));
    }
  });
});

describe('describeWhere / describeLocatedChip (A10 / D193, §12.1)', () => {
  const bays = { bay1: 'Malletts Bay' };
  it('composes extent, sector and bay the way a skater says it', () => {
    expect(describeWhere({ sector: 'N' })).toBe('north end');
    expect(describeWhere({ extent: 'patches', sector: 'N', subAreaId: 'bay1' }, bays)).toBe(
      'patches north end of Malletts Bay',
    );
    expect(describeWhere({ sector: 'head', subAreaId: 'bay1' }, bays)).toBe(
      'the head of Malletts Bay',
    );
    expect(describeWhere({ sector: 'near_shore' })).toBe('near shore');
    expect(describeWhere({ extent: 'large_areas', sector: 'NE' })).toBe(
      'large areas northeast end',
    );
    expect(describeWhere({ subAreaId: 'bay1' }, bays)).toBe('Malletts Bay');
    expect(
      describeWhere({
        point: { coord: { lat: 44, lng: -73 }, radiusMeters: 50, name: 'Shelburne Point' },
      }),
    ).toBe('near Shelburne Point');
  });
  it('leaves a bay unsaid rather than showing an id, and says nothing for `whole`', () => {
    expect(describeWhere({ subAreaId: 'bay1' })).toBe('');
    expect(describeWhere({ sector: 'N', subAreaId: 'gone' }, bays)).toBe('north end');
    expect(describeWhere({ extent: 'whole' })).toBe('');
  });
  it('a sighting reads as its state, then where — never as the whole lake when it named a part (D210)', () => {
    expect(describeSighting({ type: 'open', where: { sector: 'S' } })).toBe(
      'Still open, south end',
    );
    expect(describeSighting({ type: 'frozen', where: { subAreaId: 'bay1' } }, bays)).toBe(
      'Frozen over, Malletts Bay',
    );
    // The feed card has no bay names; an unnamed map tap has no words either.
    expect(describeSighting({ type: 'frozen', where: { subAreaId: 'bay1' } })).toBe(
      'Frozen over, part of the lake',
    );
    expect(
      describeSighting({
        type: 'skim',
        where: { point: { coord: { lat: 44, lng: -73 }, radiusMeters: 50 } },
      }),
    ).toBe('Skim ice, part of the lake');
    expect(describeSighting({ type: 'open' })).toBe('Still open');
    expect(describeSighting({ type: 'open', where: { extent: 'whole' } })).toBe('Still open');
  });
  it('a chip reads as its type, then where — the type alone when the where says nothing', () => {
    expect(describeLocatedChip({ type: 'black_ice', where: { sector: 'N' } })).toBe(
      'Black ice, north end',
    );
    expect(describeLocatedChip({ type: 'black_ice', where: { extent: 'whole' } })).toBe(
      'Black ice',
    );
    expect(describeLocatedChip({ type: 'black_ice' })).toBe('Black ice');
  });
});

describe('whereOverlaps / whereCoversBody (A10 §12.2)', () => {
  it('absent overlaps everything; a bay overlaps itself and a bay-less claim; wedges only themselves', () => {
    expect(whereOverlaps(undefined, { sector: 'N' })).toBe(true);
    expect(whereOverlaps({ subAreaId: 'a' }, { subAreaId: 'b' })).toBe(false);
    expect(whereOverlaps({ subAreaId: 'a' }, { sector: 'N' })).toBe(true);
    // A wedge in a bay and a wedge on the body are two frames: the bay's north can be the lake's
    // south, so they are "cannot tell", not "no".
    expect(whereOverlaps({ subAreaId: 'a', sector: 'N' }, { sector: 'S' })).toBe(true);
    expect(whereOverlaps({ subAreaId: 'a', sector: 'N' }, { subAreaId: 'a', sector: 'S' })).toBe(
      false,
    );
    expect(whereOverlaps({ sector: 'N' }, { sector: 'N' })).toBe(true);
    expect(whereOverlaps({ sector: 'N' }, { sector: 'S' })).toBe(false);
    expect(whereOverlaps({ sector: 'middle' }, { sector: 'N' })).toBe(false);
    expect(whereOverlaps({ sector: 'near_shore' }, { sector: 'N' })).toBe(true);
    expect(whereOverlaps({ sector: 'head', subAreaId: 'a' }, { sector: 'N', subAreaId: 'a' })).toBe(
      true,
    );
    expect(
      whereOverlaps({ extent: 'patches', sector: 'N' }, { extent: 'whole', sector: 'N' }),
    ).toBe(true);
  });
  it('a claim covers the body unless it names a place or says large areas or patches', () => {
    expect(whereCoversBody(undefined)).toBe(true);
    expect(whereCoversBody({ extent: 'mostly' })).toBe(true);
    expect(whereCoversBody({ extent: 'large_areas' })).toBe(false);
    expect(whereCoversBody({ extent: 'patches' })).toBe(false);
    expect(whereCoversBody({ sector: 'N' })).toBe(false);
    expect(whereCoversBody({ subAreaId: 'a' })).toBe(false);
  });
});
