/**
 * Removing what the author added, held under arbitrary interleavings: a removed Report stays
 * removed — the photo sort never opens it again, across closing and reopening the sheet and
 * reloading the page, unless the author picks a new photo there — and every removal reaches the
 * stored draft and what *Post* would send, survives a reload, and leaves no orphan: no photo on the
 * sheet without its file, no file without its photo, no removed Report's photo on a Report by
 * itself, no Post without a Report.
 *
 * Each run drives the real store, the real blob reconcile (against a fresh fake IndexedDB) and the
 * pool's real sort memory, as `PhotoSorter` runs it.
 */

import {
  assignCandidates,
  type DraftPhoto,
  dropPhoto,
  type PostSheet,
  reassignPool,
  toPostDraft,
} from '@skating/core';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { whenSheetPhotosSettled } from '@/lib/sheetPhotos';
import {
  bindSheetOwner,
  getSheet,
  resetSheetStoreForTests,
  restoreStoredSheet,
  setSheet,
  updateSheet,
} from '@/lib/sheetStore';
import {
  DAY_MS,
  installFakeStore,
  openSheet,
  pickPhoto,
  reloadPage,
  stubObjectUrls,
} from '@/lib/sheetStore.fixtures';
import { property } from '@/lib/sheetStore.propertyRuns';
import { releaseIfDropped } from './photoRelease';
import {
  applySortedPool,
  openSortMemory,
  photosToSort,
  type SortLake,
  sortPhotosIntoTabs,
} from './photoSort';
import { removeLake } from './sheetModel';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));

const KEY = 'skating.reportSheet.v2';
const BASE_TIME = Date.UTC(2026, 0, 10, 20);
const ZONE = 'UTC';
const mint = () => crypto.randomUUID();

/** Two lakes the lookup knows, by the place a photo was taken. */
const LAKES: readonly { coord: { lat: number; lng: number }; lake: SortLake }[] = [
  { coord: { lat: 43.6, lng: -72.1 }, lake: { waterBodyId: 'b1', name: 'Mascoma Lake' } },
  { coord: { lat: 43.7, lng: -72.2 }, lake: { waterBodyId: 'b2', name: 'Crystal Lake' } },
];

const lakeOf = (photo: { coord?: { lat: number; lng: number } }): SortLake | null =>
  LAKES.find((l) => l.coord.lat === photo.coord?.lat && l.coord.lng === photo.coord?.lng)?.lake ??
  null;

/** One move: the author's, or the browser's. */
type Op =
  | { t: 'pickToPool'; lake: number; day: number }
  | { t: 'pickOntoReport'; pick: number; lake: number; day: number }
  | { t: 'removeReport'; pick: number }
  | { t: 'removePhoto'; pick: number }
  | { t: 'type'; text: string }
  | { t: 'closeReopen' }
  | { t: 'reload' }
  | { t: 'settle' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ lake: fc.nat(1), day: fc.nat(1) })
      .map<Op>((o) => ({ t: 'pickToPool', ...o })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ pick: fc.nat(4), lake: fc.nat(1), day: fc.nat(1) })
      .map<Op>((o) => ({ t: 'pickOntoReport', ...o })),
  },
  { weight: 4, arbitrary: fc.nat(4).map<Op>((pick) => ({ t: 'removeReport', pick })) },
  { weight: 2, arbitrary: fc.nat(8).map<Op>((pick) => ({ t: 'removePhoto', pick })) },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }).map<Op>((text) => ({ t: 'type', text })) },
  { weight: 2, arbitrary: fc.constant<Op>({ t: 'closeReopen' }) },
  { weight: 2, arbitrary: fc.constant<Op>({ t: 'reload' }) },
  { weight: 2, arbitrary: fc.constant<Op>({ t: 'settle' }) },
);

const photosOf = (post: PostSheet): DraftPhoto[] => [
  ...post.reports.flatMap((r) => r.photos),
  ...(post.photos ?? []),
];
const idsOf = (post: PostSheet) => photosOf(post).map((p) => p.id);
const sorted = (ids: readonly string[]) => [...ids].sort();

interface StoredRecord {
  sheet: PostSheet;
  photos?: { reports?: Record<string, DraftPhoto[]>; pool?: DraftPhoto[] };
}

function stored(): StoredRecord | null {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as StoredRecord);
}

function current(): PostSheet {
  const post = getSheet();
  if (post === null) throw new Error('The sheet should be open');
  return post;
}

/** `PhotoSorter`'s turn against `memory`, with the lookup answered at once. */
function sortPool(memory: Set<string>): void {
  const fresh = photosToSort(memory, current());
  if (fresh.length === 0) return;
  const tabs = sortPhotosIntoTabs(fresh, lakeOf, ZONE);
  if (tabs.length === 0) return;
  updateSheet(
    (p) =>
      applySortedPool(p, tabs, {
        activeId: p.reports[0]?.id ?? '',
        timeZone: ZONE,
        now: Date.now(),
        mint,
        outlines: {},
      })?.post ?? p,
  );
}

