import { describe, expect, it } from 'vitest';

import {
  crosswalkFor,
  crosswalkFromNdjson,
  crosswalkNhdId,
  crosswalkStats,
  MIDAS_FIELDS,
  MIDAS_SOURCE_KEY,
  type MidasRow,
  midasCrosswalk,
  midasQueryUrl,
  parseMidasRow,
} from './midasCrosswalk';

function row(over: Partial<MidasRow> & Pick<MidasRow, 'midas'>): MidasRow {
  return { lakeName: 'Mud Lake', acres: 100, permanentId: '142978563', ...over };
}

describe('parseMidasRow', () => {
  it('reads a real row', () => {
    expect(
      parseMidasRow({
        MIDAS_NUM: 1680,
        LAKENAME: 'Mud Lake',
        ACRES: 1002.41542566,
        PERMANENT_: '142978563',
        PERMID: '1002.41542566475',
        REACHCODE: '01010003000719',
        GNIS_NAME: 'Mud Lake',
      }),
    ).toEqual({
      midas: 1680,
      lakeName: 'Mud Lake',
      permanentId: '142978563',
      gnisName: 'Mud Lake',
      reachCode: '01010003000719',
      acres: 1002.41542566,
    });
  });

  it('never reads PERMID, which is a copy of ACRES wearing an identifier’s name', () => {
    // `PERMID: "1002.41542566475"` against `ACRES: 1002.41542566`. It is a string, so a join
    // written against it type-checks and runs and matches nothing. This is the whole reason the
    // column list is explicit.
    const parsed = parseMidasRow({
      MIDAS_NUM: 1680,
      ACRES: 1002.41542566,
      PERMANENT_: '142978563',
      PERMID: '1002.41542566475',
    });
    expect(parsed?.permanentId).toBe('142978563');
    expect(JSON.stringify(parsed)).not.toContain('1002.41542566475');
    expect(MIDAS_FIELDS).not.toContain('PERMID');
  });

  it('refuses a row with no MIDAS number, which has no key to be filed under', () => {
    expect(parseMidasRow({ LAKENAME: 'Nowhere Pond', PERMANENT_: 'x' })).toBeUndefined();
  });

  it('treats a blank permanent id as absent rather than as an empty key', () => {
    expect(parseMidasRow({ MIDAS_NUM: 5, PERMANENT_: '   ' })?.permanentId).toBeUndefined();
  });
});

describe('midasCrosswalk', () => {
  it('sorts bodies largest first and calls a single mapping confident', () => {
    const crosswalk = midasCrosswalk([row({ midas: 1680, acres: 1002 })]);
    expect(crosswalkFor(crosswalk, 1680)).toEqual({ permanentId: '142978563', confident: true });
  });

  it('stays confident through Moose Pond’s 0.0-acre residue', () => {
    // Five published rows, three of them zero acres. That is one real polygon plus bookkeeping, and
    // taking the largest is right — but the zero rows are kept so the row count still matches the
    // service's, which is how a republication is noticed.
    const crosswalk = midasCrosswalk([
      row({ midas: 3200, permanentId: 'A', acres: 1543 }),
      row({ midas: 3200, permanentId: 'B', acres: 0 }),
      row({ midas: 3200, permanentId: 'C', acres: 0 }),
      row({ midas: 3200, permanentId: 'D', acres: 0 }),
    ]);
    const entry = crosswalk.get(3200);
    expect(entry?.bodies.map((b) => b.permanentId)).toEqual(['A', 'B', 'C', 'D']);
    expect(entry?.ambiguous).toBe(true);
    expect(crosswalkFor(crosswalk, 3200)).toEqual({ permanentId: 'A', confident: true });
  });

  it('is NOT confident when one MIDAS number holds two real lakes', () => {
    // MIDAS 9861 holds Long Pond (651 ac) and Lewiston Pond (24 ac). Lewiston is 3.7% of Long —
    // small, and completely real. A caller that ignores `confident` here keys one lake's soundings
    // to the other.
    const crosswalk = midasCrosswalk([
      row({ midas: 9861, permanentId: 'long', lakeName: 'Long Pond', acres: 651 }),
      row({ midas: 9861, permanentId: 'lewiston', lakeName: 'Lewiston Pond', acres: 24 }),
    ]);
    expect(crosswalkFor(crosswalk, 9861)).toEqual({ permanentId: 'long', confident: false });
  });

  it('flags a name conflict, which is how a key spanning two bodies first shows up', () => {
    // MIDAS 1892 is `Harvey Pond` to Maine and `Umsaskis Lake` to the gazetteer — D95 rule 2's tell.
    const crosswalk = midasCrosswalk([
      row({ midas: 1892, lakeName: 'Harvey Pond', gnisName: 'Umsaskis Lake', acres: 2407 }),
    ]);
    expect(crosswalk.get(1892)?.nameConflict).toBe(true);
  });

  it('does not call a case difference a name conflict', () => {
    const crosswalk = midasCrosswalk([
      row({ midas: 7, lakeName: 'Mud Lake', gnisName: 'MUD LAKE' }),
    ]);
    expect(crosswalk.get(7)?.nameConflict).toBe(false);
  });

  it('keeps a MIDAS number NHD has never heard of, with an empty body list', () => {
    // Dropping it would make the coverage figure "what we could answer over what we could answer",
    // which is the misleading denominator this campaign has already corrected three times.
    const crosswalk = midasCrosswalk([
      row({ midas: 42, permanentId: undefined, lakeName: 'Unmapped Pond' }),
    ]);
    expect(crosswalk.get(42)?.bodies).toEqual([]);
    expect(crosswalkFor(crosswalk, 42)).toBeUndefined();
  });

  it('returns nothing for a MIDAS number the crosswalk has never seen', () => {
    expect(crosswalkFor(midasCrosswalk([]), 999)).toBeUndefined();
  });
});

