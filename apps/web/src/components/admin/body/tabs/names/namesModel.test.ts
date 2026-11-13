import { describe, expect, it } from 'vitest';

import { MASCOMA_NAMES } from './namesFixtures';
import {
  aliasesOf,
  countryOf,
  nameRungs,
  namesFromBody,
  namesMapDrawing,
  otherClasses,
  stateName,
} from './namesModel';

describe('nameRungs', () => {
  it('folds catalogs that spell it alike onto one rung, in stored (authority) order', () => {
    expect(
      nameRungs('The Basin', [
        { source: 'nhd', value: 'The Basin' },
        { source: 'gnis', value: 'the basin ' },
        { source: 'osm', value: 'Lake Auburn' },
      ]),
    ).toEqual([
      { value: 'The Basin', sources: ['nhd', 'gnis'], now: true },
      { value: 'Lake Auburn', sources: ['osm'], now: false },
    ]);
  });

  it('never makes a rung of a moderator’s claim or a blank one', () => {
    expect(
      nameRungs('Lake Auburn', [
        { source: 'user', value: 'Lake Auburn' },
        { source: 'nhd', value: '  ' },
        { source: 'osm', value: 'Lake Auburn' },
      ]),
    ).toEqual([{ value: 'Lake Auburn', sources: ['osm'], now: true }]);
  });

  it('is empty for a body nobody named', () => {
    expect(nameRungs('', undefined)).toEqual([]);
  });
});

describe('aliasesOf', () => {
  it('keeps a moderator’s names that aren’t displayed, once each', () => {
    expect(
      aliasesOf('Lake Auburn', [
        { source: 'user', value: 'Lake Auburn' },
        { source: 'user', value: 'Auburn Lake' },
        { source: 'user', value: 'auburn lake' },
        { source: 'osm', value: 'The Basin' },
      ]),
    ).toEqual(['Auburn Lake']);
  });
});

describe('namesFromBody', () => {
  it('reads the record: Now, the override, the class and the one state it holds', () => {
    const data = namesFromBody({
      name: 'Lake Auburn',
      type: 'lakePond',
      nameClaims: [
        { source: 'user', value: 'Lake Auburn' },
        { source: 'nhd', value: 'The Basin' },
        { source: 'osm', value: 'Lake Auburn' },
      ],
      states: ['ME'],
    });
    expect(data.overridden).toBe(true);
    expect(data.community).toBe(false);
    expect(data.rungs.map((r) => r.now)).toEqual([false, true]);
    expect(data.cls).toBe('lakePond');
    // Not recorded stays null — never zero, never "none".
    expect(data.classOptions).toBeNull();
    expect(data.place).toEqual({ towns: null, county: null, state: 'ME', townLines: null });
  });

  it('calls a body with no catalog claim the community’s', () => {
    const data = namesFromBody({ name: '', type: 'lakePond' });
    expect(data.community).toBe(true);
    expect(data.overridden).toBe(false);
    expect(data.place.state).toBeNull();
  });

  it('keeps the current class among the options, so Now always has a row', () => {
    const data = namesFromBody(
      { name: 'Mascoma Lake', type: 'reservoir' },
      { classOptions: [{ cls: 'lakePond', sources: ['NHD'] }] },
    );
    expect(data.classOptions?.map((o) => o.cls)).toEqual(['reservoir', 'lakePond']);
    const already = namesFromBody(
      { name: 'Mascoma Lake', type: 'reservoir' },
      { classOptions: [{ cls: 'reservoir', sources: ['OSM'] }] },
    );
    expect(already.classOptions).toHaveLength(1);
  });

  it('takes towns and the county from the boundary read when it lands', () => {
    const data = namesFromBody(
      { name: 'Mascoma Lake', type: 'reservoir', states: ['NH'] },
      { place: { towns: ['Enfield'], county: 'Grafton' } },
    );
    expect(data.place.towns).toEqual(['Enfield']);
    expect(data.place.county).toBe('Grafton');
  });
});

describe('the location’s words', () => {
  it('writes a corpus state out, and puts it in the United States', () => {
    expect(stateName('NH')).toBe('New Hampshire');
    expect(stateName('QC')).toBe('QC');
    expect(countryOf('VT')).toBe('United States');
    expect(countryOf('QC')).toBeNull();
    expect(countryOf(null)).toBeNull();
  });

  it('offers every class not already a row under Another class', () => {
    expect(otherClasses([{ cls: 'reservoir', sources: [] }], 'reservoir')).not.toContain(
      'reservoir',
    );
    expect(otherClasses(null, 'bay')).toEqual([
      'lakePond',
      'wetland',
      'reservoir',
      'river',
      'unclassified',
    ]);
  });
});

describe('namesMapDrawing', () => {
  it('draws each town line with its two towns, keyed, and lights the one named', () => {
    const drawing = namesMapDrawing(MASCOMA_NAMES, 'town-line:lebanon-enfield');
    expect(drawing.lines.map((l) => [l.id, l.faces, l.lit])).toEqual([
      ['town-line:canaan-enfield', ['Canaan', 'Enfield'], false],
      ['town-line:lebanon-enfield', ['Lebanon', 'Enfield'], true],
    ]);
    expect(drawing.key).toEqual([{ mark: 'town-line', label: 'Town line', tag: 'TIGER' }]);
    expect(drawing.lit).toBe('town-line:lebanon-enfield');
  });

  it('draws nothing, and no key, until the boundary read lands; a lit row off the map is not lit', () => {
    const drawing = namesMapDrawing(
      { ...MASCOMA_NAMES, place: { ...MASCOMA_NAMES.place, townLines: null } },
      'alias:Mascoma',
    );
    expect(drawing).toEqual({ lines: [], key: [], lit: null });
  });
});