/**
 * The sheet's own pool rule (`ReportSheet`'s effect on the pool): the day puts a pool photo on the
 * Report whose window holds its time. It may take a removed lake's photo to another lake already on
 * the sheet — the designed rule (`removeLake`: "for the day, or the author, to put them on another")
 * — but it never opens a Report, and with no outline known it never pins one.
 */
function dayRule(): void {
  updateSheet((p) => reassignPool(p, assignCandidates(p, {})), { quiet: true });
}

type Fake = ReturnType<typeof installFakeStore>;

/**
 * One sheet's life. After every move: Reports appear only when the author picked a photo; a removed
 * Report's photos are never pinned and never open a Report of their own; the stored draft and the
 * Post that would go out hold exactly the sheet; and once storage settles, every photo has its file
 * and every file its photo.
 */
async function scenario(ops: readonly Op[]): Promise<void> {
  await whenSheetPhotosSettled();
  resetSheetStoreForTests();
  window.localStorage.clear();
  stubObjectUrls();
  const fake: Fake = installFakeStore();
  vi.setSystemTime(BASE_TIME);
  bindSheetOwner('user_a');
  setSheet(openSheet());
  /** The mounted sorter's memory: a new one each time the sheet opens. */
  let memory = openSortMemory(current());
  /** Photos whose Report the author removed, still on the sheet. */
  const orphaned = new Set<string>();

  const photo = (lake: number, day: number) => ({
    coord: LAKES[lake]?.coord,
    takenAtMs: BASE_TIME - day * DAY_MS - 3_600_000,
  });

  const expectHeld = () => {
    const post = current();
    // A Post always has a Report.
    expect(post.reports.length).toBeGreaterThan(0);
    // A removed Report's photos are never pinned on their own: they wait in the pool, or the day's
    // rule put them on a lake already here — unplaced either way, never on a Report of their own.
    for (const id of orphaned) {
      const found = photosOf(post).find((p) => p.id === id);
      expect(found?.placeOnMap).toBe(false);
    }
    // The stored draft is the sheet.
    const record = stored();
    expect(record?.sheet.reports.map((r) => r.id)).toEqual(post.reports.map((r) => r.id));
    const claimed = [
      ...Object.values(record?.photos?.reports ?? {}).flat(),
      ...(record?.photos?.pool ?? []),
    ].map((p) => p.id);
    expect(sorted(claimed)).toEqual(sorted(idsOf(post)));
    // What *Post* would send is the sheet: the same Reports, the same photos, where they sit.
    const draft = toPostDraft(post, 'pending', Date.now());
    expect(draft.reports.map((r) => r.id)).toEqual(post.reports.map((r) => r.id));
    for (const r of post.reports) {
      expect(draft.reports.find((d) => d.id === r.id)?.photos.map((p) => p.id)).toEqual(
        r.photos.map((p) => p.id),
      );
    }
    expect(sorted((draft.photos ?? []).map((p) => p.id))).toEqual(
      sorted((post.photos ?? []).map((p) => p.id)),
    );
  };

  for (const op of ops) {
    const before = current().reports.map((r) => r.id);
    switch (op.t) {
      case 'pickToPool':
        await pickPhoto({ pool: true }, photo(op.lake, op.day));
        break;
      case 'pickOntoReport': {
        const reports = current().reports;
        const target = reports[op.pick % reports.length];
        if (target) await pickPhoto({ reportId: target.id }, photo(op.lake, op.day));
        break;
      }
      case 'removeReport': {
        const reports = current().reports;
        const target = reports[op.pick % reports.length];
        if (target === undefined) break;
        for (const p of target.photos) orphaned.add(p.id);
        updateSheet((p) => removeLake(p, target.id, Date.now(), mint));
        if (reports.length === 1) {
          // The only Report starts over on *Which lake?*, keeping its photos, unplaced.
          for (const p of target.photos) orphaned.delete(p.id);
          expect(current().reports[0]?.photos.map((p) => [p.id, p.placeOnMap])).toEqual(
            target.photos.map((p) => [p.id, false]),
          );
        }
        break;
      }
      case 'removePhoto': {
        const all = idsOf(current());
        const id = all[op.pick % Math.max(all.length, 1)];
        if (id === undefined) break;
        updateSheet((p) => dropPhoto(p, id));
        releaseIfDropped(id);
        orphaned.delete(id);
        expect(idsOf(current())).not.toContain(id);
        break;
      }
      case 'type':
        updateSheet((p) => ({ ...p, title: op.text, dirty: true }));
        break;
      case 'closeReopen':
        // The sheet closes (the draft stays) and opens again: a new sorter, a new memory.
        memory = openSortMemory(current());
        break;
      case 'reload': {
        const was = current();
        await whenSheetPhotosSettled();
        reloadPage('user_a');
        const restored = await restoreStoredSheet(Date.now());
        expect(restored?.photosLost).toBe(0);
        expect(restored?.sheet.reports.map((r) => r.id)).toEqual(was.reports.map((r) => r.id));
        expect(sorted(restored ? idsOf(restored.sheet) : [])).toEqual(sorted(idsOf(was)));
        setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
        memory = openSortMemory(current());
        break;
      }
      case 'settle': {
        await whenSheetPhotosSettled();
        const ids = new Set(idsOf(current()));
        // Every photo has its file, and every file its photo.
        expect(sorted([...fake.rows.keys()])).toEqual(sorted([...ids]));
        break;
      }
    }
    sortPool(memory);
    dayRule();
    const after = current().reports.map((r) => r.id);
    if (op.t !== 'pickToPool' && op.t !== 'pickOntoReport') {
      // Nothing but a picked photo opens a Report — a removed one least of all.
      const minted = op.t === 'removeReport' && before.length === 1 ? 1 : 0;
      expect(after.filter((id) => !before.includes(id)).length).toBe(minted);
    }
    expectHeld();
  }
}