describe('crosswalkStats', () => {
  it('counts the answerable, the unanswerable and the ambiguous apart', () => {
    const crosswalk = midasCrosswalk([
      row({ midas: 1, permanentId: 'a', acres: 100 }),
      row({ midas: 2, permanentId: undefined }),
      row({ midas: 3, permanentId: 'c', acres: 651, lakeName: 'Long Pond' }),
      row({ midas: 3, permanentId: 'd', acres: 24, lakeName: 'Lewiston Pond' }),
      row({ midas: 4, permanentId: 'e', lakeName: 'Harvey Pond', gnisName: 'Umsaskis Lake' }),
    ]);
    expect(crosswalkStats(crosswalk)).toEqual({
      rows: 4,
      midasNumbers: 4,
      withPermanentId: 3,
      withoutPermanentId: 1,
      ambiguous: 1,
      nameConflicts: 1,
    });
  });
});

describe('midasQueryUrl', () => {
  it('asks for the named fields, ordered, with no geometry', () => {
    const url = new URL(midasQueryUrl(0));
    expect(url.searchParams.get('outFields')).toBe(MIDAS_FIELDS.join(','));
    expect(url.searchParams.get('returnGeometry')).toBe('false');
    expect(url.searchParams.get('orderByFields')).toBe('MIDAS_NUM');
  });
});

describe('crosswalkNhdId — who may use the publisher’s id', () => {
  const xw = midasCrosswalk([
    row({ midas: 5271, permanentId: 'sebago', acres: 11_500, lakeName: 'Sebago Lake' }),
    row({ midas: 9861, permanentId: 'long', acres: 651, lakeName: 'Long Pond' }),
    row({ midas: 9861, permanentId: 'lewiston', acres: 24, lakeName: 'Lewiston Pond' }),
    row({ midas: 4242, permanentId: undefined, lakeName: 'Unmapped Pond' }),
  ]);

  it('hands over the id for a clean Maine key', () => {
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '5271' }, xw)).toEqual({
      nhdId: 'sebago',
    });
  });

  it('refuses every lane that does not key on MIDAS', () => {
    // NH keys on `au_id`, MA on `PALIS_ID`, VT on a lake name. A numeric collision with a MIDAS
    // number would otherwise attach a New Hampshire survey to a Maine lake.
    for (const sourceKey of [
      'nh-granit-contours',
      'ma-massgis-contours',
      'vt-anr-biobase-soundings',
    ]) {
      expect(crosswalkNhdId({ sourceKey, lakeKey: '5271' }, xw)).toEqual({ skip: 'not-maine' });
    }
  });

  it('refuses a key `splitByBody` has already cut in two', () => {
    // ⚠ The subtle one. By the time this is asked, the geometry has decided the key holds more than
    // one lake — so a single id is wrong for at least one half, and handing it over would attach the
    // whole survey to whichever half the state happened to name.
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '5271#1' }, xw)).toEqual({
      skip: 'split-key',
    });
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '5271#2' }, xw)).toEqual({
      skip: 'split-key',
    });
  });

  it('refuses a MIDAS number holding two real lakes', () => {
    // 9861 is Long Pond (651 ac) AND Lewiston Pond (24 ac). Sending the larger would be a coin toss
    // dressed as an id — and worse than geometry, which at least measures something.
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '9861' }, xw)).toEqual({
      skip: 'ambiguous',
    });
  });

  it('names the 192 MIDAS numbers NHD has never heard of', () => {
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '4242' }, xw)).toEqual({
      skip: 'no-id',
    });
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '99999' }, xw)).toEqual({
      skip: 'no-id',
    });
  });

  it('refuses a lake key that is not a number', () => {
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: 'North Pond' }, xw)).toEqual({
      skip: 'not-numeric',
    });
  });

  it('returns nothing usable against an empty crosswalk, and never throws', () => {
    // An unarchived crosswalk is a legitimate state: every non-Maine lane has always joined on
    // geometry alone, and a missing archive simply means Maine does too.
    expect(crosswalkNhdId({ sourceKey: MIDAS_SOURCE_KEY, lakeKey: '5271' }, new Map())).toEqual({
      skip: 'no-id',
    });
  });
});

describe('crosswalkFromNdjson', () => {
  it('reads the archive back, blank lines and all', () => {
    const ndjson = `${JSON.stringify(row({ midas: 1, permanentId: 'a' }))}\n\n${JSON.stringify(
      row({ midas: 2, permanentId: 'b' }),
    )}\n`;
    const xw = crosswalkFromNdjson(ndjson);
    expect([...xw.keys()].sort()).toEqual([1, 2]);
  });

  it('is empty for an empty file', () => {
    expect(crosswalkFromNdjson('').size).toBe(0);
  });
});
