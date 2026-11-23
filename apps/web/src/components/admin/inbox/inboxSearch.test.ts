import { INBOX_FACETS, INBOX_LANES, INBOX_LIST_LANES } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  facetsOf,
  inboxHref,
  listKey,
  placeAfter,
  queryOf,
  safeReturnPath,
  searchFor,
  serverFilter,
  validateInboxSearch,
} from './inboxSearch';

const ID = 'jd7a1b2c3d4e5f6g7h8i9j0k1m2n3p4q';
const ID2 = 'kx9z8y7w6v5u4t3s2r1q0p9n8m7k6j5h';

describe('validateInboxSearch', () => {
  it('writes the default lane as no param and keeps every other list lane', () => {
    expect(validateInboxSearch({ lane: 'all' })).toEqual({});
    for (const lane of INBOX_LIST_LANES.filter((l) => l !== 'all')) {
      expect(validateInboxSearch({ lane })).toEqual({ lane });
    }
  });

  it.each([['nope'], [3], [null], [{}], ['Safety'], ['']])('drops an unknown lane %j', (lane) => {
    expect(validateInboxSearch({ lane })).toEqual({});
  });

  it('keeps a facet only when its lane has it, and never `all`', () => {
    expect(validateInboxSearch({ lane: 'safety', facet: 'hazards' })).toEqual({
      lane: 'safety',
      facet: 'hazards',
    });
    expect(validateInboxSearch({ lane: 'safety', facet: 'bays' })).toEqual({ lane: 'safety' });
    expect(validateInboxSearch({ lane: 'safety', facet: 'all' })).toEqual({ lane: 'safety' });
    // All open and Decided have no tabs.
    expect(validateInboxSearch({ facet: 'reports' })).toEqual({});
    expect(validateInboxSearch({ lane: 'decided', facet: 'reports' })).toEqual({
      lane: 'decided',
    });
  });

  it('keeps an item id, a source ref or a bare id, and drops anything else', () => {
    for (const item of [ID, `flag:${ID}`, `request:${ID}`, `body:${ID}`, `ticket:${ID}`]) {
      expect(validateInboxSearch({ item })).toEqual({ item });
    }
    for (const item of ['report:abc', 'flag:', 'flag:a b', 'x'.repeat(65), '../etc', 'a:b:c', '']) {
      expect(validateInboxSearch({ item })).toEqual({});
    }
    // The router hands a number-shaped param back as a number: it is a string again.
    expect(validateInboxSearch({ item: 12345 })).toEqual({ item: '12345' });
  });

  it('keeps one filter — body before person before age — each only if well formed', () => {
    expect(validateInboxSearch({ body: ID, about: ID2, age: 7 })).toEqual({ body: ID });
    expect(validateInboxSearch({ body: 'nope', about: ID2, age: 7 })).toEqual({ about: ID2 });
    expect(validateInboxSearch({ about: 'NOPE', age: '30' })).toEqual({ age: 30 });
    expect(validateInboxSearch({ age: 2 })).toEqual({});
    expect(validateInboxSearch({ age: 'soon' })).toEqual({});
  });

  it('keeps a return path only under the Overview, People, Corpus or a body', () => {
    expect(validateInboxSearch({ from: '/admin' })).toEqual({ from: '/admin' });
    expect(validateInboxSearch({ from: '/admin/people?lane=flagged' })).toEqual({
      from: '/admin/people?lane=flagged',
    });
    expect(validateInboxSearch({ from: `/admin/body/${ID}?tab=access` })).toEqual({
      from: `/admin/body/${ID}?tab=access`,
    });
    for (const from of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example',
      '/admin/flags',
      '/admin/peoplex',
      '/admin/bodies',
      '/admin/inbox',
      'admin',
      '',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(validateInboxSearch({ from })).toEqual({});
    }
  });

  it('never throws, whatever it is handed', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('lane', 'facet', 'item', 'body', 'about', 'age', 'from', 'other'),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.object()),
        ),
        (raw) => {
          const out = validateInboxSearch(raw);
          // What it keeps reads back the same: validation is idempotent.
          expect(validateInboxSearch(out as Record<string, unknown>)).toEqual(out);
        },
      ),
    );
  });
});

describe('safeReturnPath', () => {
  it('keeps the search and hash of a path it allows', () => {
    expect(safeReturnPath('/admin/corpus?q=mas#x')).toBe('/admin/corpus?q=mas#x');
    expect(safeReturnPath('/admin/')).toBe('/admin/');
  });

  it('refuses what is not a string', () => {
    expect(safeReturnPath(42)).toBeNull();
  });
});

