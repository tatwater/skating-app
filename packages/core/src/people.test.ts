import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  AVATAR_URL_MAX_BYTES,
  bountyLimitRestricts,
  effectiveBountyLimitOf,
  isGeneratedAvatar,
  isPeopleLane,
  normalizePeopleListArgs,
  PEOPLE_LANE_LABELS,
  PEOPLE_LANES,
  PEOPLE_PAGE_MAX,
  PEOPLE_PAGE_SIZE,
  PEOPLE_SEARCH_MAX_CHARS,
  peopleLanesFor,
  RESTRICTIONS,
  restrictionsOf,
  storableAvatarUrl,
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

describe('peopleLanesFor — Appeals open only for a viewer who reads support (D37)', () => {
  test('every lane in order, or every lane but appeals', () => {
    expect(peopleLanesFor(true)).toEqual([...PEOPLE_LANES]);
    expect(peopleLanesFor(false)).toEqual(PEOPLE_LANES.filter((l) => l !== 'appeals'));
  });
});

/** A Clerk image URL of the given kind, as Clerk writes them: base64url JSON in the path. */
const clerkImage = (body: object) =>
  `https://img.clerk.com/${Buffer.from(JSON.stringify(body)).toString('base64url')}`;

describe('isGeneratedAvatar — Clerk’s silhouette is no one’s photo', () => {
  const generated = clerkImage({ type: 'default', iid: 'ins_2abc', rid: 'user_2xyz' });
  const uploaded = clerkImage({ type: 'proxy', src: 'https://images.clerk.dev/uploaded/img_1' });

  test('tells the generated silhouette from an uploaded or OAuth photo', () => {
    expect(isGeneratedAvatar(generated)).toBe(true);
    // A size asked for doesn't change what it is.
    expect(isGeneratedAvatar(`${generated}?width=80`)).toBe(true);
    expect(isGeneratedAvatar(uploaded)).toBe(false);
    expect(isGeneratedAvatar('https://lh3.googleusercontent.com/a/photo')).toBe(false);
  });

  test('reads anything it can’t decode as a photo, never as the silhouette', () => {
    expect(isGeneratedAvatar('not a url')).toBe(false);
    expect(isGeneratedAvatar('https://img.clerk.com/')).toBe(false);
    expect(isGeneratedAvatar('https://img.clerk.com/%%%')).toBe(false);
    expect(isGeneratedAvatar(`https://img.clerk.com/${btoa('[1]')}`)).toBe(false);
    // The same payload on another host is someone's file, not Clerk's silhouette.
    expect(isGeneratedAvatar(generated.replace('img.clerk.com', 'example.com'))).toBe(false);
  });

  test('is never stored: the person shows their initials', () => {
    expect(storableAvatarUrl(generated)).toBeUndefined();
    expect(storableAvatarUrl(uploaded)).toBe(uploaded);
  });
});

describe('storableAvatarUrl — a URL stored only up to the cap, in bytes', () => {
  test('at the cap it is kept; a byte past, or non-ASCII that crosses it, it is not', () => {
    const at = `https://x/${'a'.repeat(AVATAR_URL_MAX_BYTES - 10)}`;
    expect(storableAvatarUrl(at)).toBe(at);
    expect(storableAvatarUrl(`${at}a`)).toBeUndefined();
    expect(storableAvatarUrl(`https://x/${'é'.repeat(AVATAR_URL_MAX_BYTES / 2)}`)).toBeUndefined();
    expect(storableAvatarUrl(undefined)).toBeUndefined();
  });
});
