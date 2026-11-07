/**
 * The sheet persistence invariants (B03 §5), held under arbitrary interleavings: a draft never
 * restores for a different owner, an expired draft never restores and takes its blobs with it, no
 * blob survives its draft, nothing that is gone comes back, and no storage failure costs the words.
 *
 * Each run drives the real store and the real reconcile against a fresh fake IndexedDB.
 */

import type { DraftPhoto, PostDraft, PostSheet } from '@skating/core';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeIdbFaults } from './sheetPhotoDb.fake';
import { releaseSheetPhoto, sheetPhotoPreview, whenSheetPhotosSettled } from './sheetPhotos';
import {
  bindSheetOwner,
  clearStoredSheet,
  forgetSheet,
  getSheetResend,
  type RestoredSheet,
  resendSheet,
  resetSheetStoreForTests,
  restoreStoredSheet,
  type SheetSendOutcome,
  setSheet,
  setSheetAttempt,
  updateSheet,
} from './sheetStore';
import {
  DAY_MS,
  installFakeStore,
  openSheet,
  pickPhoto,
  reloadPage,
  stubObjectUrls,
} from './sheetStore.fixtures';

vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'));

const KEY = 'skating.reportSheet.v2';
const MAX_AGE_MS = 7 * DAY_MS;
const BASE_TIME = Date.UTC(2026, 0, 10, 20);
const RUNS = { numRuns: 60 };
/** Each interleaving awaits real (zero-delay) timers; a run is a few hundred milliseconds of them. */
const SLOW_TEST_MS = 120_000;

type Fake = ReturnType<typeof installFakeStore>;
let fake: Fake;

interface Stored {
  owner: string;
  sheet: PostSheet;
  photos?: { reports?: Record<string, DraftPhoto[]>; pool?: DraftPhoto[] };
}

function storedRecord(): Stored | null {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as Stored);
}

function claimedIds(record: Stored | null): Set<string> {
  const photos = record?.photos;
  return new Set(
    [...Object.values(photos?.reports ?? {}).flat(), ...(photos?.pool ?? [])].map((p) => p.id),
  );
}

/** The heart of it: every stored blob is named by the one record, under that record's owner and draft. */
function expectNoOrphans(): void {
  const record = storedRecord();
  const claimed = claimedIds(record);
  for (const row of fake.rows.values()) {
    expect(claimed.has(row.photoId)).toBe(true);
    expect(row.owner).toBe(record?.owner);
    expect(row.draftId).toBe(record?.sheet.draftId);
  }
}

async function startRun(): Promise<void> {
  await whenSheetPhotosSettled();
  resetSheetStoreForTests();
  window.localStorage.clear();
  stubObjectUrls();
  fake = installFakeStore();
  vi.setSystemTime(BASE_TIME);
}

const account = fc.constantFrom('user_a', 'user_b', 'user_c');
const words = fc.string({ maxLength: 12 });

