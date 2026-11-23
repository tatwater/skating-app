import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { feedSectionForTime, feedSectionRank, type PostCardData } from './feed';
import {
  carryFavorites,
  FAVORITE_LIFT_PER_SECTION,
  type LatestRow,
  latestFeedSections,
} from './latestFeed';
import type { BodyResultData } from './weatherDiscovery';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 20, 12);

function post(id: string, ageHours: number, favorite = false): PostCardData {
  return {
    postId: id,
    latestSkateEndTime: NOW - ageHours * HOUR,
    isFavorite: favorite,
    reports: [{ reportId: `${id}-r`, isFavorite: favorite }],
  } as unknown as PostCardData;
}

function lake(id: string, ageHours: number, favorite = false): BodyResultData {
  return {
    waterBodyId: id,
    eventMs: NOW - ageHours * HOUR,
    isFavorite: favorite,
  } as unknown as BodyResultData;
}

const rowId = (row: LatestRow) => (row.kind === 'report' ? row.data.postId : row.data.waterBodyId);

function sections(input: Partial<Parameters<typeof latestFeedSections>[0]>) {
  return latestFeedSections({
    posts: [],
    favorites: [],
    bodies: [],
    exhausted: false,
    now: NOW,
    recommendedIds: new Set(),
    lift: true,
    ...input,
  }).map((s) => [s.key, s.items.map(rowId)] as const);
}

