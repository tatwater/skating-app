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
  getSheet,
  getSheetAttempt,
  getSheetResend,
  type RestoredSheet,
  resendSheet,
  resetSheetStoreForTests,
  restoreStoredSheet,
  type SheetSendOutcome,
  sendSheet,
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

/**
 * Every property here runs a fixed set of seeds on every build, so a red build is reproducible and a
 * regression one of them reaches is caught on the branch that made it — and one random seed, so the
 * search keeps widening. A failure prints its seed and path. `SHEET_PROPERTY_SEED` replays one seed
 * and `SHEET_PROPERTY_RUNS` widens every property's run; both are local knobs, unset on CI.
 *
 * The first pinned seed is the CI run that found a lost blob the tab had rewritten
 * (`resendScenario`'s first case); the arbitraries have changed since, so it no longer reaches that
 * sequence — the named case does.
 */
const PINNED_SEEDS = [1236490619, 20261114, 4242, 7];
// An unset, empty or unreadable knob is the default, never zero runs that check nothing.
const RUNS_KNOB = Math.max(0, Math.trunc(Number(process.env.SHEET_PROPERTY_RUNS)) || 0);
const SEED_KNOB = process.env.SHEET_PROPERTY_SEED?.trim() ?? '';
const REPLAYED = SEED_KNOB === '' ? Number.NaN : Number(SEED_KNOB);
const REPLAYING = Number.isInteger(REPLAYED);
const SEEDS: readonly (number | undefined)[] = REPLAYING
  ? [REPLAYED]
  : [...PINNED_SEEDS, undefined];

/**
 * One `it` per seed: `build` makes the property, `numRuns` is the random seed's share. No `examples`:
 * fast-check counts them against `numRuns`, so a named case passed in would take a random case's
 * place on every seed — the named cases run as their own `it`s instead.
 */