describe('queryOf and searchFor', () => {
  it('fills every default', () => {
    expect(queryOf({}, true)).toEqual({
      lane: 'all',
      facet: 'all',
      filter: null,
      item: null,
      from: null,
    });
  });

  it('reads Support as All open for a viewer without support’s read, its facet with it', () => {
    expect(queryOf({ lane: 'support', facet: 'bug' }, false)).toMatchObject({
      lane: 'all',
      facet: 'all',
    });
    expect(queryOf({ lane: 'support', facet: 'bug' }, true)).toMatchObject({
      lane: 'support',
      facet: 'bug',
    });
  });

  it('reads each filter', () => {
    expect(queryOf({ body: ID }, true).filter).toEqual({ kind: 'body', id: ID });
    expect(queryOf({ about: ID }, true).filter).toEqual({ kind: 'about', id: ID });
    expect(queryOf({ age: 3 }, true).filter).toEqual({ kind: 'age', days: 3 });
  });

  it('round-trips every valid place through the URL', () => {
    const lane = fc.constantFrom(...INBOX_LIST_LANES);
    fc.assert(
      fc.property(
        lane,
        fc.nat(),
        fc.option(
          fc.oneof(
            fc.record({ kind: fc.constant('body' as const), id: fc.constant(ID) }),
            fc.record({ kind: fc.constant('about' as const), id: fc.constant(ID2) }),
            fc.record({ kind: fc.constant('age' as const), days: fc.constantFrom(1, 3, 7, 30) }),
          ),
        ),
        fc.option(fc.constantFrom(ID, `flag:${ID}`)),
        fc.option(fc.constantFrom('/admin', '/admin/people')),
        (l, f, filter, item, from) => {
          const facets = facetsOf(l);
          const facet = facets.length === 0 ? 'all' : (facets[f % facets.length] as string);
          const query = { lane: l, facet, filter, item, from };
          const search = searchFor(query);
          expect(queryOf(validateInboxSearch(search as Record<string, unknown>), true)).toEqual(
            query,
          );
        },
      ),
    );
  });
});

describe('the list’s keys and the server’s filter', () => {
  it('gives each list one key, whatever item is open', () => {
    const a = queryOf({ lane: 'safety', facet: 'hazards', item: ID }, true);
    const b = queryOf({ lane: 'safety', facet: 'hazards' }, true);
    expect(listKey(a)).toBe(listKey(b));
    expect(listKey(queryOf({ lane: 'safety', age: 7 }, true))).not.toBe(listKey(b));
    expect(listKey(queryOf({ body: ID }, true))).toBe(
      'all|all|body:jd7a1b2c3d4e5f6g7h8i9j0k1m2n3p4q',
    );
  });

  it('hands the server one filter in its own shape', () => {
    expect(serverFilter(null)).toBeUndefined();
    expect(serverFilter({ kind: 'body', id: ID })).toEqual({ waterBodyId: ID });
    expect(serverFilter({ kind: 'about', id: ID })).toEqual({ subjectUserId: ID });
    expect(serverFilter({ kind: 'age', days: 7 })).toEqual({ minAgeDays: 7 });
  });

  it('writes a link to a place', () => {
    expect(inboxHref(queryOf({}, true))).toBe('/admin/inbox');
    expect(inboxHref(queryOf({ lane: 'safety', item: `flag:${ID}` }, true))).toBe(
      `/admin/inbox?lane=safety&item=flag%3A${ID}`,
    );
  });

  it('gives each lane its tabs and the two lists none', () => {
    for (const lane of INBOX_LANES) expect(facetsOf(lane)).toBe(INBOX_FACETS[lane]);
    expect(facetsOf('all')).toEqual([]);
    expect(facetsOf('decided')).toEqual([]);
  });
});

describe('where a change of list leaves the open item', () => {
  const open = queryOf({ lane: 'safety', facet: 'reports', item: ID }, true);

  it('closes an item opened from the list on another lane, tab or filter', () => {
    for (const next of [
      { ...open, lane: 'requests' as const, facet: 'all' },
      { ...open, facet: 'hazards' },
      { ...open, filter: { kind: 'age' as const, days: 7 } },
    ]) {
      expect(placeAfter(open, next, true).item).toBeNull();
    }
  });

  it('keeps an item that came by a direct link open beside whichever list', () => {
    expect(placeAfter(open, { ...open, facet: 'hazards' }, false).item).toBe(ID);
    expect(placeAfter(open, { ...open, lane: 'decided', facet: 'all' }, false).item).toBe(ID);
  });

  it('keeps the open item when the list doesn’t change', () => {
    expect(placeAfter(open, { ...open }, true).item).toBe(ID);
  });
});