beforeAll(() => {
  // Only the clock: the fake's zero-delay timers and the store's deadlines still run.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(startRun);

afterEach(async () => {
  await whenSheetPhotosSettled();
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('owner-binding', () => {
  it(
    'a draft never restores for a different owner, nor gives up its photos, however often accounts change',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          account,
          fc.array(account, { minLength: 1, maxLength: 6 }),
          fc.integer({ min: 0, max: 3 }),
          words,
          async (writer, visitors, photoCount, title) => {
            await startRun();
            bindSheetOwner(writer);
            setSheet({ ...openSheet(), title });
            const photos: DraftPhoto[] = [];
            for (let i = 0; i < photoCount; i++) photos.push(await pickPhoto({ pool: true }));
            await whenSheetPhotosSettled();

            for (const visitor of visitors) {
              reloadPage(visitor);
              const restored = await restoreStoredSheet(Date.now());
              await whenSheetPhotosSettled();
              if (visitor === writer) {
                expect(restored?.sheet.title).toBe(title);
                expect(restored?.photosLost).toBe(0);
              } else {
                expect(restored).toBeNull();
                for (const p of photos) expect(sheetPhotoPreview(p.id)).toBeNull();
              }
              // A visit is not a claim: the writer's blobs wait for the writer.
              expect(fake.rows.size).toBe(photoCount);
              for (const row of fake.rows.values()) expect(row.owner).toBe(writer);
            }
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'a change of account during the read answers nothing and holds nothing',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          account,
          account,
          fc.integer({ min: 1, max: 3 }),
          async (writer, next, photoCount) => {
            fc.pre(writer !== next);
            await startRun();
            bindSheetOwner(writer);
            setSheet(openSheet());
            const photos: DraftPhoto[] = [];
            for (let i = 0; i < photoCount; i++) photos.push(await pickPhoto({ pool: true }));
            await whenSheetPhotosSettled();
            reloadPage(writer);

            const pending = restoreStoredSheet(Date.now());
            bindSheetOwner(next);
            await expect(pending).resolves.toBeNull();
            for (const p of photos) expect(sheetPhotoPreview(p.id)).toBeNull();
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );
});

describe('age', () => {
  /** Stored at the base time; `age` later, it is restored or it is gone, and nothing in between. */
  const scenario = async (age: number, photoCount: number) => {
    await startRun();
    bindSheetOwner('user_a');
    setSheet({ ...openSheet(), title: 'Written' });
    for (let i = 0; i < photoCount; i++) await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    vi.setSystemTime(BASE_TIME + age);
    reloadPage('user_a');
    return restoreStoredSheet(Date.now());
  };

  it(
    'an expired draft never restores, and its blobs go with it',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: MAX_AGE_MS + 1, max: 400 * DAY_MS }),
          fc.integer({ min: 0, max: 3 }),
          async (age, photoCount) => {
            await expect(scenario(age, photoCount)).resolves.toBeNull();
            await whenSheetPhotosSettled();
            expect(fake.rows.size).toBe(0);
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'a draft inside the window restores whole, up to and including its last millisecond',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.integer({ min: 0, max: MAX_AGE_MS }), fc.constant(MAX_AGE_MS)),
          fc.integer({ min: 0, max: 3 }),
          async (age, photoCount) => {
            const restored = await scenario(age, photoCount);
            expect(restored?.sheet.title).toBe('Written');
            expect(restored?.photosLost).toBe(0);
            expect(restored?.sheet.photos?.length ?? 0).toBe(photoCount);
            await whenSheetPhotosSettled();
            expect(fake.rows.size).toBe(photoCount);
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'a page load collects an expired draft’s blobs even if no one asks to restore it',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: MAX_AGE_MS + 1, max: 400 * DAY_MS }),
          fc.option(account, { nil: null }),
          async (age, visitor) => {
            await startRun();
            bindSheetOwner('user_a');
            setSheet(openSheet());
            await pickPhoto({ pool: true });
            await whenSheetPhotosSettled();
            vi.setSystemTime(BASE_TIME + age);
            reloadPage(visitor);
            await whenSheetPhotosSettled();
            expect(fake.rows.size).toBe(0);
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );
});

/** One move in the life of the browser. */
type Op =
  | { t: 'open' }
  | { t: 'pickPool' }
  | { t: 'pickReport' }
  | { t: 'removePhoto'; pick: number }
  | { t: 'type'; text: string }
  | { t: 'post' }
  | { t: 'abandon' }
  | { t: 'clear' }
  | { t: 'forget' }
  | { t: 'bind'; who: string | null }
  | { t: 'reload'; who: string | null }
  | { t: 'restore' }
  | { t: 'wait'; ms: number }
  | { t: 'settle' };

type FaultOp = { t: 'break'; fault: FakeIdbFaults } | { t: 'heal' };

const owner = fc.option(account, { nil: null });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Op>({ t: 'open' }) },
  { weight: 4, arbitrary: fc.constant<Op>({ t: 'pickPool' }) },
  { weight: 4, arbitrary: fc.constant<Op>({ t: 'pickReport' }) },
  {
    weight: 2,
    arbitrary: fc.nat(8).map<Op>((pick) => ({ t: 'removePhoto', pick })),
  },
  { weight: 2, arbitrary: words.map<Op>((text) => ({ t: 'type', text })) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: 'post' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: 'abandon' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: 'clear' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: 'forget' }) },
  { weight: 2, arbitrary: owner.map<Op>((who) => ({ t: 'bind', who })) },
  { weight: 3, arbitrary: owner.map<Op>((who) => ({ t: 'reload', who })) },
  { weight: 3, arbitrary: fc.constant<Op>({ t: 'restore' }) },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0, max: 5 * DAY_MS }).map<Op>((ms) => ({ t: 'wait', ms })),
  },
  { weight: 3, arbitrary: fc.constant<Op>({ t: 'settle' }) },
);