function property<Ts>(
  name: string,
  build: () => fc.IAsyncProperty<Ts>,
  { numRuns }: { numRuns: number },
): void {
  const runs = RUNS_KNOB > 0 ? RUNS_KNOB : numRuns;
  for (const seed of SEEDS) {
    it(
      `${name} (seed ${seed ?? 'random'})`,
      async () => {
        await fc.assert(build(), {
          // A replayed seed runs as many cases as the random one that printed it, or a counterexample
          // it found past the pinned seeds' half would never be reached again.
          numRuns: seed === undefined || REPLAYING ? runs : Math.ceil(runs / 2),
          ...(seed !== undefined ? { seed } : {}),
        });
      },
      SLOW_TEST_MS,
    );
  }
}

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
  property(
    'a draft never restores for a different owner, nor gives up its photos, however often accounts change',
    () =>
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

  property(
    'a change of account during the read answers nothing and holds nothing',
    () =>
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

  property(
    'an expired draft never restores, and its blobs go with it',
    () =>
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

  property(
    'a draft inside the window restores whole, up to and including its last millisecond',
    () =>
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

  property(
    'a page load collects an expired draft’s blobs even if no one asks to restore it',
    () =>
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
  property(
    'no blob survives its draft, by any exit, on any number of photos, without waiting for a reload',
    () =>
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

  property(
    'interleaved create, restore, post and abandon never orphan a blob or resurrect a draft',
    () =>
      fc.asyncProperty(fc.array(opArb, { maxLength: 30 }), (ops) => runInterleaving(ops, false)),
    { numRuns: 100 },
  );

  property(
    'the same, with storage failing and recovering at any point along the way',
    () =>
      fc.asyncProperty(
        fc.array(fc.oneof({ weight: 5, arbitrary: opArb }, { weight: 1, arbitrary: faultArb }), {
          maxLength: 30,
        }),
        (ops) => runInterleaving(ops, true),
      ),
    { numRuns: 100 },
  );
});

describe('a storage failure never costs the words', () => {
  property(
    'every read fault restores every word and counts every photo as lost',
    () =>
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

  property(
    'with storage working, whatever was on the sheet comes back exactly where it sat',
    () =>
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
});

/**
 * One move in the life of the browser, as the resend rules see it. Who is at the browser matters:
 * `visitor` is another account reloading and the author coming back, `visitorStays` the same without
 * the return, `switchAccount` another account signing in on this tab, `lapse` the author's session
 * ending without a sign-out, `authorBack` the author signing in again on this tab, `signOut` the
 * explicit sign-out (by whoever is signed in). `otherTab…` is another tab of the author's on the same
 * browser — same record, same blob store, its own memory. `reconnectMidSwitch` is the connection
 * coming back with another account signing in while the resend is out.
 */
type ResendOp =
  | 'edit'
  | 'pickPhoto'
  | 'blobsGone'
  | 'failOffline'
  | 'parked'
  | 'reconnect'
  | 'reconnectMidSwitch'
  | 'reload'
  | 'visitor'
  | 'visitorStays'
  | 'switchAccount'
  | 'lapse'
  | 'authorBack'
  | 'signOut'
  | 'otherTabEdits'
  | 'otherTabDiscards';

const RESEND_OPS: readonly [ResendOp, number][] = [
  ['edit', 3],
  ['pickPhoto', 3],
  ['blobsGone', 2],
  ['failOffline', 4],
  ['parked', 1],
  ['reconnect', 4],
  ['reconnectMidSwitch', 1],
  ['reload', 2],
  ['visitor', 2],
  ['visitorStays', 1],
  ['switchAccount', 1],
  ['lapse', 1],
  ['authorBack', 2],
  ['signOut', 1],
  ['otherTabEdits', 1],
  ['otherTabDiscards', 1],
];

const resendOpArb: fc.Arbitrary<ResendOp> = fc.oneof(
  ...RESEND_OPS.map(([op, weight]) => ({ weight, arbitrary: fc.constant(op) })),
);

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

const AUTHOR = 'user_a';
const OTHER = 'user_b';

/** The pool photo ids on a sheet, in order — the model only ever picks into the pool. */
const poolIds = (post: PostSheet | null) => (post?.photos ?? []).map((p) => p.id);

/** Another tab wrote the record (or removed it): what the browser tells every other tab. */
function storageEventFromAnotherTab(): void {
  window.dispatchEvent(
    new StorageEvent('storage', { key: KEY, newValue: window.localStorage.getItem(KEY) }),
  );
}

/**
 * The resend rules, checked after every move: a resend goes out only to the author who pressed
 * *Post*, only while they are signed in here, and only with exactly what they pressed it on — the
 * same words and the same photos. Any change the author makes since (here or in another tab), a
 * parked refusal, a restore that came back without a photo, a sign-out, and nothing goes until they
 * press it again. A visitor, signed in or not, never sends it and never has it waiting.
 */
async function resendScenario(ops: readonly ResendOp[]): Promise<void> {
  await startRun();
  bindSheetOwner(AUTHOR);
  setSheet(openSheet());
  let edits = 0;
  /** Who is signed in on this tab. */
  let at = 'author' as 'author' | 'other' | 'nobody';
  /**
   * What *Post* was last pressed on, while a retry could still work — the author's, wherever they
   * are: a visitor does not cancel it, it waits in the record for the author's return.
   */
  let pressed: { title: string; photoIds: string[] } | null = null;
  /** The author's sheet is open on this tab. */
  let sheetOpen = true;
  let photosOnSheet = 0;
  /**
   * A photo on the sheet whose blob is gone from the store: the next restore comes back without it.
   * A change to the set of photos while this tab still holds them all puts it back (the reconcile
   * writes every claimed photo it holds), and then nothing is lost.
   */
  let blobLost = false;

  const leave = (who: 'other' | 'nobody') => {
    at = who;
    sheetOpen = false;
  };

  /** The author is back on this tab — by a reload, or by signing in again — and the host restores. */
  const authorReturns = async (reload: boolean) => {
    await whenSheetPhotosSettled();
    if (reload) reloadPage(AUTHOR);
    else bindSheetOwner(AUTHOR);
    at = 'author';
    const restored = await restoreStoredSheet(Date.now());
    // The model and the store agree on whether a photo was lost.
    if (restored !== null) expect(restored.photosLost > 0).toBe(blobLost);
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    sheetOpen = restored !== null;
    // What goes out must be what was pressed on: a lost photo means it no longer is, and nothing
    // restored means there is nothing to send.
    if (blobLost || !sheetOpen) pressed = null;
    blobLost = false;
    photosOnSheet = restored?.sheet.photos?.length ?? 0;
    await whenSheetPhotosSettled();
  };

  /** A visitor never sends the author's draft, and never has it waiting. */
  const visit = async (reload: boolean) => {
    if (reload) reloadPage(OTHER);
    else bindSheetOwner(OTHER);
    leave('other');
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
    expect(getSheetResend()).toBe('none');
    const nothing = vi.fn(
      async (): Promise<SheetSendOutcome> => ({ kind: 'posted', postId: 'x', reportId: 'y' }),
    );
    await resendSheet(nothing);
    expect(nothing).not.toHaveBeenCalled();
  };

  const refusing = (gate: Promise<void> = Promise.resolve()) =>
    vi.fn(async (post: PostSheet): Promise<SheetSendOutcome> => {
      await gate;
      return { kind: 'refused', message: 'No connection.', draft: attemptOf(post, 'pending') };
    });

  const expectSentWhatWasPressed = (send: ReturnType<typeof refusing>, owed: boolean) => {
    if (!owed || pressed === null) {
      expect(send).not.toHaveBeenCalled();
      return;
    }
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] ?? null;
    expect(sent?.title).toBe(pressed.title);
    expect(poolIds(sent)).toEqual(pressed.photoIds);
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
        blobLost = false;
        break;
      case 'blobsGone':
        await whenSheetPhotosSettled();
        fake.rows.clear();
        blobLost = photosOnSheet > 0;
        break;
      case 'failOffline':
      case 'parked': {
        const sheet = getSheet();
        if (!sheetOpen || sheet === null) break;
        setSheetAttempt(attemptOf(sheet, op === 'failOffline' ? 'pending' : 'error'));
        pressed = op === 'failOffline' ? { title: sheet.title, photoIds: poolIds(sheet) } : null;
        break;
      }
      case 'reconnect': {
        const owed = at === 'author' && pressed !== null;
        expect(getSheetResend()).toBe(owed ? 'waiting' : 'none');
        const send = refusing();
        await resendSheet(send);
        expectSentWhatWasPressed(send, owed);
        break;
      }
      case 'reconnectMidSwitch': {
        // What went out went before the switch, and was the author's to send; nothing is waiting
        // for the account that arrived, and the author's record still owes them the retry.
        const owed = at === 'author' && pressed !== null;
        expect(getSheetResend()).toBe(owed ? 'waiting' : 'none');
        let release = () => {};
        const send = refusing(new Promise<void>((resolve) => (release = resolve)));
        const flight = resendSheet(send);
        bindSheetOwner(OTHER);
        leave('other');
        release();
        await flight;
        expectSentWhatWasPressed(send, owed);
        expect(getSheetResend()).toBe('none');
        break;
      }
      case 'reload':
        await authorReturns(true);
        break;
      case 'authorBack':
        if (at === 'author') break;
        await authorReturns(false);
        break;
      case 'visitor':
        // Another account reloads on this browser, then the author comes back.
        await visit(true);
        await authorReturns(true);
        break;
      case 'visitorStays':
        await visit(true);
        break;
      case 'switchAccount':
        if (at === 'other') break;
        await visit(false);
        break;
      case 'lapse':
        // The session ends without a sign-out: the draft stays stored for the same author.
        bindSheetOwner(null);
        leave('nobody');
        expect(getSheetResend()).toBe('none');
        break;
      case 'signOut':
        if (at === 'nobody') break;
        // `useSignOut`: the sheet forgotten everywhere, then Clerk's sign-out.
        forgetSheet();
        bindSheetOwner(null);
        leave('nobody');
        pressed = null;
        photosOnSheet = 0;
        blobLost = false;
        expect(storedRecord()).toBeNull();
        break;
      case 'otherTabEdits': {
        // The author changes the draft in another tab: its words move on, its record is not armed.
        const raw = window.localStorage.getItem(KEY);
        if (at !== 'author' || raw === null) break;
        const record = JSON.parse(raw) as Stored & { resendArmed?: boolean };
        const { resendArmed: _armed, ...rest } = record;
        const title = `other-tab-${++edits}`;
        window.localStorage.setItem(
          KEY,
          JSON.stringify({ ...rest, sheet: { ...rest.sheet, title } }),
        );
        storageEventFromAnotherTab();
        pressed = null;
        break;
      }
      case 'otherTabDiscards':
        // The author throws the draft away (or posts it) in another tab: the record and its blobs go.
        if (at !== 'author') break;
        await whenSheetPhotosSettled();
        window.localStorage.removeItem(KEY);
        fake.rows.clear();
        storageEventFromAnotherTab();
        pressed = null;
        blobLost = photosOnSheet > 0;
        break;
    }
  }
}

/**
 * Sequences kept as named cases that run on every build, whatever the seeds do — the counterexample
 * CI found, and the neighbors of it the rules were checked against.
 */
const RESEND_CASES: Record<string, ResendOp[]> = {
  // CI on a server-only PR (seed 1236490619, path 21:3:12:16): the browser dropped the first photo's
  // blob, but picking a second one reconciled the store and this tab rewrote it from what it held.
  // The restore found both photos, so the Post the author pressed went out whole — the model had
  // counted the photo as lost for good.
  'a blob the tab rewrote before the reload is not lost: the Post goes out whole': [
    'pickPhoto',
    'blobsGone',
    'pickPhoto',
    'failOffline',
    'visitor',
    'reconnect',
  ],
  'a blob lost before the failed send and never rewritten: the restore disarms it': [
    'pickPhoto',
    'blobsGone',
    'failOffline',
    'reload',
    'reconnect',
  ],
  'a blob lost after the failed send: the restore disarms it': [
    'pickPhoto',
    'failOffline',
    'blobsGone',
    'reload',
    'reconnect',
  ],
  'a visitor at the reconnect: nothing waits for them, the author still owed it on return': [
    'pickPhoto',
    'failOffline',
    'visitorStays',
    'reconnect',
    'authorBack',
    'reconnect',
  ],
  'another account signs in on this tab before the reconnect: nothing sends': [
    'failOffline',
    'switchAccount',
    'reconnect',
    'reload',
    'reconnect',
  ],
  'another account signs in while the resend is out: the answer is not theirs': [
    'failOffline',
    'reconnectMidSwitch',
    'reconnect',
    'authorBack',
    'reconnect',
  ],
  'a lapsed session keeps it for the same author; a sign-out ends it': [
    'failOffline',
    'lapse',
    'reconnect',
    'authorBack',
    'reconnect',
    'signOut',
    'authorBack',
    'reconnect',
  ],
  'an edit after the failed send waits for the author': ['failOffline', 'edit', 'reconnect'],
  'an edit in another tab waits for the author': [
    'pickPhoto',
    'failOffline',
    'otherTabEdits',
    'reconnect',
  ],
  'a draft thrown away in another tab never sends from this one': [
    'pickPhoto',
    'failOffline',
    'otherTabDiscards',
    'reconnect',
    'reload',
    'reconnect',
  ],
  'the tab closed and reopened keeps what was owed': [
    'failOffline',
    'reload',
    'reload',
    'reconnect',
  ],
};

describe('resending', () => {
  property(
    'a restore stays armed exactly when nothing was lost, or the create was already sent',
    () =>
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

  for (const [name, ops] of Object.entries(RESEND_CASES)) {
    it(name, () => resendScenario(ops), SLOW_TEST_MS);
  }

  property(
    'only ever sends what the author pressed Post on, to the author: an edit since, and it waits for them',
    () => fc.asyncProperty(fc.array(resendOpArb, { maxLength: 24 }), (ops) => resendScenario(ops)),
    RUNS,
  );
});

describe('another tab', () => {
  /** The author's draft, waiting to resend, on this tab. */
  const waiting = async () => {
    await startRun();
    bindSheetOwner(AUTHOR);
    const sheet = openSheet();
    setSheet(sheet);
    setSheetAttempt(attemptOf(sheet, 'pending'));
    expect(getSheetResend()).toBe('waiting');
    return sheet;
  };

  it('a new draft started in another tab leaves this one waiting', async () => {
    await waiting();
    const other = openSheet();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ owner: AUTHOR, sheet: other, attempt: null }),
    );
    storageEventFromAnotherTab();
    expect(getSheetResend()).toBe('waiting');
  });

  it('another account writing in another tab disarms it', async () => {
    const sheet = await waiting();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ owner: OTHER, sheet, attempt: null, resendArmed: true }),
    );
    storageEventFromAnotherTab();
    expect(getSheetResend()).toBe('none');
  });

  it('the store cleared in another tab disarms it', async () => {
    await waiting();
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(getSheetResend()).toBe('none');
  });

  it('the same draft still armed in another tab leaves it waiting, and other keys are not read', async () => {
    await waiting();
    storageEventFromAnotherTab();
    expect(getSheetResend()).toBe('waiting');
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }));
    expect(getSheetResend()).toBe('waiting');
  });

  it('an event with nothing armed changes nothing', async () => {
    await startRun();
    bindSheetOwner(AUTHOR);
    setSheet(openSheet());
    window.localStorage.removeItem(KEY);
    storageEventFromAnotherTab();
    expect(getSheetResend()).toBe('none');
    expect(getSheet()).not.toBeNull();
  });

  it('what the other tab wrote decides, even when a write of this tab’s own landed after it', async () => {
    const sheet = await waiting();
    // The store still holds this tab's armed copy; the event carries the other tab's edit.
    const edited = { owner: AUTHOR, sheet: { ...sheet, title: 'Changed there' }, attempt: null };
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(edited) }),
    );
    expect(getSheetResend()).toBe('none');
  });

  /** A send held until the test answers it. */
  const held = () => {
    let resolve: (outcome: SheetSendOutcome) => void = () => {};
    const send = vi.fn(
      (_post: PostSheet) => new Promise<SheetSendOutcome>((done) => (resolve = done)),
    );
    return { send, answer: (outcome: SheetSendOutcome) => resolve(outcome) };
  };

  /** The author changes this draft in another tab: new words, its record not armed. */
  const editElsewhere = () => {
    const record = JSON.parse(window.localStorage.getItem(KEY) as string) as Stored & {
      resendArmed?: boolean;
    };
    const { resendArmed: _armed, ...rest } = record;
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...rest, sheet: { ...rest.sheet, title: 'Changed there' } }),
    );
    storageEventFromAnotherTab();
  };

  const stored = () =>
    JSON.parse(window.localStorage.getItem(KEY) as string) as Stored & {
      attempt: PostDraft | null;
      resendArmed?: boolean;
    };

  it('a change there while the resend is out: its refusal neither re-arms it nor writes over the change', async () => {
    const sheet = await waiting();
    const { send, answer } = held();
    const flight = resendSheet(send);
    expect(getSheetResend()).toBe('sending');
    editElsewhere();
    const refused = attemptOf(sheet, 'pending');
    answer({ kind: 'refused', message: 'No connection.', draft: refused });
    await flight;
    expect(getSheetResend()).toBe('none');
    // Kept here for the author's next *Post*, which resumes from it.
    expect(getSheetAttempt()).toEqual(refused);
    expect(stored().sheet.title).toBe('Changed there');
    expect(stored().resendArmed).toBeUndefined();
  });

  it('the same once the create went out: the lock reaches the record, and nothing re-arms', async () => {
    const sheet = await waiting();
    const { send, answer } = held();
    const flight = resendSheet(send);
    editElsewhere();
    answer({ kind: 'refused', message: 'No answer.', draft: attemptOf(sheet, 'creating') });
    await flight;
    expect(getSheetResend()).toBe('none');
    expect(stored().attempt?.status).toBe('creating');
    expect(stored().sheet.title).toBe(sheet.title);
    expect(stored().resendArmed).toBeUndefined();
  });

  it('a Post pressed here and changed there while it is out does not arm on its refusal', async () => {
    await startRun();
    bindSheetOwner(AUTHOR);
    const sheet = openSheet();
    setSheet(sheet);
    const { send, answer } = held();
    const flight = sendSheet(send);
    editElsewhere();
    answer({ kind: 'refused', message: 'No connection.', draft: attemptOf(sheet, 'pending') });
    await flight;
    expect(getSheetResend()).toBe('none');
  });

  it('an event mid-send that changes nothing of this draft leaves the refusal to re-arm it', async () => {
    const sheet = await waiting();
    const { send, answer } = held();
    const flight = resendSheet(send);
    storageEventFromAnotherTab();
    answer({ kind: 'refused', message: 'No connection.', draft: attemptOf(sheet, 'pending') });
    await flight;
    expect(getSheetResend()).toBe('waiting');
    expect(stored().resendArmed).toBe(true);
  });

  it('a checkpoint the send writes after a change there neither re-arms it nor writes over the change', async () => {
    const sheet = await waiting();
    const { send, answer } = held();
    const flight = resendSheet(send);
    editElsewhere();
    // `flushPost` saving a checkpoint on its way, as `webPostDeps.persist` does.
    const checkpoint = attemptOf(sheet, 'pending');
    setSheetAttempt(checkpoint);
    expect(getSheetAttempt()).toEqual(checkpoint);
    expect(stored().sheet.title).toBe('Changed there');
    answer({ kind: 'refused', message: 'No connection.', draft: checkpoint });
    await flight;
    expect(getSheetResend()).toBe('none');
    expect(stored().sheet.title).toBe('Changed there');
    expect(stored().resendArmed).toBeUndefined();
    // Reopened, the tab finds the other tab's words, waiting for the author.
    reloadPage(AUTHOR);
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Changed there');
    expect(restored?.resendArmed).toBe(false);
  });

  /** The author's draft with a photo, waiting to resend, stored; then a reload starts reading it back. */
  const restoringWaiting = async () => {
    await startRun();
    bindSheetOwner(AUTHOR);
    const sheet = openSheet();
    setSheet(sheet);
    await pickPhoto({ pool: true });
    setSheetAttempt(attemptOf(sheet, 'pending'));
    await whenSheetPhotosSettled();
    reloadPage(AUTHOR);
    // Wrapped, so awaiting the setup does not await the read it starts.
    return { pending: restoreStoredSheet(Date.now()) };
  };

  it('a change there while a reload reads the photos back: the words return, the resend does not', async () => {
    const { pending } = await restoringWaiting();
    editElsewhere();
    const restored = await pending;
    expect(restored?.photosLost).toBe(0);
    expect(restored?.resendArmed).toBe(false);
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    expect(getSheetResend()).toBe('none');
  });

  it('a discard there while a reload reads the photos back: nothing is armed', async () => {
    const { pending } = await restoringWaiting();
    window.localStorage.removeItem(KEY);
    storageEventFromAnotherTab();
    await expect(pending).resolves.toMatchObject({ resendArmed: false });
  });

  it('an event during the read that changes nothing of this draft leaves the restore armed', async () => {
    const { pending } = await restoringWaiting();
    storageEventFromAnotherTab();
    await expect(pending).resolves.toMatchObject({ resendArmed: true, photosLost: 0 });
  });
});
