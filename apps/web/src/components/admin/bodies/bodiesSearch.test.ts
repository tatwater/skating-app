import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BODY_COLUMNS } from './bodiesModel';
import {
  bodiesSearchSchema,
  listKey,
  listSort,
  queryOf,
  SEARCH_MAX_CHARS,
  searchFor,
  validateBodiesSearch,
} from './bodiesSearch';
import { FACET_IDS, FACETS } from './bodyFacets';
import { BODY_LANES, laneById } from './bodyLanes';

describe('validateBodiesSearch', () => {
  it('is empty for the default place', () => {
    expect(validateBodiesSearch({})).toEqual({});
  });
  it('drops what it doesn’t know rather than failing', () => {
    expect(
      validateBodiesSearch({
        lane: 'nowhere',
        sort: 'depth',
        dir: 'sideways',
        state: 'New Hampshire',
        size: 'huge',
        q: '   ',
        body: '',
        extra: 1,
      }),
    ).toEqual({});
  });
  it('writes the default lane as no param at all', () => {
    expect(validateBodiesSearch({ lane: 'active' })).toEqual({});
    expect(validateBodiesSearch({ lane: 'inactive' })).toEqual({ lane: 'inactive' });
  });
  it('takes a number the router parsed back to its text', () => {
    expect(validateBodiesSearch({ q: 123, body: 4 })).toEqual({ q: '123', body: '4' });
  });
  it('trims and caps the search', () => {
    expect(validateBodiesSearch({ q: `  ${'m'.repeat(300)}  ` }).q).toHaveLength(SEARCH_MAX_CHARS);
  });
  it('keeps known facet options in the menu’s order, unknown ids dropped', () => {
    expect(
      validateBodiesSearch({ size: '1000-up,huge,under-10', class: 'bay , lakePond' }),
    ).toEqual({
      size: 'under-10,1000-up',
      class: 'lakePond,bay',
    });
  });
  it('upper-cases a state and keeps only two letters', () => {
    expect(validateBodiesSearch({ state: 'vt' })).toEqual({ state: 'VT' });
    expect(validateBodiesSearch({ state: 'VTX' })).toEqual({});
  });
  it('never throws, whatever the URL holds', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (raw) => {
        expect(() => validateBodiesSearch(raw)).not.toThrow();
      }),
    );
  });
  it('is the schema the route can adopt', () => {
    expect(bodiesSearchSchema.safeParse({ sort: 'acres', dir: 'asc' }).success).toBe(true);
  });
});

describe('queryOf and searchFor', () => {
  it('fills the defaults: Active, by reports, nothing narrowed', () => {
    const q = queryOf({});
    expect(q.lane.id).toBe('active');
    expect(q.sort).toEqual({ column: 'reports', dir: 'desc' });
    expect(q).toMatchObject({ bodyId: null, q: '', state: null, facets: {} });
    expect(searchFor(q)).toEqual({});
  });
  it('ranks by match while a search holds words and no heading was pressed', () => {
    expect(queryOf({ q: 'mor' }).sort).toEqual({ column: 'match' });
    expect(searchFor(queryOf({ q: 'mor' }))).toEqual({ q: 'mor' });
    // With a search, even the lane's own order is a choice, so it is written.
    expect(searchFor(queryOf({ q: 'mor', sort: 'reports', dir: 'desc' }))).toEqual({
      q: 'mor',
      sort: 'reports',
      dir: 'desc',
    });
  });
  it('keeps the lane’s order while a search is too short to rank, else the order chosen', () => {
    expect(listSort(queryOf({ q: 'm' }))).toEqual({ column: 'reports', dir: 'desc' });
    expect(listSort(queryOf({ q: ' m ' }))).toEqual({ column: 'reports', dir: 'desc' });
    expect(listSort(queryOf({ q: 'mo' }))).toEqual({ column: 'match' });
    expect(listSort(queryOf({ q: 'm', sort: 'name' }))).toEqual({ column: 'name', dir: 'asc' });
    expect(listSort(queryOf({}))).toEqual({ column: 'reports', dir: 'desc' });
  });
  it('takes a column’s first direction when the URL names none', () => {
    expect(queryOf({ sort: 'name' }).sort).toEqual({ column: 'name', dir: 'asc' });
    expect(queryOf({ sort: 'acres' }).sort).toEqual({ column: 'acres', dir: 'desc' });
  });
  it('round-trips every place through the URL', () => {
    const arb = fc.record(
      {
        lane: fc.constantFrom(...BODY_LANES.map((l) => l.id)),
        body: fc.stringMatching(/^[a-z0-9]{32}$/),
        q: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}[A-Za-z]$/),
        state: fc.constantFrom('NH', 'VT', 'ME'),
        sort: fc.constantFrom(...BODY_COLUMNS),
        dir: fc.constantFrom('asc', 'desc'),
        ...Object.fromEntries(
          FACET_IDS.map((id) => [
            id,
            fc
              .subarray(FACETS.find((f) => f.id === id)?.options.map((o) => o.id) ?? [], {
                minLength: 1,
              })
              .map((ids) => ids.join(',')),
          ]),
        ),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(arb, (raw) => {
        const once = searchFor(queryOf(validateBodiesSearch(raw)));
        const twice = searchFor(queryOf(validateBodiesSearch(once)));
        expect(twice).toEqual(once);
      }),
    );
  });
  it('keys a list by everything but the open body, whatever the order it was written in', () => {
    const a = queryOf({ size: '1000-up', state: 'NH', body: 'x' });
    const b = queryOf({ state: 'NH', size: '1000-up' });
    expect(listKey(a)).toBe(listKey(b));
    expect(listKey(a)).not.toBe(listKey(queryOf({ state: 'VT', size: '1000-up' })));
  });
  it('finds a lane by id, the default for an unknown one', () => {
    expect(laneById('removed').label).toBe('Removed · rejected');
    expect(laneById('gone').id).toBe('active');
  });
});