const faultArb: fc.Arbitrary<FaultOp> = fc.oneof(
  fc
    .constantFrom<FakeIdbFaults>(
      { open: 'error' },
      { open: 'throw' },
      { open: 'blocked' },
      { transaction: 'abort' },
      { transaction: 'throw' },
      { transaction: 'error' },
      { put: 'quota' },
      { put: 'clone' },
    )
    .map<FaultOp>((fault) => ({ t: 'break', fault })),
  fc.constant<FaultOp>({ t: 'heal' }),
);

/**
 * Run a sequence, checking after every move what must hold at every moment: the record only ever
 * names the account that opened its draft; a draft that left the record never returns to it; a
 * restore never hands over someone else's draft, an expired one, or one that is gone; and whatever
 * the store is doing, a live record's words come back.
 */
async function runInterleaving(ops: readonly (Op | FaultOp)[], faultsPossible: boolean) {
  await startRun();
  let who: string | null = null;
  let photos: DraftPhoto[] = [];
  let reportId: string | null = null;
  const ownerOf = new Map<string, string>();
  const retired = new Set<string>();
  let onRecord: string | null = null;
  /**
   * The draft on screen. Clearing its stored copy does not retire it: the author is still writing
   * it, and the next change rightly stores it again. A draft is gone once it is off both.
   */
  let onScreen: string | null = null;

  const trackRecord = () => {
    const record = storedRecord();
    const draftId = record?.sheet.draftId ?? null;
    if (onRecord !== null && draftId !== onRecord && onRecord !== onScreen) retired.add(onRecord);
    onRecord = draftId;
    if (record !== null && draftId !== null) {
      expect(retired.has(draftId)).toBe(false);
      expect(record.owner).toBe(ownerOf.get(draftId));
    }
  };

  for (const op of ops) {
    switch (op.t) {
      case 'break':
        Object.assign(fake.faults, op.fault);
        break;
      case 'heal':
        for (const k of Object.keys(fake.faults)) delete fake.faults[k as keyof FakeIdbFaults];
        break;
      case 'open': {
        const sheet = openSheet();
        if (who !== null) ownerOf.set(sheet.draftId, who);
        setSheet(sheet);
        onScreen = sheet.draftId;
        photos = [];
        reportId = sheet.reports[0]?.id ?? null;
        break;
      }
      case 'pickPool':
        photos.push(await pickPhoto({ pool: true }));
        break;
      case 'pickReport':
        if (reportId !== null) photos.push(await pickPhoto({ reportId }));
        break;
      case 'removePhoto': {
        const photo = photos[op.pick % Math.max(photos.length, 1)];
        if (photo === undefined) break;
        releaseSheetPhoto(photo.id);
        updateSheet((p) => ({
          ...p,
          photos: p.photos?.filter((x) => x.id !== photo.id),
          reports: p.reports.map((r) => ({
            ...r,
            photos: r.photos.filter((x) => x.id !== photo.id),
          })),
        }));
        photos = photos.filter((p) => p.id !== photo.id);
        break;
      }
      case 'type':
        updateSheet((p) => ({ ...p, title: op.text, dirty: true }));
        break;
      case 'post':
        // The console's exit, in the order it calls these (`done` and `onCancel`).
        for (const p of photos) releaseSheetPhoto(p.id);
        setSheet(null);
        clearStoredSheet();
        onScreen = null;
        photos = [];
        break;
      case 'abandon':
        // Closing alone: the close must be enough, whatever else a caller remembers to clear.
        for (const p of photos) releaseSheetPhoto(p.id);
        setSheet(null);
        onScreen = null;
        photos = [];
        break;
      case 'clear':
        clearStoredSheet();
        break;
      case 'forget':
        forgetSheet();
        onScreen = null;
        photos = [];
        break;
      case 'bind':
        if (op.who !== who) {
          photos = [];
          onScreen = null;
        }
        who = op.who;
        bindSheetOwner(who);
        break;
      case 'reload':
        who = op.who;
        photos = [];
        onScreen = null;
        reloadPage(who);
        break;
      case 'wait':
        vi.setSystemTime(Date.now() + op.ms);
        break;
      case 'settle':
        await whenSheetPhotosSettled();
        if (!faultsPossible) expectNoOrphans();
        break;
      case 'restore': {
        const before = storedRecord();
        const now = Date.now();
        const restored: RestoredSheet | null = await restoreStoredSheet(now);
        if (restored !== null) {
          expect(restored.sheet.draftId).toBe(before?.sheet.draftId);
          expect(who).not.toBeNull();
          expect(ownerOf.get(restored.sheet.draftId)).toBe(who);
          expect(retired.has(restored.sheet.draftId)).toBe(false);
          expect(now - restored.sheet.openedAtMs).toBeLessThanOrEqual(MAX_AGE_MS);
          // The words were never at the store's mercy, whatever state it is in.
          expect(restored.sheet.title).toBe(before?.sheet.title);
          setSheet(restored.sheet, restored.attempt, restored.resendArmed);
          onScreen = restored.sheet.draftId;
          photos = [
            ...restored.sheet.reports.flatMap((r) => r.photos),
            ...(restored.sheet.photos ?? []),
          ];
          reportId = restored.sheet.reports[0]?.id ?? null;
        } else if (before !== null && before.owner === who) {
          // Nothing came back from a record this account owns: it can only have been too old.
          expect(now - before.sheet.openedAtMs).toBeGreaterThan(MAX_AGE_MS);
        }
        break;
      }
    }
    trackRecord();
  }

  // However it ended, one more page load (with storage working again) leaves nothing unclaimed,
  // and nothing the record's age has put past use.
  for (const k of Object.keys(fake.faults)) delete fake.faults[k as keyof FakeIdbFaults];
  await whenSheetPhotosSettled();
  reloadPage(who);
  await whenSheetPhotosSettled();
  const record = storedRecord();
  if (record !== null && Date.now() - record.sheet.openedAtMs > MAX_AGE_MS) {
    expect(fake.rows.size).toBe(0);
  } else {
    expectNoOrphans();
  }
}

