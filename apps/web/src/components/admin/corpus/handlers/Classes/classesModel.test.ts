import { describe, expect, it } from 'vitest';

import {
  GROTON,
  GROTON_DECIDED,
  GROTON_MIXED,
  GROTON_NOT_RECORDED,
  GROTON_REFUSED,
} from './classesFixtures';
import {
  type ClassesItem,
  catalogColumns,
  catalogRows,
  consequenceParts,
  defaultPick,
  depthWords,
  headLine,
  leverOf,
  nameWords,
  nearestOf,
  nearestWords,
  offsetWords,
  raisedAgainNote,
  refusalSaid,
  rungMarks,
  tokenText,
} from './classesModel';

describe('the pick', () => {
  it('opens on the suggestion, and sets it', () => {
    expect(defaultPick(GROTON)).toBe('wetland');
    expect(leverOf(GROTON, 'wetland')).toEqual({
      verb: 'setClass',
      bodyClass: 'wetland',
      label: 'Set as Wetland',
    });
    expect(leverOf(GROTON, 'lakePond')).toEqual({
      verb: 'keepClass',
      bodyClass: 'lakePond',
      label: 'Keep as Lake or pond',
    });
  });

  it('opens on the class now when nothing is suggested (the claims not recorded)', () => {
    expect(defaultPick(GROTON_NOT_RECORDED)).toBe('lakePond');
  });

  it('skips a suggestion whose verb is refused, and draws nothing once decided', () => {
    const noSet = { ...GROTON, can: { keepClass: null, setClass: 'Not yours.' } } as ClassesItem;
    expect(defaultPick(noSet)).toBe('lakePond');
    expect(leverOf(noSet, 'wetland')).toBeNull();
    expect(defaultPick(GROTON_DECIDED)).toBeNull();
    expect(leverOf(GROTON_DECIDED, 'wetland')).toBeNull();
    expect(leverOf(GROTON, null)).toBeNull();
    expect(defaultPick({ ...GROTON, can: {} } as ClassesItem)).toBeNull();
  });

  it('says the refusal once, only when no rung applies', () => {
    expect(refusalSaid(GROTON_REFUSED)).toBe(
      'This body was removed from the corpus since this was asked.',
    );
    expect(refusalSaid(GROTON)).toBeNull();
    expect(refusalSaid(GROTON_DECIDED)).toBeNull();
    expect(refusalSaid({ ...GROTON, can: {} } as ClassesItem)).toBeNull();
  });
});

describe('the catalogs, recorded or said not to be', () => {
  it('draws a column per catalog with a claim, in the board’s order; none before the campaign', () => {
    expect(catalogColumns(GROTON)).toEqual(['nhd', 'osm']);
    expect(catalogColumns(GROTON_NOT_RECORDED)).toEqual([]);
  });

  it('marks each rung with the catalog’s own token', () => {
    expect(tokenText('nhd:SwampMarsh')).toBe('SwampMarsh');
    expect(tokenText('water=pond')).toBe('water=pond');
    expect(rungMarks(GROTON.ladder[0] as ClassesItem['ladder'][number])).toEqual({
      osm: 'water=pond',
    });
    expect(rungMarks({ byCatalog: { nhd: undefined } } as never)).toEqual({});
  });

  it('writes a row per claim, saying what a claim stored early lacks', () => {
    expect(catalogRows(GROTON.claims)).toEqual([
      { key: 'nhd:0', label: 'NHD', value: 'Wetland · fcode=46600 · 7 ac' },
      { key: 'osm:1', label: 'OSM', value: 'Lake or pond · water=pond · 5 ac' },
    ]);
    expect(catalogRows(GROTON_MIXED.claims)?.[0]?.value).toBe(
      'Wetland · its code and area not recorded until the next campaign',
    );
    expect(catalogRows(null)).toBeNull();
  });
});

describe('the body', () => {
  it('heads with its name, place and acres, an unnamed body as unnamed water', () => {
    expect(headLine(GROTON.body)).toBe('Unnamed water · Groton, VT · 5 ac');
    expect(headLine({ ...GROTON.body, name: 'Mud Pond', acres: 0.4, place: '' })).toBe(
      'Mud Pond · <1 ac',
    );
    expect(headLine({ ...GROTON.body, acres: null })).toBe('Unnamed water · Groton, VT');
  });

  it('says what is on file and what isn’t', () => {
    expect(nameWords(GROTON.body)).toBe('None in any catalog');
    expect(nameWords({ ...GROTON.body, name: 'Mud Pond' })).toBe('Mud Pond');
    expect(depthWords(null)).toBe('None on file');
    expect(depthWords({ meters: 2.4, source: 'a state survey' })).toBe('2.4 m · a state survey');
    expect(depthWords({ meters: 12, source: '' })).toBe('12 m');
    expect(depthWords({ meters: 2.4, source: 'a state survey', measure: 'max' })).toBe(
      '2.4 m max · a state survey',
    );
    expect(depthWords({ meters: 3, source: '', measure: 'mean' })).toBe('3 m mean');
    expect(nearestWords(GROTON.neighbors)).toBe('Osmore Pond · 1.1 mi north');
    expect(nearestWords([])).toBe('None on file');
    expect(nearestWords(null)).toBe('Not computed yet');
    expect(raisedAgainNote(GROTON)).toBeNull();
  });
});

