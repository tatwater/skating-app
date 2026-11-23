import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildFeedCardView,
  buildPostCardView,
  type FeedCardData,
  feedSectionForTime,
  formatLocationLine,
  formatPlaceLabel,
  formatRelativeTime,
  groupFeedSections,
  omittedReportsLabel,
  type PostCardData,
  splitLocationLine,
  withFavoritePosts,
} from './feed';

const DAY = 24 * 60 * 60 * 1000;

describe('feedSectionForTime', () => {
  const now = Date.UTC(2026, 0, 20, 12);
  it('buckets by age relative to now', () => {
    expect(feedSectionForTime(now - 1000, now).key).toBe('today');
    expect(feedSectionForTime(now - 1.5 * DAY, now).key).toBe('yesterday');
    expect(feedSectionForTime(now - 4 * DAY, now).key).toBe('this-week');
    expect(feedSectionForTime(now - 15 * DAY, now).key).toBe('this-month');
    expect(feedSectionForTime(now - 90 * DAY, now).key).toBe('older');
  });

  it('treats a future instant (clock skew) as today, never a negative bucket', () => {
    expect(feedSectionForTime(now + DAY, now).key).toBe('today');
  });

  it('carries a human label for the header', () => {
    expect(feedSectionForTime(now - 1000, now).label).toBe('Today');
    expect(feedSectionForTime(now - 90 * DAY, now).label).toBe('Older than a month');
  });
});

describe('groupFeedSections', () => {
  const now = Date.UTC(2026, 0, 20, 12);
  const never = () => false;
  type Row = { id: string; t: number; fav?: boolean };
  const time = (r: Row) => r.t;
  const fav = (r: Row) => r.fav === true;

  it('partitions a newest-first list into recency sections, order preserved', () => {
    const items: Row[] = [
      { id: 'a', t: now - 1000 },
      { id: 'b', t: now - 2000 },
      { id: 'c', t: now - 1.5 * DAY },
      { id: 'd', t: now - 40 * DAY },
    ];
    const sections = groupFeedSections(items, time, now, never);
    expect(sections.map((s) => s.key)).toEqual(['today', 'yesterday', 'older']);
    expect(sections.map((s) => s.label)).toEqual(['Today', 'Yesterday', 'Older than a month']);
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(sections[1]?.items.map((i) => i.id)).toEqual(['c']);
  });

  it('is empty for an empty list', () => {
    expect(groupFeedSections([], () => 0, now, never)).toEqual([]);
  });

  it('draws each header once, newest section first, even from an out-of-order list (D292)', () => {
    const items = [now - 1000, now - 40 * DAY, now - 1.5 * DAY, now - 2000];
    const sections = groupFeedSections(items, (t) => t, now, never);
    expect(sections.map((s) => s.key)).toEqual(['today', 'yesterday', 'older']);
    expect(sections[0]?.items).toEqual([now - 1000, now - 2000]);
  });

  it('leads each section with its favorites, newest first, and keeps the rest newest first', () => {
    // The page the server used to send: favorites hoisted over the whole page.
    const items: Row[] = [
      { id: 'fav-today', t: now - 3000, fav: true },
      { id: 'fav-old', t: now - 128 * DAY, fav: true },
      { id: 'today-1', t: now - 1000 },
      { id: 'today-2', t: now - 2000 },
      { id: 'old', t: now - 99 * DAY },
    ];
    const sections = groupFeedSections(items, time, now, fav);
    expect(sections.map((s) => s.key)).toEqual(['today', 'older']);
    expect(sections.map((s) => s.items.map((i) => i.id))).toEqual([
      ['fav-today', 'today-1', 'today-2'],
      ['fav-old', 'old'],
    ]);
  });

  it('keeps the input order of rows that tie on favorite and time', () => {
    const items: Row[] = [
      { id: 'x', t: now - 1000 },
      { id: 'y', t: now - 1000 },
      { id: 'z', t: now - 1000 },
    ];
    expect(groupFeedSections(items, time, now, never)[0]?.items.map((i) => i.id)).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('property: any order in, each key once, ranked, favorites leading, every row kept', () => {
    const rank = ['today', 'yesterday', 'this-week', 'this-month', 'older'];
    const row = fc.record({
      id: fc.uuid(),
      // Spans the future (clock skew) through well past a month.
      t: fc.integer({ min: now - 60 * DAY, max: now + DAY }),
      fav: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 40 }), (items) => {
        const sections = groupFeedSections(items, time, now, fav);
        const keys = sections.map((s) => s.key);
        // Never "Today / Older / Today": each header at most once, newest section first.
        expect(new Set(keys).size).toBe(keys.length);
        expect([...keys].sort((a, b) => rank.indexOf(a) - rank.indexOf(b))).toEqual(keys);
        // Nothing dropped or duplicated, and every row sits under its own bucket.
        expect(
          sections
            .flatMap((s) => s.items.map((i) => i.id))
            .sort()
            .join(),
        ).toBe(
          items
            .map((i) => i.id)
            .sort()
            .join(),
        );
        for (const section of sections) {
          expect(section.items.length).toBeGreaterThan(0);
          for (const item of section.items) {
            expect(feedSectionForTime(item.t, now).key).toBe(section.key);
          }
          // Favorites first, then the rest; each group newest first.
          const favs = section.items.filter(fav);
          const rest = section.items.filter((i) => !fav(i));
          expect(section.items).toEqual([...favs, ...rest]);
          for (const group of [favs, rest]) {
            for (let i = 1; i < group.length; i++) {
              expect((group[i - 1] as Row).t).toBeGreaterThanOrEqual((group[i] as Row).t);
            }
          }
        }
      }),
    );
  });
});

