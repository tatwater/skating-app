import { describe, expect, it } from 'vitest';

import { nameOfFilter } from './InboxRoute';
import { queryOf } from './inboxSearch';
import { ACCESS_ROW, ALL_OPEN_ROWS, KATE, ROB } from './list/inboxFixtures';

const body = (ACCESS_ROW.body as { waterBodyId: string }).waterBodyId;

describe('the applied filter’s name', () => {
  it('is the name chosen in the menu for that filter', () => {
    const q = queryOf({ body: 'jd7a1b2c3d4e5f6g7h8i9j0k1m2n3p4q' }, true);
    expect(nameOfFilter(q, { id: 'jd7a1b2c3d4e5f6g7h8i9j0k1m2n3p4q', name: 'Lake X' }, [])).toBe(
      'Lake X',
    );
    // Chosen for another filter: not this one's.
    expect(nameOfFilter(q, { id: 'other', name: 'Lake Y' }, [])).toBeNull();
  });

  it('is read off a row when the menu named none: the body, or the person in any role', () => {
    expect(
      nameOfFilter(
        { ...queryOf({}, true), filter: { kind: 'body', id: body } },
        null,
        ALL_OPEN_ROWS,
      ),
    ).toBe('Tomhannock Reservoir');
    for (const p of [ROB, KATE]) {
      expect(
        nameOfFilter(
          { ...queryOf({}, true), filter: { kind: 'about', id: p.userId } },
          null,
          ALL_OPEN_ROWS,
        ),
      ).toBe(p.displayName);
    }
  });

  it('is nothing for an age, no filter, or a name no row holds', () => {
    expect(nameOfFilter(queryOf({ age: 7 }, true), null, ALL_OPEN_ROWS)).toBeNull();
    expect(nameOfFilter(queryOf({}, true), null, ALL_OPEN_ROWS)).toBeNull();
    expect(
      nameOfFilter(
        { ...queryOf({}, true), filter: { kind: 'about', id: 'nobody' } },
        null,
        ALL_OPEN_ROWS,
      ),
    ).toBeNull();
  });
});