/** Sequences kept as named cases that run on every build, whatever the seeds do. */
const CASES: Record<string, Op[]> = {
  // The founder's report: a tab the photo sort opened on its own, removed — then the sheet closed and
  // reopened and the page reloaded. It never comes back.
  'a tab the sort opened, removed, stays removed across a reopen and a reload': [
    { t: 'pickToPool', lake: 0, day: 0 },
    { t: 'reload' },
    { t: 'removeReport', pick: 1 },
    { t: 'closeReopen' },
    { t: 'reload' },
    { t: 'settle' },
  ],
  // What the property found with the fix taken out: the sort's tab, the sheet reopened, removed.
  'a tab the sort opened, the sheet reopened, then removed: it does not come back': [
    { t: 'pickToPool', lake: 0, day: 0 },
    { t: 'closeReopen' },
    { t: 'removeReport', pick: 1 },
  ],
  'a lake whose photo was put on it as it was added, removed: it does not come back': [
    { t: 'pickOntoReport', pick: 0, lake: 0, day: 0 },
    { t: 'pickToPool', lake: 1, day: 1 },
    { t: 'pickOntoReport', pick: 1, lake: 1, day: 1 },
    { t: 'removeReport', pick: 1 },
    { t: 'settle' },
  ],
  'a new photo picked for the removed lake opens a tab for it alone': [
    { t: 'pickOntoReport', pick: 0, lake: 0, day: 0 },
    { t: 'pickToPool', lake: 1, day: 0 },
    { t: 'removeReport', pick: 1 },
    { t: 'pickToPool', lake: 1, day: 0 },
    { t: 'reload' },
  ],
  'the only lake removed starts over, its photos kept': [
    { t: 'pickOntoReport', pick: 0, lake: 0, day: 0 },
    { t: 'removeReport', pick: 0 },
    { t: 'reload' },
    { t: 'settle' },
  ],
  'a removed lake’s photo removed from the pool takes its file': [
    { t: 'pickToPool', lake: 1, day: 0 },
    { t: 'removeReport', pick: 0 },
    { t: 'removePhoto', pick: 0 },
    { t: 'settle' },
    { t: 'reload' },
  ],
};

beforeAll(() => {
  // Only the clock: the fake's zero-delay timers still run.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await whenSheetPhotosSettled();
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('removing what the author added', () => {
  for (const [name, ops] of Object.entries(CASES)) {
    it(name, () => scenario(ops), 120_000);
  }

  it('the case the founder found, step by step: the sort opens the tab, and never again', async () => {
    await scenario([{ t: 'pickOntoReport', pick: 0, lake: 0, day: 0 }]);
    await pickPhoto({ pool: true }, { coord: LAKES[1]?.coord, takenAtMs: BASE_TIME - 3_600_000 });
    const memory = openSortMemory({ ...current(), photos: [] });
    sortPool(memory);
    const opened = current().reports.find((r) => r.bodyName === 'Crystal Lake');
    expect(opened).toBeDefined();
    updateSheet((p) => removeLake(p, opened?.id ?? '', Date.now(), mint));
    expect(photosToSort(memory, current())).toEqual([]);
    expect(current().reports.some((r) => r.bodyName === 'Crystal Lake')).toBe(false);
  });

  property(
    'a removed Report stays removed, and every removal reaches the stored draft and the Post',
    () => fc.asyncProperty(fc.array(opArb, { maxLength: 20 }), (ops) => scenario(ops)),
    { numRuns: 60 },
  );
});