describe('withFavoritePosts', () => {
  const now = Date.UTC(2026, 0, 20, 12);
  const post = (postId: string, t: number, isFavorite = false) =>
    ({ postId, latestSkateEndTime: t, isFavorite }) as PostCardData;
  const ids = (list: readonly PostCardData[]) => list.map((p) => p.postId);

  it('adds a favorite the pages have not reached yet, in its own section, newest first', () => {
    // Page 1 ends inside Today; the 25th-newest post, a favorite, is in Today too.
    const pages = [post('a', now - 1000), post('b', now - 5000)];
    const favs = [post('f', now - 9000, true)];
    expect(ids(withFavoritePosts(pages, favs, false, now))).toEqual(['a', 'b', 'f']);
  });

  it('holds back a favorite whose section the scroll has not reached', () => {
    const pages = [post('a', now - 1000)];
    const favs = [post('old', now - 90 * DAY, true)];
    expect(ids(withFavoritePosts(pages, favs, false, now))).toEqual(['a']);
    // Once the pages are exhausted every section is reached.
    expect(ids(withFavoritePosts(pages, favs, true, now))).toEqual(['a', 'old']);
  });

  it('admits nothing before a first page arrives, unless the feed is exhausted', () => {
    const favs = [post('f', now - 1000, true)];
    expect(withFavoritePosts([], favs, false, now)).toEqual([]);
    expect(ids(withFavoritePosts([], favs, true, now))).toEqual(['f']);
  });

  it('keeps the paginated copy of a post both lists hold', () => {
    const paged = { ...post('a', now - 1000, true), omittedCount: 1 } as PostCardData;
    const out = withFavoritePosts([paged], [post('a', now - 1000, true)], false, now);
    expect(out).toEqual([paged]);
  });

  it('property: every page kept, no repeats, newest first, favorites only in reached sections', () => {
    const rank = ['today', 'yesterday', 'this-week', 'this-month', 'older'];
    const t = fc.integer({ min: now - 60 * DAY, max: now });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: 60 }), t), {
          selector: ([id]) => id,
          maxLength: 30,
        }),
        fc.integer({ min: 0, max: 30 }),
        fc.boolean(),
        (rows, cut, exhausted) => {
          // One newest-first season: the first `cut` rows are paged in, a subset of all are favorites.
          const all = [...rows]
            .sort((x, y) => y[1] - x[1])
            .map(([id, at]) => post(String(id), at, id % 3 === 0));
          const pages = all.slice(0, cut);
          const favs = all.filter((p) => p.isFavorite);
          const out = withFavoritePosts(pages, favs, exhausted, now);
          expect(new Set(ids(out)).size).toBe(out.length);
          for (const p of pages) expect(out).toContain(p);
          for (let i = 1; i < out.length; i++) {
            expect((out[i - 1] as PostCardData).latestSkateEndTime).toBeGreaterThanOrEqual(
              (out[i] as PostCardData).latestSkateEndTime,
            );
          }
          const last = pages[pages.length - 1];
          const reached = exhausted
            ? rank.length
            : last === undefined
              ? -1
              : rank.indexOf(feedSectionForTime(last.latestSkateEndTime, now).key);
          for (const p of out) {
            if (pages.includes(p)) continue;
            expect(p.isFavorite).toBe(true);
            expect(
              rank.indexOf(feedSectionForTime(p.latestSkateEndTime, now).key),
            ).toBeLessThanOrEqual(reached);
          }
          // Every favorite in a reached section is in.
          for (const f of favs) {
            const r = rank.indexOf(feedSectionForTime(f.latestSkateEndTime, now).key);
            if (r <= reached) expect(ids(out)).toContain(f.postId);
          }
        },
      ),
    );
  });
});