describe('the nearest body', () => {
  const at = (meters: number, bearingDeg = 0) => ({ meters, bearingDeg });
  const n = (name: string, offset?: { meters: number; bearingDeg: number } | null) => ({
    id: name as never,
    name,
    ...(offset === undefined ? {} : { offset }),
  });

  it('is the first served: the server puts the nearest with an offset first', () => {
    const far = n('Far Pond', at(4000));
    const close = n('Close Pond', at(900));
    const unknown = n('Unknown Pond', null);
    // The server's order is the answer; the client never re-ranks it (`neighborsOf` owns the rule).
    expect(nearestOf([close, far, unknown])?.name).toBe('Close Pond');
    expect(nearestWords([close, far])).toBe('Close Pond · 0.6 mi north');
    // None on file (or a fixture from before offsets): the stored order's first.
    expect(nearestOf([unknown, n('Old Pond')])?.name).toBe('Unknown Pond');
    expect(nearestOf([])).toBeUndefined();
    // Without an offset, just its name; an unnamed one as unnamed water.
    expect(nearestWords([n('Old Pond')])).toBe('Old Pond');
    expect(nearestWords([n('', at(3000, 180))])).toBe('Unnamed water · 1.9 mi south');
  });

  it('says miles to a tenth under ten, whole past, and the nearest of eight directions', () => {
    const mi = 1609.344;
    expect(offsetWords(at(1.1 * mi, 2))).toBe('1.1 mi north');
    expect(offsetWords(at(0.1 * mi, 45))).toBe('0.1 mi northeast');
    expect(offsetWords(at(9.94 * mi, 90))).toBe('9.9 mi east');
    // A hair under ten rounds to ten, and ten is whole: never "10.0 mi".
    expect(offsetWords(at(9.97 * mi, 90))).toBe('10 mi east');
    expect(offsetWords(at(10 * mi, 90))).toBe('10 mi east');
    expect(offsetWords(at(12.4 * mi, 135))).toBe('12 mi southeast');
    expect(offsetWords(at(2 * mi, 225))).toBe('2.0 mi southwest');
    expect(offsetWords(at(2 * mi, 270))).toBe('2.0 mi west');
    expect(offsetWords(at(2 * mi, 315))).toBe('2.0 mi northwest');
    // North either side of 0 / 360: the wrap is north, never a ninth direction.
    expect(offsetWords(at(2 * mi, 359.9))).toBe('2.0 mi north');
    expect(offsetWords(at(2 * mi, 22.4))).toBe('2.0 mi north');
    expect(offsetWords(at(2 * mi, 337.6))).toBe('2.0 mi north');
    expect(offsetWords(at(2 * mi, 22.6))).toBe('2.0 mi northeast');
    // So close a direction would be noise: none.
    expect(offsetWords(at(0.09 * mi, 90))).toBe('under 0.1 mi');
    expect(offsetWords(at(0, 0))).toBe('under 0.1 mi');
  });
});

describe('a rung’s consequence', () => {
  const must = <T>(x: T | undefined): T => {
    if (x === undefined) throw new Error('expected the rung');
    return x;
  };

  it('splits a refusal’s lead words from the rest, and leaves every other consequence whole', () => {
    const refusal = must(GROTON.ladder.find((r) => r.cls === 'wetland')).consequence;
    expect(consequenceParts(refusal)).toEqual({
      lead: 'Refused by the size rules',
      rest: ' next campaign, as unnamed wetland under 50 ac',
    });
    const stays = must(GROTON.ladder.find((r) => r.cls === 'reservoir')).consequence;
    expect(consequenceParts(stays)).toEqual({ lead: null, rest: stays.words });
    const bay = must(GROTON.ladder.find((r) => r.cls === 'bay')).consequence;
    expect(consequenceParts(bay).lead).toBeNull();
    // A rung from before the lead was served, or one whose lead doesn't begin its words: whole.
    expect(consequenceParts({ kind: 'leaves', words: 'Refused …' })).toEqual({
      lead: null,
      rest: 'Refused …',
    });
    expect(
      consequenceParts({ kind: 'leaves', words: 'Refused …', lead: 'Leaves' }).lead,
    ).toBeNull();
    expect(consequenceParts({ kind: 'leaves', words: 'Refused …', lead: '' }).lead).toBeNull();
  });
});
