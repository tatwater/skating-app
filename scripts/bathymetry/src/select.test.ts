import { describe, expect, it } from 'vitest';
import { parseSelection, selectSources } from './select';
import { SOURCES } from './sources';

describe('parseSelection', () => {
  it('reads bare keys and ignores other flags', () => {
    expect(parseSelection(['nh-granit-contours', '--refresh', '--delay=100'])).toEqual({
      keys: ['nh-granit-contours'],
      states: [],
    });
  });

  it('accepts --state repeated and comma-separated, case-insensitively', () => {
    expect(parseSelection(['--state=nh', '--state=VT,ma']).states).toEqual(['NH', 'VT', 'MA']);
  });

  it('ignores an empty --state segment rather than selecting a blank state', () => {
    expect(parseSelection(['--state=NH,,']).states).toEqual(['NH']);
  });
});

describe('selectSources', () => {
  it('selects everything when nothing is asked for', () => {
    expect(selectSources(SOURCES, { keys: [], states: [] })).toHaveLength(SOURCES.length);
  });

  it('selects a whole state, which is how a refresh is actually scoped', () => {
    const selected = selectSources(SOURCES, { keys: [], states: ['VT'] });
    expect(selected.map((s) => s.key)).toEqual([
      'vt-vcgi-champlain-soundings',
      'vt-anr-biobase-soundings',
    ]);
  });

  it('deduplicates when a key and its state are both named', () => {
    const selected = selectSources(SOURCES, { keys: ['vt-anr-biobase-soundings'], states: ['VT'] });
    expect(selected).toHaveLength(2);
  });

  it('returns registry order regardless of how it was asked for', () => {
    // So a run's logs read identically however it was invoked.
    const a = selectSources(SOURCES, { keys: [], states: ['ME', 'NH'] }).map((s) => s.key);
    const b = selectSources(SOURCES, { keys: [], states: ['NH', 'ME'] }).map((s) => s.key);
    expect(a).toEqual(b);
  });

  it('throws on an unknown key instead of acting on a smaller set', () => {
    expect(() => selectSources(SOURCES, { keys: ['nh-contours'], states: [] })).toThrow(
      /unknown source key: nh-contours/,
    );
  });

  it('throws on a state with no sources, because silence would read as "all clean"', () => {
    // A typo'd --state matching nothing would make `verify` print "all sources unchanged" — true,
    // and completely misleading. That is the exact failure shape this ETL keeps finding in the data.
    expect(() => selectSources(SOURCES, { keys: [], states: ['CT'] })).toThrow(
      /no sources for state: CT/,
    );
  });

  it('explains New York specifically, since its emptiness is a finding rather than a typo', () => {
    expect(() => selectSources(SOURCES, { keys: [], states: ['NY'] })).toThrow(
      /publishes no lake bathymetry/,
    );
  });
});