/** Every way a draft can stop being the stored one, with no reload to tidy up after it. */
const EXITS: Record<string, () => void> = {
  'closed alone': () => setSheet(null),
  'closed and cleared': () => {
    setSheet(null);
    clearStoredSheet();
  },
  'signed out of': () => forgetSheet(),
  'overwritten by a new draft': () => setSheet(openSheet()),
  'overwritten by the next account': () => {
    bindSheetOwner('user_b');
    setSheet(openSheet());
  },
};

describe('garbage collection', () => {
  it(
    'no blob survives its draft, by any exit, on any number of photos, without waiting for a reload',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...Object.keys(EXITS)),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
          fc.boolean(),
          async (exit, placements, settleFirst) => {
            await startRun();
            bindSheetOwner('user_a');
            const sheet = openSheet();
            setSheet(sheet);
            const reportId = sheet.reports[0]?.id as string;
            for (const inPool of placements) {
              await pickPhoto(inPool ? { pool: true } : { reportId });
            }
            // A draft can leave while its blobs are still on their way in.
            if (settleFirst) await whenSheetPhotosSettled();
            EXITS[exit]?.();
            await whenSheetPhotosSettled();
            expect(fake.rows.size).toBe(0);
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'interleaved create, restore, post and abandon never orphan a blob or resurrect a draft',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { maxLength: 30 }), (ops) => runInterleaving(ops, false)),
        { numRuns: 100 },
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'the same, with storage failing and recovering at any point along the way',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.oneof({ weight: 5, arbitrary: opArb }, { weight: 1, arbitrary: faultArb }), {
            maxLength: 30,
          }),
          (ops) => runInterleaving(ops, true),
        ),
        { numRuns: 100 },
      );
    },
    SLOW_TEST_MS,
  );
});