describe('formatPlaceLabel', () => {
  it('prefers the town, joined to the state', () => {
    expect(formatPlaceLabel({ town: 'Stowe', county: 'Lamoille County', state: 'VT' })).toBe(
      'Stowe, VT',
    );
  });

  it('falls back to the county when there is no town', () => {
    expect(formatPlaceLabel({ county: 'Chittenden County', state: 'VT' })).toBe(
      'Chittenden County, VT',
    );
  });

  it('falls back to the bare state when only a state resolved', () => {
    expect(formatPlaceLabel({ state: 'NY' })).toBe('NY');
  });

  it('returns null when nothing resolved (ocean / no-match)', () => {
    expect(formatPlaceLabel(undefined)).toBeNull();
    expect(formatPlaceLabel({})).toBeNull();
    expect(formatPlaceLabel({ town: '  ', state: '  ' })).toBeNull();
  });

  it('returns just the place name when a state is somehow absent', () => {
    expect(formatPlaceLabel({ town: 'Burlington' })).toBe('Burlington');
  });
});

describe('formatLocationLine', () => {
  const place = { town: 'Colchester', county: 'Chittenden County', state: 'VT' };

  it('puts the sub-area ahead of the body and the town — the A02 headline case', () => {
    expect(
      formatLocationLine({ subAreaName: 'Malletts Bay', bodyName: 'Lake Champlain', place }),
    ).toBe('Malletts Bay · Lake Champlain · Colchester, VT');
  });

  it('omits the sub-area segment for the overwhelming majority of bodies that have none', () => {
    expect(
      formatLocationLine({ bodyName: 'Lake Morey', place: { town: 'Fairlee', state: 'VT' } }),
    ).toBe('Lake Morey · Fairlee, VT');
  });

  it('omits the place segment when nothing resolved, without leaving a dangling separator', () => {
    expect(formatLocationLine({ subAreaName: 'Malletts Bay', bodyName: 'Lake Champlain' })).toBe(
      'Malletts Bay · Lake Champlain',
    );
    expect(formatLocationLine({ bodyName: 'Lake Champlain', place: {} })).toBe('Lake Champlain');
  });

  it('treats a whitespace-only sub-area name as absent', () => {
    expect(formatLocationLine({ subAreaName: '   ', bodyName: 'Lake Champlain' })).toBe(
      'Lake Champlain',
    );
  });

  it('lists every member bay of a two-bay skate, and the list outranks the single stamp (A09)', () => {
    expect(
      formatLocationLine({
        subAreaName: 'Malletts Bay',
        subAreaNames: ['Malletts Bay', 'Shelburne Bay'],
        bodyName: 'Lake Champlain',
        place,
      }),
    ).toBe('Malletts Bay & Shelburne Bay · Lake Champlain · Colchester, VT');
    // An empty or blank list falls back to the single stamp rather than to nothing.
    expect(
      formatLocationLine({
        subAreaName: 'Malletts Bay',
        subAreaNames: [' '],
        bodyName: 'Lake Champlain',
      }),
    ).toBe('Malletts Bay · Lake Champlain');
    // And the two-row split shares the same segment, so the heading is the whole list.
    expect(
      splitLocationLine({
        subAreaNames: ['Malletts Bay', 'Shelburne Bay'],
        bodyName: 'Lake Champlain',
      }).primary,
    ).toBe('Malletts Bay & Shelburne Bay');
  });
});