describe('latestFeedSections (D292)', () => {
  it('replays the seeded feed: each header once, favorites leading their own section', () => {
    const posts = [post('t1', 1), post('t2', 2, true), post('t3', 3), post('o1', 99 * 24)];
    const favorites = [post('t2', 2, true), post('o2', 128 * 24, true)];
    expect(sections({ posts, favorites, exhausted: true })).toEqual([
      ['today', ['t2', 't1', 't3']],
      ['older', ['o2', 'o1']],
    ]);
  });

  it('lifts a favorite from the up-front read before any page brings it', () => {
    // Page 1 ends inside Today; t9 is Today's too, but on page 2.
    const posts = [post('t1', 1), post('t2', 2)];
    expect(sections({ posts, favorites: [post('t9', 9, true)] })).toEqual([
      ['today', ['t9', 't1', 't2']],
    ]);
    // Page 2 brings it: no repeat, and Today's head hasn't moved.
    expect(
      sections({ posts: [...posts, post('t9', 9, true)], favorites: [post('t9', 9, true)] }),
    ).toEqual([['today', ['t9', 't1', 't2']]]);
  });

  it('holds back a favorite whose section the scroll hasn’t reached; exhausted reaches all', () => {
    const posts = [post('t1', 1)];
    const favorites = [post('old', 90 * 24, true)];
    expect(sections({ posts, favorites })).toEqual([['today', ['t1']]]);
    expect(sections({ posts, favorites, exhausted: true })).toEqual([
      ['today', ['t1']],
      ['older', ['old']],
    ]);
    // Before the first page, nothing is reached.
    expect(sections({ favorites })).toEqual([]);
  });

  it('keeps a favorite the up-front read didn’t name in its time slot, with its star', () => {
    // f was past the per-section cap: it pages in late, so lifting it could land it above the reader.
    const posts = [post('t1', 1), post('f', 2, true), post('t3', 3)];
    expect(sections({ posts, exhausted: true })).toEqual([['today', ['t1', 'f', 't3']]]);
  });

  it('holds the other lakes to the pages’ floor, not to a favorite admitted below it', () => {
    // Page 1 ends at 3h; F (20h) is admitted from the up-front read; lake B (10h) must still wait.
    const posts = [post('t1', 1), post('t3', 3)];
    expect(sections({ posts, favorites: [post('F', 20, true)], bodies: [lake('B', 10)] })).toEqual([
      ['today', ['F', 't1', 't3']],
    ]);
  });

  it('admits a favorite lake once its section is reached, ahead of the floor, and lifts it', () => {
    const posts = [post('t1', 1), post('t3', 3)];
    expect(sections({ posts, bodies: [lake('W', 10, true), lake('B', 12)] })).toEqual([
      ['today', ['W', 't1', 't3']],
    ]);
  });

  it('lifts nothing when lift is off: a list that promises newest first', () => {
    const posts = [post('t1', 1), post('t2', 2, true)];
    expect(sections({ posts, favorites: [post('t2', 2, true)], lift: false })).toEqual([
      ['today', ['t1', 't2']],
    ]);
  });

  it('doesn’t lift a Post whose only favorite member went to the recommended strip', () => {
    const mixed = {
      ...post('m', 10, true),
      reports: [
        { reportId: 'fav-r', isFavorite: true },
        { reportId: 'plain-r', isFavorite: false },
      ],
    } as unknown as PostCardData;
    const recommendedIds = new Set(['fav-r']);
    // Not paged in yet: it waits for its page rather than sit below the pages' floor.
    expect(
      sections({ posts: [post('t1', 1), post('t3', 3)], favorites: [mixed], recommendedIds }),
    ).toEqual([['today', ['t1', 't3']]]);
    // Paged in: in its time slot, not lifted.
    expect(
      sections({
        posts: [post('t1', 1), mixed, post('t12', 12)],
        favorites: [mixed],
        recommendedIds,
        exhausted: true,
      }),
    ).toEqual([['today', ['t1', 'm', 't12']]]);
  });

  it('property: headers once and ranked, every shown post kept, only up-front favorites lead', () => {
    const arbPost = fc.record({
      id: fc.integer({ min: 0, max: 40 }),
      age: fc.integer({ min: 0, max: 60 * 24 }),
      fav: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(arbPost, { selector: (p) => p.id, maxLength: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.boolean(),
        fc.array(
          fc.record({
            id: fc.integer({ min: 0, max: 9 }),
            age: fc.integer({ min: 0, max: 60 * 24 }),
            fav: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        (all, cut, exhausted, lakeSpecs) => {
          const season = [...all]
            .sort((a, b) => a.age - b.age)
            .map((p) => post(String(p.id), p.age, p.fav));
          const posts = season.slice(0, cut);
          const favorites = season.filter((p, i) => p.isFavorite && i % 2 === 0);
          const bodies = [...new Map(lakeSpecs.map((l) => [l.id, l])).values()]
            .sort((a, b) => a.age - b.age)
            .map((l) => lake(`L${l.id}`, l.age, l.fav));
          const out = latestFeedSections({
            posts,
            favorites,
            bodies,
            exhausted,
            now: NOW,
            recommendedIds: new Set(),
            lift: true,
          });
          const keys = out.map((s) => s.key);
          expect(new Set(keys).size).toBe(keys.length);
          expect(keys.map((k) => feedSectionRank(k))).toEqual(
            keys.map((k) => feedSectionRank(k)).sort((a, b) => a - b),
          );
          const shown = out.flatMap((s) => s.items.map(rowId));
          expect(new Set(shown).size).toBe(shown.length);
          for (const p of posts) expect(shown).toContain(p.postId);
          const favIds = new Set(favorites.map((f) => f.postId));
          for (const section of out) {
            for (const item of section.items) {
              const t = item.kind === 'report' ? item.data.latestSkateEndTime : item.data.eventMs;
              expect(feedSectionForTime(t, NOW).key).toBe(section.key);
              // Only the up-front read adds Posts the pages haven't brought.
              if (item.kind === 'report' && !posts.includes(item.data)) {
                expect(favIds.has(item.data.postId)).toBe(true);
              }
            }
            // The lifted rows lead: once a row isn't lifted, none after it is.
            const lifted = section.items.map((item) =>
              item.kind === 'report' ? favIds.has(item.data.postId) : item.data.isFavorite,
            );
            const firstPlain = lifted.indexOf(false);
            if (firstPlain !== -1) expect(lifted.slice(firstPlain)).not.toContain(true);
          }
        },
      ),
    );
  });
});

describe('carryFavorites (D292)', () => {
  const full = (ageFrom: number) =>
    Array.from({ length: FAVORITE_LIFT_PER_SECTION }, (_, k) => post(`c${k}`, ageFrom + k, true));
  const ids = (list: readonly PostCardData[]) => list.map((p) => p.postId);
  // Page 1 ends at 1h: everything older in Today is still to come.
  const pages = [post('t0', 0.5), post('t1', 1)];

  it('keeps a favorite a newer one pushed past its section’s cap, until its page arrives', () => {
    const evicted = post('F', 20, true);
    const before = [...full(2).slice(1), evicted];
    const after = full(1.5); // a new favorite arrived; the server's newest five no longer hold F
    expect(ids(carryFavorites(before, after, pages, false, NOW))).toEqual([...ids(after), 'F']);
    // And it is idempotent for the same inputs.
    const once = carryFavorites(before, after, pages, false, NOW);
    expect(carryFavorites(once, after, pages, false, NOW)).toEqual(once);
  });

  it('lets go of a favorite that left with room in its section: hidden, unfavorited, filtered', () => {
    const gone = post('F', 20, true);
    expect(
      ids(carryFavorites([post('c0', 2, true), gone], [post('c0', 2, true)], pages, false, NOW)),
    ).toEqual(['c0']);
  });

  it('lets go once the pages cover its time, or the feed is exhausted: the pages are the truth', () => {
    const evicted = post('F', 20, true);
    const after = full(1.5);
    const reachedPages = [...pages, post('t25', 25)];
    expect(carryFavorites([...after, evicted], after, reachedPages, false, NOW)).toEqual(after);
    expect(carryFavorites([...after, evicted], after, pages, true, NOW)).toEqual(after);
  });

  it('doesn’t carry a favorite newer than one the server kept: that isn’t an eviction', () => {
    const odd = post('F', 1.2, true);
    expect(ids(carryFavorites([odd], full(1.5), pages, false, NOW))).toEqual(ids(full(1.5)));
  });

  it('carries nothing into a section that isn’t full', () => {
    const evicted = post('O', 90 * 24, true);
    expect(ids(carryFavorites([evicted], full(1.5), pages, false, NOW))).toEqual(ids(full(1.5)));
  });
});
