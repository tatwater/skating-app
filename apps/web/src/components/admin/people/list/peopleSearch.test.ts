import { PEOPLE_LANES, PEOPLE_SEARCH_MAX_CHARS } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isSearching,
  listKey,
  peopleListHref,
  queryOf,
  searchFor,
  serverSearch,
  validatePeopleSearch,
} from './peopleSearch';

describe('the URL', () => {
  it('keeps a known lane and a search, and writes the default lane as no param', () => {
    expect(validatePeopleSearch({ lane: 'suspended', q: 'rob' })).toEqual({
      lane: 'suspended',
      q: 'rob',
    });
    expect(validatePeopleSearch({ lane: 'everyone' })).toEqual({});
  });

  it('drops an unknown lane, and anything that is not text, rather than failing', () => {
    expect(validatePeopleSearch({ lane: 'moderators' })).toEqual({});
    expect(validatePeopleSearch({ lane: ['staff'], q: { a: 1 } })).toEqual({});
    expect(validatePeopleSearch({ person: 'x' })).toEqual({});
  });

  it('trims a search, caps it at the server’s limit, and takes a number back to its text', () => {
    expect(validatePeopleSearch({ q: '   ' })).toEqual({});
    expect(validatePeopleSearch({ q: '  rob  ' })).toEqual({ q: 'rob' });
    expect(validatePeopleSearch({ q: 123 })).toEqual({ q: '123' });
    // A hand-typed `?q=true` reaches the page as the boolean the router read it as.
    expect(validatePeopleSearch({ q: true })).toEqual({ q: 'true' });
    const long = validatePeopleSearch({ q: 'x'.repeat(200) }).q ?? '';
    expect(long).toHaveLength(PEOPLE_SEARCH_MAX_CHARS);
  });

  it('never throws, and always yields a place the page can draw', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (raw) => {
        const query = queryOf(validatePeopleSearch(raw));
        expect(PEOPLE_LANES).toContain(query.lane);
        expect(query.q.length).toBeLessThanOrEqual(PEOPLE_SEARCH_MAX_CHARS);
      }),
    );
  });
});

describe('the page’s place', () => {
  it('opens on Everyone, and on Everyone for a lane the viewer doesn’t have', () => {
    expect(queryOf({})).toEqual({ lane: 'everyone', q: '' });
    expect(queryOf({ lane: 'appeals' }, ['everyone', 'staff'])).toEqual({
      lane: 'everyone',
      q: '',
    });
    expect(queryOf({ lane: 'appeals' }, ['everyone', 'appeals'])).toMatchObject({
      lane: 'appeals',
    });
    expect(queryOf({ lane: 'nope' })).toMatchObject({ lane: 'everyone' });
  });

  it('round-trips every place through the URL', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PEOPLE_LANES),
        fc.string({ maxLength: PEOPLE_SEARCH_MAX_CHARS }),
        (lane, q) => {
          const search = searchFor({ lane, q });
          const back = queryOf(validatePeopleSearch(search));
          expect(back.lane).toBe(lane);
          expect(back.q).toBe(q.trim().slice(0, PEOPLE_SEARCH_MAX_CHARS).trim());
        },
      ),
    );
  });

  it('runs the search the server runs: a pasted handle loses its @, a blank one is none', () => {
    expect(serverSearch('  @rtremblay ')).toBe('rtremblay');
    expect(serverSearch('rob   tremblay')).toBe('rob tremblay');
    expect(serverSearch('  ')).toBeNull();
    expect(serverSearch('@')).toBeNull();
    expect(isSearching({ lane: 'staff', q: '@' })).toBe(false);
    expect(isSearching({ lane: 'staff', q: 'r' })).toBe(true);
  });

  it('keys a list by its lane, or by its search over every account whatever the lane', () => {
    expect(listKey({ lane: 'staff', q: '' })).toBe('lane:staff');
    expect(listKey({ lane: 'staff', q: '@rob' })).toBe(listKey({ lane: 'banned', q: 'rob' }));
  });

  it('writes the list’s own path, the way a person’s page goes back to it', () => {
    expect(peopleListHref({ lane: 'suspended', q: 'rob t' })).toBe(
      '/admin/people?lane=suspended&q=rob+t',
    );
    expect(peopleListHref({ lane: 'staff', q: '' })).toBe('/admin/people?lane=staff');
    expect(peopleListHref({ lane: 'everyone', q: '' })).toBe('/admin/people');
  });
});
