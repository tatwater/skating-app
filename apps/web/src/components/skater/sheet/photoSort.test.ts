import { openPostSheet, reportEndMs, selectedValues } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyPhotoTabs,
  dayKey,
  type SortablePhoto,
  type SortLake,
  sortNote,
  sortPhotosIntoTabs,
} from './photoSort';

const NH = 'America/New_York';
// Saturday 16 January 2027 in New Hampshire; Thursday the 14th two days before.
const SAT_10 = Date.UTC(2027, 0, 16, 15, 0);
const THU_15 = Date.UTC(2027, 0, 14, 20, 12);
const MASCOMA: SortLake = { waterBodyId: 'mascoma', name: 'Mascoma Lake' };
const CRYSTAL: SortLake = { waterBodyId: 'crystal', name: 'Crystal Lake' };
const SMITH: SortLake = { waterBodyId: 'smith', name: 'Smith Pond' };
const LAKES = [MASCOMA, CRYSTAL, SMITH];
const at = (lake: SortLake) => ({ lat: LAKES.indexOf(lake), lng: 0 });
const lakeOf = (p: SortablePhoto) => (p.coord ? (LAKES[p.coord.lat] ?? null) : null);

describe('sortPhotosIntoTabs (5.17.1)', () => {
  it('makes one tab per lake and day, in day order, morning first', () => {
    const photos: SortablePhoto[] = [
      { id: 'c1', coord: at(CRYSTAL), takenAtMs: SAT_10 + 4 * 3600_000 },
      { id: 'm1', coord: at(MASCOMA), takenAtMs: SAT_10 },
      { id: 's1', coord: at(SMITH), takenAtMs: THU_15 },
      { id: 'm2', coord: at(MASCOMA), takenAtMs: SAT_10 + 3600_000 },
    ];
    const tabs = sortPhotosIntoTabs(photos, lakeOf, NH);
    expect(tabs.map((t) => [t.name, t.day, t.photoIds])).toEqual([
      ['Smith Pond', '2027-01-14', ['s1']],
      ['Mascoma Lake', '2027-01-16', ['m1', 'm2']],
      ['Crystal Lake', '2027-01-16', ['c1']],
    ]);
    expect(tabs[1]).toMatchObject({ startMs: SAT_10, endMs: SAT_10 + 3600_000 });
  });

  it('puts a placeless photo with the same-day tab nearest in time, an undated one on its lake', () => {
    const tabs = sortPhotosIntoTabs(
      [
        { id: 'm1', coord: at(MASCOMA), takenAtMs: SAT_10 },
        { id: 'c1', coord: at(CRYSTAL), takenAtMs: SAT_10 + 5 * 3600_000 },
        { id: 'x', takenAtMs: SAT_10 + 4.5 * 3600_000 },
        { id: 'y' },
        { id: 'u', coord: at(CRYSTAL) },
        { id: 'z', takenAtMs: THU_15 },
        { id: 'n', coord: at(SMITH) },
      ],
      lakeOf,
      NH,
    );
    const where = (id: string) => tabs.find((t) => t.photoIds.includes(id))?.name;
    expect(where('x')).toBe('Crystal Lake');
    expect(where('y')).toBe('Mascoma Lake');
    expect(where('u')).toBe('Crystal Lake');
    // No tab on Thursday: the nearest in time.
    expect(where('z')).toBe('Mascoma Lake');
    // A lake with only an undated photo still gets its tab, after the dated ones.
    expect(tabs.at(-1)).toMatchObject({ name: 'Smith Pond', day: null, photoIds: ['n'] });
  });

  it('sorts nothing when no photo names a lake', () => {
    expect(sortPhotosIntoTabs([{ id: 'a', takenAtMs: SAT_10 }, { id: 'b' }], lakeOf, NH)).toEqual(
      [],
    );
  });

  const photoArb = fc.record(
    {
      lake: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
      takenAtMs: fc.option(fc.integer({ min: THU_15 - 3 * 86_400_000, max: SAT_10 + 86_400_000 }), {
        nil: undefined,
      }),
    },
    { requiredKeys: [] },
  );
  const photosArb = fc.array(photoArb, { maxLength: 40 }).map((xs) =>
    xs.map(
      (x, i): SortablePhoto => ({
        id: `p${i}`,
        ...(x.lake !== undefined ? { coord: { lat: x.lake, lng: 0 } } : {}),
        ...(x.takenAtMs !== undefined ? { takenAtMs: x.takenAtMs } : {}),
      }),
    ),
  );

  it('lands every photo in exactly one tab whenever it sorts at all', () => {
    fc.assert(
      fc.property(photosArb, (photos) => {
        const tabs = sortPhotosIntoTabs(photos, lakeOf, NH);
        const named = photos.some((p) => p.coord !== undefined);
        if (!named) {
          expect(tabs).toEqual([]);
          return;
        }
        const ids = tabs.flatMap((t) => t.photoIds);
        expect(ids.slice().sort()).toEqual(photos.map((p) => p.id).sort());
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });

  it('orders the tabs by day, an undated tab last', () => {
    fc.assert(
      fc.property(photosArb, (photos) => {
        const days = sortPhotosIntoTabs(photos, lakeOf, NH).map((t) => t.day);
        const firstNull = days.indexOf(null);
        if (firstNull >= 0) expect(days.slice(firstNull).every((d) => d === null)).toBe(true);
        const dated = days.filter((d): d is string => d !== null);
        expect(dated).toEqual(dated.slice().sort());
      }),
    );
  });
});

describe('sortNote', () => {
  it('says how many lakes and days, and that each is a tab', () => {
    const tabs = sortPhotosIntoTabs(
      [
        ...[0, 1, 2, 3].map((i) => ({ id: `m${i}`, coord: at(MASCOMA), takenAtMs: SAT_10 + i })),
        ...[0, 1].map((i) => ({ id: `c${i}`, coord: at(CRYSTAL), takenAtMs: SAT_10 + 5e6 + i })),
        ...[0, 1].map((i) => ({ id: `s${i}`, coord: at(SMITH), takenAtMs: THU_15 + i })),
      ],
      lakeOf,
      NH,
    );
    expect(sortNote(tabs)).toBe(
      'Your 8 photos were taken on three lakes over two days, so they start three reports, one per tab. A photo’s number is its tab.',
    );
  });

  it('is quiet for one tab, and says one lake when the days differ', () => {
    expect(sortNote([])).toBeNull();
    const tabs = sortPhotosIntoTabs(
      [
        { id: 'a', coord: at(MASCOMA), takenAtMs: SAT_10 },
        { id: 'b', coord: at(MASCOMA), takenAtMs: THU_15 },
      ],
      lakeOf,
      NH,
    );
    expect(sortNote(tabs)).toBe(
      'Your 2 photos were taken on one lake over two days, so they start two reports, one per tab. A photo’s number is its tab.',
    );
  });
});

describe('applyPhotoTabs', () => {
  let n = 0;
  const mint = () => `id-${++n}`;
  const photo = (id: string, takenAtMs: number) => ({
    id,
    fullUri: `${id}:full`,
    thumbUri: `${id}:thumb`,
    takenAtMs,
    placeOnMap: false,
  });

  it('answers the blank Report with the first tab and opens a Report for each other', () => {
    const blank = openPostSheet('page', {}, SAT_10, mint);
    const post = { ...blank, photos: [photo('m1', SAT_10), photo('c1', SAT_10 + 4 * 3600_000)] };
    const tabs = sortPhotosIntoTabs(
      post.photos.map((p) => ({ ...p, coord: at(p.id === 'm1' ? MASCOMA : CRYSTAL) })),
      lakeOf,
      NH,
    );
    const active = blank.reports[0]?.id as string;
    const out = applyPhotoTabs(post, tabs, {
      activeId: active,
      timeZone: NH,
      now: SAT_10,
      mint,
      outlines: {},
    });
    expect(out.firstReportId).toBe(active);
    expect(out.post.dirty).toBe(true);
    expect(out.post.photos).toEqual([]);
    expect(out.post.reports.map((r) => [r.bodyName, r.photos.map((p) => p.id)])).toEqual([
      ['Mascoma Lake', ['m1']],
      ['Crystal Lake', ['c1']],
    ]);
    expect(reportEndMs(out.post.reports[1] as never)).toBe(SAT_10 + 4 * 3600_000);
  });

  it('reuses the Report already about that lake and day, and seeds its start from the photos', () => {
    const open = openPostSheet(
      'body',
      { waterBodyId: 'mascoma', bodyName: 'Mascoma Lake' },
      SAT_10,
      mint,
    );
    const post = { ...open, photos: [photo('a', SAT_10), photo('b', SAT_10 + 3600_000)] };
    const tabs = sortPhotosIntoTabs(
      post.photos.map((p) => ({ ...p, coord: at(MASCOMA) })),
      lakeOf,
      NH,
    );
    const out = applyPhotoTabs(post, tabs, {
      activeId: open.reports[0]?.id as string,
      timeZone: NH,
      now: SAT_10,
      mint,
      outlines: {},
    });
    expect(out.post.reports).toHaveLength(1);
    const sheet = out.post.reports[0]?.sheet;
    expect(sheet?.scalars.skateStartTime).toBe(SAT_10);
    expect(selectedValues(sheet as never, 'endTime')[0]?.ms).toBe(SAT_10 + 3600_000);
  });

  it('opens a new Report for a lake whose Report is on another day', () => {
    const open = openPostSheet(
      'body',
      { waterBodyId: 'mascoma', bodyName: 'Mascoma Lake', gpsWindow: { endMs: SAT_10 } },
      SAT_10,
      mint,
    );
    const post = { ...open, photos: [photo('t', THU_15)] };
    const tabs = sortPhotosIntoTabs([{ ...photo('t', THU_15), coord: at(MASCOMA) }], lakeOf, NH);
    const out = applyPhotoTabs(post, tabs, {
      activeId: open.reports[0]?.id as string,
      timeZone: NH,
      now: SAT_10,
      mint,
      outlines: {},
    });
    expect(out.post.reports).toHaveLength(2);
    expect(dayKey(reportEndMs(out.post.reports[1] as never) as number, NH)).toBe('2027-01-14');
  });
});
