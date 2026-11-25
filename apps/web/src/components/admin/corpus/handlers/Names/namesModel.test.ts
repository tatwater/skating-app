import { describe, expect, it } from 'vitest';

import {
  BASIN,
  BASIN_ASKED_AGAIN,
  BASIN_DECIDED,
  BASIN_NOT_RECORDED,
  BASIN_REFUSED,
} from './namesFixtures';
import {
  bodyLine,
  catalogRun,
  catalogsWords,
  defaultPick,
  elsewhereWords,
  fromWords,
  leverOf,
  type NamesItem,
  onceRows,
  pickable,
  raisedAgainNote,
  refusalSaid,
  typedFor,
} from './namesModel';

const NOT_RECORDED = 'Not recorded until the next campaign';
const [SHOWN, OTHER] = BASIN.names as [NamesItem['names'][number], NamesItem['names'][number]];

describe('the pick', () => {
  it('opens on the shown name while nothing is suggested (D307), so the bar keeps it', () => {
    expect(defaultPick(BASIN)).toBe('The Basin');
    expect(leverOf(BASIN, 'The Basin')).toEqual({
      verb: 'keepName',
      pick: 'shown',
      label: 'Keep “The Basin”',
      name: 'The Basin',
    });
  });

  it('opens on a suggestion once one is named, and picks the other spelling by its value', () => {
    const suggested = {
      ...BASIN,
      names: [SHOWN, { ...OTHER, suggested: true }],
    } as NamesItem;
    expect(defaultPick(suggested)).toBe('Lake Auburn');
    expect(leverOf(suggested, 'Lake Auburn')).toEqual({
      verb: 'pickName',
      pick: 'Lake Auburn',
      label: 'Display “Lake Auburn” instead',
      name: 'Lake Auburn',
    });
  });

  it('draws no lever for a refused verb, an unknown pick, or a decided task', () => {
    const noPick = {
      ...BASIN,
      can: { keepName: null, pickName: 'Not yours to rename.' },
    } as NamesItem;
    expect(pickable(noPick, OTHER)).toBe(false);
    expect(leverOf(noPick, 'Lake Auburn')).toBeNull();
    // A verb absent from `can` is not this viewer's: never drawn.
    expect(leverOf({ ...BASIN, can: {} } as NamesItem, 'The Basin')).toBeNull();
    expect(leverOf(BASIN, 'Nowhere Pond')).toBeNull();
    expect(leverOf(BASIN, null)).toBeNull();
    expect(defaultPick(BASIN_DECIDED)).toBeNull();
    expect(leverOf(BASIN_DECIDED, 'Lake Auburn')).toBeNull();
  });

  it('falls back to no pick when the shown name can’t be kept, without suggesting the other', () => {
    const noKeep = { ...BASIN, can: { keepName: 'No.', pickName: null } } as NamesItem;
    expect(defaultPick(noKeep)).toBeNull();
  });
});

describe('the refusal said once', () => {
  it('says the first verb’s refusal only when nothing can be applied', () => {
    expect(refusalSaid(BASIN_REFUSED)).toBe(
      'The Basin was merged into another body since this was asked.',
    );
    expect(refusalSaid(BASIN)).toBeNull();
    expect(refusalSaid(BASIN_DECIDED)).toBeNull();
    expect(refusalSaid({ ...BASIN, can: { pickName: 'Only this.' } } as NamesItem)).toBe(
      'Only this.',
    );
    expect(refusalSaid({ ...BASIN, can: {} } as NamesItem)).toBeNull();
  });
});

describe('the facts, recorded or said not to be', () => {
  it('writes the catalogs out, the first in full, or the one it has', () => {
    expect(catalogRun(SHOWN)).toEqual(['gnis', 'nhd', '3dhp']);
    expect(fromWords(SHOWN)).toBe('USGS Geographic Names, via NHD and 3DHP');
    expect(fromWords(OTHER)).toBe('OpenStreetMap');
    const old = BASIN_NOT_RECORDED.names[0] as NamesItem['names'][number];
    expect(catalogRun(old)).toEqual(['gnis']);
    expect(fromWords(old)).toBe('USGS Geographic Names');
    expect(fromWords({ sources: [], sourcesRecorded: false })).toBe(NOT_RECORDED);
  });

  it('claims the catalogs agree only when every spelling’s catalogs are recorded', () => {
    expect(catalogsWords(BASIN)).toBe('All four agree it is one body');
    expect(catalogsWords(BASIN_NOT_RECORDED)).toBe(NOT_RECORDED);
    expect(catalogsWords({ names: [] })).toBe(NOT_RECORDED);
    const two = {
      names: [
        { ...SHOWN, sources: ['gnis'] },
        { ...OTHER, sources: ['osm'] },
      ],
    };
    expect(catalogsWords(two as NamesItem)).toBe('Both agree it is one body');
    // A moderator's name is no catalog: one catalog alone vouches for nothing.
    const one = { names: [{ ...SHOWN, sources: ['gnis', 'user'] }] };
    expect(catalogsWords(one as NamesItem)).toBe(NOT_RECORDED);
  });

  it('counts namesakes, a floor where the read stopped', () => {
    expect(elsewhereWords({ count: 0, capped: false })).toBe('The only body named this');
    expect(elsewhereWords({ count: 1, capped: false })).toBe('1 other body carries it');
    expect(elsewhereWords({ count: 14, capped: false })).toBe('14 other bodies carry it');
    expect(elsewhereWords({ count: 50, capped: true })).toBe('50+ other bodies carry it');
  });

  it('writes the body line, leaving out what isn’t on file', () => {
    expect(bodyLine(BASIN.body)).toBe('Auburn, ME · Lake or pond · 2,263 ac');
    expect(bodyLine({ ...BASIN.body, place: '', acres: null })).toBe('Lake or pond');
  });

  it('says what the pick does, and what a keep does', () => {
    expect(onceRows(BASIN, { verb: 'pickName', name: 'Lake Auburn' })).toEqual([
      { label: 'Displays', value: 'Lake Auburn', strong: true },
      { label: 'Alias', value: 'The Basin, still found by search' },
      { label: 'Campaigns', value: 'Holds until a catalog renames it' },
      { label: 'Undo', value: 'In the body’s history' },
    ]);
    expect(onceRows(BASIN, { verb: 'keepName', name: 'The Basin' })[0]).toEqual({
      label: 'Displays',
      value: 'The Basin, as now',
    });
    expect(onceRows({ names: [SHOWN] }, { verb: 'keepName', name: 'The Basin' })).toHaveLength(3);
  });

  it('types the longest word of the other name into the app’s search', () => {
    expect(typedFor('The Basin')).toBe('basin');
    expect(typedFor('Lake Auburn')).toBe('auburn');
    expect(typedFor('   ')).toBe('   ');
  });

  it('says a question asked again, by whom and what changed (D305)', () => {
    expect(raisedAgainNote(BASIN)).toBeNull();
    expect(raisedAgainNote(BASIN_ASKED_AGAIN, 'America/New_York')).toBe(
      'Asked again: Kate Donovan settled it on 4 Sep (kept), and a catalog’s spelling has changed since.',
    );
  });
});