describe('splitLocationLine', () => {
  it('shares its segments with formatLocationLine — same order, same omissions', () => {
    const parts = {
      subAreaName: 'Malletts Bay',
      bodyName: 'Lake Champlain',
      place: { town: 'Colchester', state: 'VT' },
    };
    const { primary, secondary } = splitLocationLine(parts);
    expect([primary, secondary].filter(Boolean).join(' · ')).toBe(formatLocationLine(parts));
  });

  it('leaves the secondary row null when there is nothing coarser to say', () => {
    expect(splitLocationLine({ bodyName: 'Lake Morey' })).toEqual({
      primary: 'Lake Morey',
      secondary: null,
    });
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0);

  it('labels sub-minute, minute, hour, day, and week buckets', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
    expect(formatRelativeTime(now - 21 * 24 * 60 * 60_000, now)).toBe('3w ago');
  });

  it('reads a future instant (clock skew) as just now, never negative', () => {
    expect(formatRelativeTime(now + 10 * 60_000, now)).toBe('just now');
  });

  it('never produces a negative magnitude (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * 24 * 60 * 60_000 }), (ageMs) => {
        const label = formatRelativeTime(now - ageMs, now);
        expect(label).not.toMatch(/-/);
      }),
    );
  });
});

const CARD: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'wb1',
  bodyName: 'Lake Champlain',
  place: { town: 'Burlington', county: 'Chittenden County', state: 'VT' },
  skateEndTime: Date.UTC(2026, 0, 5, 11, 0),
  skateStartTime: Date.UTC(2026, 0, 5, 9, 30),
  iceTypes: ['black_ice'],
  surfaceTags: ['glass', 'orange_peel'],
  skateQuality: 'great',
  photoThumbUrls: ['https://x/thumb1.jpg'],
  author: { displayName: 'Ada Skater', username: 'ada' },
  blocked: false,
};

describe('buildFeedCardView', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0);

  it('shapes a full card: label, relative time, duration, quality, humanized chips', () => {
    const view = buildFeedCardView(CARD, now);
    expect(view.bodyName).toBe('Lake Champlain');
    expect(view.placeLabel).toBe('Burlington, VT');
    expect(view.relativeTime).toBe('1h ago');
    expect(view.durationLabel).toBe('1h 30m');
    expect(view.qualityLabel).toBe('Great');
    expect(view.chips).toEqual(['Black ice', 'Glass', 'Orange peel']);
    expect(view.photoThumbUrls).toEqual(['https://x/thumb1.jpg']);
    expect(view.author).toEqual({ displayName: 'Ada Skater', username: 'ada' });
    expect(view.blocked).toBe(false);
    expect(view.isFavorite).toBe(false); // defaults false when the server omits it
  });

  it('carries the A10 axes: suitability leads, the vantage only off the ice, the sighting (§12.1)', () => {
    const plain = buildFeedCardView(CARD, now);
    expect(plain.suitabilityLabel).toBeNull();
    expect(plain.vantageLabel).toBeNull();
    expect(plain.sightingLabels).toEqual([]);
    expect(plain.isDontGo).toBe(false);
    const onIce = buildFeedCardView({ ...CARD, observedFrom: 'on_ice' }, now);
    expect(onIce.vantageLabel).toBeNull(); // the default says nothing a reader needs
    const shore = buildFeedCardView(
      { ...CARD, suitability: 'dont_go', observedFrom: 'shore', sighting: 'open' },
      now,
    );
    expect(shore.suitabilityLabel).toBe("Don't go");
    expect(shore.isDontGo).toBe(true);
    expect(shore.vantageLabel).toBe('From shore');
    expect(shore.sightingLabels).toEqual(['Still open']);
    const located = buildFeedCardView(
      {
        ...CARD,
        observedFrom: 'on_ice',
        sightings: [
          { type: 'open', where: { sector: 'S' } },
          { type: 'frozen', where: { extent: 'large_areas' } },
        ],
      },
      now,
    );
    expect(located.sightingLabels).toEqual(['Still open, south end', 'Frozen over, large areas']);
    // The card carries no bay names: a bay is still a part of the lake, and two read as one line.
    const bays = buildFeedCardView(
      {
        ...CARD,
        observedFrom: 'on_ice',
        sightings: [
          { type: 'frozen', where: { subAreaId: 'bay1' } },
          { type: 'frozen', where: { subAreaId: 'bay2' } },
        ],
      },
      now,
    );
    expect(bays.sightingLabels).toEqual(['Frozen over, part of the lake']);
    expect(buildFeedCardView({ ...CARD, observedFrom: 'secondhand' }, now).vantageLabel).toBe(
      'Secondhand',
    );
  });

  it('carries the favorite flag through to the view (Phase 04)', () => {
    expect(buildFeedCardView({ ...CARD, isFavorite: true }, now).isFavorite).toBe(true);
  });

  it('splits the location into card rows, with and without a sub-area (A02)', () => {
    const plain = buildFeedCardView(CARD, now);
    expect(plain.locationPrimary).toBe('Lake Champlain');
    expect(plain.locationSecondary).toBe('Burlington, VT');

    // On a lake with named bays the bay becomes the heading — it's the name skaters use — and the
    // lake drops into the sub-line beside the town.
    const bay = buildFeedCardView({ ...CARD, subAreaName: 'Malletts Bay' }, now);
    expect(bay.locationPrimary).toBe('Malletts Bay');
    expect(bay.locationSecondary).toBe('Lake Champlain · Burlington, VT');
  });

  it('handles an end-only report with no place, quality, or photos', () => {
    const view = buildFeedCardView(
      {
        ...CARD,
        place: undefined,
        skateStartTime: undefined,
        skateQuality: undefined,
        iceTypes: [],
        surfaceTags: [],
        photoThumbUrls: [],
        blocked: true,
      },
      now,
    );
    expect(view.placeLabel).toBeNull();
    expect(view.durationLabel).toBeNull();
    expect(view.qualityLabel).toBeNull();
    expect(view.chips).toEqual([]);
    expect(view.photoThumbUrls).toEqual([]);
    expect(view.blocked).toBe(true);
  });
});

