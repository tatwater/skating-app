import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  bountyLimitRestricts,
  effectiveBountyLimitOf,
  isPeopleLane,
  normalizePeopleListArgs,
  PEOPLE_LANE_LABELS,
  PEOPLE_LANES,
  PEOPLE_PAGE_MAX,
  PEOPLE_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_CHARS,
  RESTRICTIONS,
  restrictionsOf,
} from './people';
import { MAX_OPEN_BOUNTIES_PER_DAY } from './reputationConfig';

describe('the People lanes', () => {
  test('every lane has a label, in the board order', () => {
    expect(Object.keys(PEOPLE_LANE_LABELS)).toEqual([...PEOPLE_LANES]);
    expect(PEOPLE_LANES[0]).toBe('everyone');
    expect(isPeopleLane('staff')).toBe(true);
    expect(isPeopleLane('Staff')).toBe(false);
  });
});

describe('normalizePeopleListArgs', () => {
  test('an unknown lane is refused', () => {
    expect(normalizePeopleListArgs({ lane: 'vips' })).toBeNull();
  });

  test('the search is trimmed, folded, cut and loses a leading @; the page size is clamped', () => {
    expect(normalizePeopleListArgs({ lane: 'everyone', search: '  @@rob   tremblay ' })).toEqual({
      lane: 'everyone',
      search: 'rob tremblay',
      pageSize: PEOPLE_PAGE_SIZE,
    });
    expect(normalizePeopleListArgs({ lane: 'banned', search: '   ', pageSize: 0 })).toEqual({
      lane: 'banned',
      search: null,
      pageSize: 1,
    });
    expect(normalizePeopleListArgs({ lane: 'banned', pageSize: Number.NaN })?.pageSize).toBe(
      PEOPLE_PAGE_SIZE,
    );
    expect(normalizePeopleListArgs({ lane: 'banned', pageSize: 1e9 })?.pageSize).toBe(
      PEOPLE_PAGE_MAX,
    );
  });

  test('for any input, the output is bounded and idempotent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PEOPLE_LANES),
        fc.option(fc.string({ maxLength: 300 }), { nil: undefined }),
        fc.option(fc.double(), { nil: undefined }),
        (lane, search, pageSize) => {
          const once = normalizePeopleListArgs({ lane, search, pageSize });
          expect(once).not.toBeNull();
          if (once === null) return;
          expect(once.pageSize).toBeGreaterThanOrEqual(1);
          expect(once.pageSize).toBeLessThanOrEqual(PEOPLE_PAGE_MAX);
          expect(Number.isInteger(once.pageSize)).toBe(true);
          if (once.search !== null) {
            expect(once.search.length).toBeGreaterThan(0);
            expect(once.search.length).toBeLessThanOrEqual(PEOPLE_SEARCH_MAX_CHARS);
            expect(once.search).not.toMatch(/^[\s@]|\s$/);
          }
          expect(normalizePeopleListArgs({ ...once })).toEqual(once);
        },
      ),
    );
  });
});

describe('restrictions', () => {
  test('absent is allowed; each right off is listed in order', () => {
    expect(restrictionsOf({})).toEqual([]);
    expect(
      restrictionsOf({
        canPostReports: false,
        canPostHazards: false,
        canPostComments: false,
        canFlag: false,
        activeBountyPostLimit: 0,
      }),
    ).toEqual([...RESTRICTIONS]);
    expect(restrictionsOf({ canPostReports: true, canFlag: true })).toEqual([]);
    // Staff are exempt from the flagging switch: a dormant `false` restricts nothing until a demotion.
    expect(restrictionsOf({ role: 'moderator', canFlag: false })).toEqual([]);
    expect(restrictionsOf({ role: 'member', canFlag: false })).toEqual(['flagging']);
  });

  test('a bounty limit restricts only below the global cap', () => {
    expect(bountyLimitRestricts(undefined)).toBe(false);
    expect(bountyLimitRestricts(MAX_OPEN_BOUNTIES_PER_DAY)).toBe(false);
    expect(bountyLimitRestricts(MAX_OPEN_BOUNTIES_PER_DAY + 2)).toBe(false);
    expect(bountyLimitRestricts(MAX_OPEN_BOUNTIES_PER_DAY - 1)).toBe(true);
    expect(bountyLimitRestricts(Number.NaN)).toBe(false);
    expect(effectiveBountyLimitOf(null)).toBe(MAX_OPEN_BOUNTIES_PER_DAY);
    expect(effectiveBountyLimitOf(undefined)).toBe(MAX_OPEN_BOUNTIES_PER_DAY);
    expect(effectiveBountyLimitOf(1)).toBe(1);
    expect(effectiveBountyLimitOf(-1)).toBe(MAX_OPEN_BOUNTIES_PER_DAY);
  });
});