describe('a storage failure never costs the words', () => {
  it(
    'every read fault restores every word and counts every photo as lost',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<FakeIdbFaults>(
            { open: 'error' },
            { open: 'throw' },
            { open: 'blocked' },
            { open: 'hang' },
            { transaction: 'abort' },
            { transaction: 'throw' },
            { transaction: 'error' },
            { transaction: 'hang' },
          ),
          words,
          words,
          fc.integer({ min: 1, max: 3 }),
          async (fault, title, body, photoCount) => {
            await startRun();
            bindSheetOwner('user_a');
            setSheet({ ...openSheet(), title, body });
            for (let i = 0; i < photoCount; i++) await pickPhoto({ pool: true });
            await whenSheetPhotosSettled();
            Object.assign(fake.faults, fault);
            reloadPage('user_a');
            const restored = await restoreStoredSheet(Date.now());
            expect(restored?.sheet.title).toBe(title);
            expect(restored?.sheet.body).toBe(body);
            expect(restored?.sheet.photos).toBeUndefined();
            expect(restored?.photosLost).toBe(photoCount);
          },
        ),
        { numRuns: 40 },
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'with storage working, whatever was on the sheet comes back exactly where it sat',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.boolean(), { maxLength: 5 }),
          fc.array(fc.nat(4), { maxLength: 3 }),
          async (placements, removals) => {
            await startRun();
            bindSheetOwner('user_a');
            const sheet = openSheet();
            setSheet(sheet);
            const reportId = sheet.reports[0]?.id as string;
            let picked: { photo: DraftPhoto; inPool: boolean }[] = [];
            for (const inPool of placements) {
              const photo = await pickPhoto(inPool ? { pool: true } : { reportId });
              picked.push({ photo, inPool });
            }
            for (const pick of removals) {
              const gone = picked[pick % Math.max(picked.length, 1)];
              if (gone === undefined) continue;
              releaseSheetPhoto(gone.photo.id);
              updateSheet((p) => ({
                ...p,
                photos: p.photos?.filter((x) => x.id !== gone.photo.id),
                reports: p.reports.map((r) => ({
                  ...r,
                  photos: r.photos.filter((x) => x.id !== gone.photo.id),
                })),
              }));
              picked = picked.filter((x) => x !== gone);
            }
            await whenSheetPhotosSettled();
            reloadPage('user_a');
            const restored = await restoreStoredSheet(Date.now());
            expect(restored?.photosLost).toBe(0);
            expect(restored?.sheet.photos ?? []).toEqual(
              picked.filter((x) => x.inPool).map((x) => x.photo),
            );
            expect(restored?.sheet.reports[0]?.photos).toEqual(
              picked.filter((x) => !x.inPool).map((x) => x.photo),
            );
            await whenSheetPhotosSettled();
            expect(fake.rows.size).toBe(picked.length);
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );
});

type ResendOp =
  | 'edit'
  | 'pickPhoto'
  | 'blobsGone'
  | 'failOffline'
  | 'parked'
  | 'reconnect'
  | 'reload'
  | 'visitor';