describe('the Hike-In chip on the feed card (A06d / D87)', () => {
  const base = {
    reportId: 'r1',
    waterBodyId: 'w1',
    bodyName: 'Test Pond',
    skateEndTime: Date.UTC(2027, 0, 10),
    iceTypes: [],
    surfaceTags: [],
    photoThumbUrls: [],
    author: { displayName: 'A', username: 'a' },
    blocked: false,
  };

  /**
   * The drive-time filter is what this corrects. A skater filtering to "within 60 minutes" is
   * filtering on *drive* time, and a hike-in lake inside that band is not the trip they think they
   * are being offered.
   */
  it('only hike_in chips — the other kinds are unremarkable', () => {
    expect(buildFeedCardView({ ...base, accessKind: 'hike_in' }, base.skateEndTime).isHikeIn).toBe(
      true,
    );
    for (const kind of ['drive_up', 'short_walk', undefined]) {
      expect(
        buildFeedCardView({ ...base, ...(kind ? { accessKind: kind } : {}) }, base.skateEndTime)
          .isHikeIn,
      ).toBe(false);
    }
  });
});

describe('buildPostCardView (A10 / D186)', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0);
  const post = (over: Partial<PostCardData>): PostCardData => ({
    postId: 'p1',
    latestSkateEndTime: CARD.skateEndTime,
    author: CARD.author,
    blocked: false,
    isFavorite: false,
    reports: [CARD],
    omittedCount: 0,
    ...over,
  });

  it('a legacy Post — one Report, no words — draws no header: the card as it always was', () => {
    const view = buildPostCardView(post({}), now);
    expect(view.hasHeader).toBe(false);
    expect(view.title).toBeNull();
    expect(view.body).toBeNull();
    expect(view.reports).toHaveLength(1);
    expect(view.omittedLabel).toBeNull();
  });

  it('a title, prose, a second Report or an omitted one each earn the header', () => {
    expect(buildPostCardView(post({ title: 'Morey 1/5' }), now).hasHeader).toBe(true);
    expect(buildPostCardView(post({ body: 'Glass.' }), now).hasHeader).toBe(true);
    expect(buildPostCardView(post({ reports: [CARD, CARD] }), now).hasHeader).toBe(true);
    expect(buildPostCardView(post({ omittedCount: 1 }), now).hasHeader).toBe(true);
  });

  it('the header time is the Post’s sort key, and the omitted line counts lakes honestly', () => {
    const view = buildPostCardView(
      post({ latestSkateEndTime: now - 2 * 60 * 60 * 1000, omittedCount: 2 }),
      now,
    );
    expect(view.relativeTime).toBe('2h ago');
    expect(view.omittedLabel).toBe('2 more lakes outside your filters');
    expect(omittedReportsLabel(1)).toBe('1 more lake outside your filters');
    expect(omittedReportsLabel(0)).toBeNull();
  });
});
