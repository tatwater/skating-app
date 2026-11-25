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
  defaultPick,
  depthWords,
  headLine,
  leverOf,
  nameWords,
  nearestWords,
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
    expect(nearestWords(GROTON.neighbors)).toBe('Osmore Pond');
    expect(nearestWords([])).toBe('None on file');
    expect(raisedAgainNote(GROTON)).toBeNull();
  });
});