/** The attempt `flushPost` leaves after a failure, in the state each move needs. */
function attemptOf(post: PostSheet, status: PostDraft['status']): PostDraft {
  return {
    kind: 'post',
    id: post.draftId,
    idempotencyKey: post.idempotencyKey,
    status,
    reports: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('resending', () => {
  it(
    'a restore stays armed exactly when nothing was lost, or the create was already sent',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 3 }),
          fc.integer({ min: 0, max: 3 }),
          fc.constantFrom<PostDraft['status']>('pending', 'creating'),
          async (photoCount, toLose, status) => {
            await startRun();
            bindSheetOwner('user_a');
            const sheet = openSheet();
            setSheet(sheet);
            const picked: DraftPhoto[] = [];
            for (let i = 0; i < photoCount; i++) picked.push(await pickPhoto({ pool: true }));
            setSheetAttempt(attemptOf(sheet, status));
            await whenSheetPhotosSettled();
            reloadPage('user_a');
            await whenSheetPhotosSettled();
            const lost = Math.min(toLose, photoCount);
            for (const p of picked.slice(0, lost)) fake.rows.delete(p.id);

            const restored = await restoreStoredSheet(Date.now());
            expect(restored?.photosLost).toBe(lost);
            expect(restored?.resendArmed).toBe(lost === 0 || status === 'creating');
            setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
            expect(getSheetResend()).toBe(restored?.resendArmed ? 'waiting' : 'none');
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );

  it(
    'only ever sends what the author pressed Post on: an edit since, and it waits for them',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.constantFrom<ResendOp>(
              'edit',
              'pickPhoto',
              'blobsGone',
              'failOffline',
              'parked',
              'reconnect',
              'reload',
              'visitor',
            ),
            { maxLength: 20 },
          ),
          async (ops) => {
            await startRun();
            bindSheetOwner('user_a');
            const opened = openSheet();
            setSheet(opened);
            let edits = 0;
            /** What *Post* was last pressed on, while a retry could still work. */
            let pressed: string | null = null;
            let sheetOpen = true;
            let photosOnSheet = 0;
            /** A photo on the sheet whose blob is gone: the next restore comes back without it. */
            let blobLost = false;

            const reopen = async () => {
              await whenSheetPhotosSettled();
              reloadPage('user_a');
              const restored = await restoreStoredSheet(Date.now());
              setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
              sheetOpen = restored !== null;
              // What goes out must be what was pressed on, and this no longer is.
              if (blobLost) pressed = null;
              blobLost = false;
              photosOnSheet = restored?.sheet.photos?.length ?? 0;
              await whenSheetPhotosSettled();
            };

            for (const op of ops) {
              switch (op) {
                case 'edit': {
                  const title = `edit-${++edits}`;
                  updateSheet((p) => ({ ...p, title, dirty: true }));
                  if (sheetOpen) pressed = null;
                  break;
                }
                case 'pickPhoto':
                  if (!sheetOpen) break;
                  await pickPhoto({ pool: true });
                  await whenSheetPhotosSettled();
                  photosOnSheet++;
                  pressed = null;
                  break;
                case 'blobsGone':
                  await whenSheetPhotosSettled();
                  fake.rows.clear();
                  blobLost = photosOnSheet > 0;
                  break;
                case 'failOffline':
                case 'parked': {
                  const record = storedRecord();
                  if (!sheetOpen || record === null) break;
                  setSheetAttempt(
                    attemptOf(record.sheet, op === 'failOffline' ? 'pending' : 'error'),
                  );
                  pressed = op === 'failOffline' ? record.sheet.title : null;
                  break;
                }
                case 'reconnect': {
                  const send = vi.fn(
                    async (post: PostSheet): Promise<SheetSendOutcome> => ({
                      kind: 'refused',
                      message: 'No connection.',
                      draft: attemptOf(post, 'pending'),
                    }),
                  );
                  const expectedState = pressed === null ? 'none' : 'waiting';
                  expect(getSheetResend()).toBe(expectedState);
                  await resendSheet(send);
                  if (pressed === null) {
                    expect(send).not.toHaveBeenCalled();
                  } else {
                    expect(send).toHaveBeenCalledTimes(1);
                    expect(send.mock.calls[0]?.[0].title).toBe(pressed);
                  }
                  break;
                }
                case 'reload':
                  await reopen();
                  break;
                case 'visitor': {
                  // Another account reloads on this browser, then the author comes back.
                  reloadPage('user_b');
                  const nothing = vi.fn(
                    async (): Promise<SheetSendOutcome> => ({
                      kind: 'posted',
                      postId: 'x',
                      reportId: 'y',
                    }),
                  );
                  await restoreStoredSheet(Date.now());
                  await resendSheet(nothing);
                  expect(nothing).not.toHaveBeenCalled();
                  await reopen();
                  break;
                }
              }
            }
          },
        ),
        RUNS,
      );
    },
    SLOW_TEST_MS,
  );
});
