/**
 * **A photo's stored files under any lifecycle, with faults** (B01-5e, `lib/photoFiles`' invariants).
 * Random sequences of uploads, legacy rows sharing files, flags, hides, removals, restores, the
 * uploader's delete, an author's edit dropping photos, deletes by the background deleters, purges,
 * rotation attempts **killed at any step**, the scheduled rotation's action cancelled (a runtime kill
 * before it begins), deletes that fail and later succeed, the clock moving minutes to days, the files
 * sweep — and after every step, against the real storage and tables:
 *
 * - every stored file is named by a photo row's slot, or by exactly one ledger row, or was stored by
 *   an unreconciled attempt inside its own window with a source file's hash (invariants 1, 3);
 * - a live row's files exist (not purged, not marked missing) — nothing named, nothing held, is lost
 *   (invariant 2); no recorded copy is a row's slot;
 * - no public read's answer carries any stored file's id (invariant 6).
 *
 * And at the end, faults cleared and the clock run on: no ledger row, no open attempt, and storage
 * holds exactly the files live rows name (invariants 4, 5). A fresh seed every run (system randomness;
 * the test fakes `Date`); fast-check prints a failing seed and path to pin.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { ACTION_LIFETIME_MS } from './lib/photoFiles';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { keepAndWithdrawHeld } from './lib/photoWithdraw';
import schema from './schema';

/** Deletes that fail (by storage id) until the model lets them go. */
const failing = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock('./lib/storageBlobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/storageBlobs')>();
  return {
    ...actual,
    deleteStoredBlob: async (ctx: Parameters<typeof actual.deleteStoredBlob>[0], id: string) =>
      failing.ids.has(id) ? 'storage refused' : actual.deleteStoredBlob(ctx, id as never),
  };
});

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 11, 2, 12);
const DAY = 86_400_000;
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  failing.ids.clear();
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
  moderatorDecision: false,
};

const KILL_POINTS = ['begin', 'store1', 'record1', 'store2', 'record2', 'swap'] as const;
type Kill = (typeof KILL_POINTS)[number] | 'none';

type Op =
  | { k: 'upload' }
  | { k: 'legacyShare'; i: number }
  | { k: 'flag'; i: number }
  | { k: 'set'; i: number; status: 'hidden' | 'removed' | 'visible' }
  | { k: 'authorDelete'; i: number }
  | { k: 'authorEdit'; i: number }
  | { k: 'deleter'; i: number }
  | { k: 'attempt'; i: number; kill: Kill }
  | { k: 'cancelRotations' }
  | { k: 'failDeletes'; i: number }
  | { k: 'letGo' }
  | { k: 'advance'; minutes: number }
  | { k: 'purge' }
  | { k: 'sweep' };

const idx = fc.nat({ max: 7 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ k: 'upload' as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('legacyShare' as const), i: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('flag' as const), i: idx }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('set' as const),
      i: idx,
      status: fc.constantFrom('hidden' as const, 'removed' as const, 'visible' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('authorDelete' as const), i: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('authorEdit' as const), i: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('deleter' as const), i: idx }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('attempt' as const),
      i: idx,
      kill: fc.constantFrom<Kill>('none', ...KILL_POINTS),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'cancelRotations' as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('failDeletes' as const), i: idx }) },
  { weight: 1, arbitrary: fc.constant({ k: 'letGo' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('advance' as const),
      minutes: fc.constantFrom(1, 2, 15, 61, 180, 1500),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'purge' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'sweep' as const }) },
);

async function person(t: T, subject: string, role: Doc<'profiles'>['role'] = 'member') {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: T0 - DAY,
    }),
  );
}

/** Advance the clock in steps no longer than a minute, running what falls due — as a clock moves. */
async function advance(t: T, minutes: number) {
  const step = Math.max(1, Math.ceil(minutes / 30));
  for (let m = 0; m < minutes; m += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, minutes - m) * 60_000);
    await t.finishInProgressScheduledFunctions();
  }
}

async function run(ops: Op[]) {
  vi.setSystemTime(T0);
  failing.ids.clear();
  const t = harness();
  const uploaderId = await person(t, 'uploader');
  await person(t, 'skater');
  await person(t, 'mod', 'moderator');
  const as = (s: string) => t.withIdentity({ subject: s });
  const reportId = await t.run(async (ctx) => {
    const waterBodyId = await ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    });
    return ctx.db.insert('reports', {
      authorId: uploaderId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
    });
  });
  const photos: Id<'photos'>[] = [];
  let n = 0;
  const pick = (i: number) => (photos.length === 0 ? null : (photos[i % photos.length] ?? null));
  const safely = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch {
      // A refusal is an allowed outcome; the invariants hold after it too.
    }
  };

  for (const op of ops) {
    if (op.k === 'upload') {
      n++;
      const [a, b] = await t.run(async (ctx) => [
        await ctx.storage.store(new Blob([`full-${n}`])),
        await ctx.storage.store(new Blob([`thumb-${n}`])),
      ]);
      const id = await as('uploader').mutation(api.photos.create, {
        storageId: a as Id<'_storage'>,
        thumbStorageId: b as Id<'_storage'>,
        placeOnMap: false,
      });
      photos.push(id);
      await t.run(async (ctx) => {
        const r = (await ctx.db.get(reportId)) as Doc<'reports'>;
        await ctx.db.patch(reportId, { photoIds: [...r.photoIds, id] });
        await ctx.db.patch(id, { reportId });
      });
    } else {
      const p = 'i' in op ? pick(op.i) : null;
      switch (op.k) {
        case 'legacyShare':
          if (p) {
            const row = await t.run((ctx) => ctx.db.get(p));
            if (row && row.purgedAt === undefined) {
              photos.push(
                await t.run((ctx) =>
                  ctx.db.insert('photos', {
                    storageId: row.storageId,
                    thumbStorageId: row.thumbStorageId,
                    uploaderId,
                    placeOnMap: false,
                    createdAt: T0,
                    moderationStatus: 'visible',
                  }),
                ),
              );
            }
          }
          break;
        case 'flag':
          if (p)
            await safely(() =>
              as('skater').mutation(api.contentFlags.flag, {
                targetType: 'photo',
                targetId: p,
                reason: 'inappropriate',
              }),
            );
          break;
        case 'set':
          if (p)
            await safely(() =>
              as('mod').mutation(api.moderation.setModerationStatus, {
                targetType: 'photo',
                targetId: p,
                status: op.status,
                reason: 'x',
              }),
            );
          break;
        case 'authorDelete':
          if (p) await safely(() => as('uploader').mutation(api.photos.remove, { photoId: p }));
          break;
        case 'authorEdit':
          if (p)
            await safely(() =>
              t.run(async (ctx) => {
                const r = (await ctx.db.get(reportId)) as Doc<'reports'>;
                const author = (await ctx.db.get(uploaderId)) as Doc<'profiles'>;
                const sent = r.photoIds.filter((x) => x !== p);
                const next = await keepAndWithdrawHeld(ctx, author, sent, r.photoIds, Date.now());
                await ctx.db.patch(reportId, { photoIds: next });
              }),
            );
          break;
        case 'deleter':
          if (p)
            await safely(() =>
              t.run(async (ctx) => {
                const row = await ctx.db.get(p);
                if (row) await deletePhotoAndBlobs(ctx, row);
              }),
            );
          break;
        case 'attempt':
          if (p) await safely(() => attempt(t, p, op.kill));
          break;
        case 'cancelRotations':
          await t.run(async (ctx) => {
            for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
              if (f.name.includes('rotateBlobs') && f.state.kind === 'pending') {
                await ctx.scheduler.cancel(f._id);
              }
            }
          });
          break;
        case 'failDeletes':
          if (p) {
            const row = await t.run((ctx) => ctx.db.get(p));
            if (row) failing.ids.add(row.storageId);
          }
          break;
        case 'letGo':
          failing.ids.clear();
          break;
        case 'advance':
          await advance(t, op.minutes);
          break;
        case 'purge':
          await safely(() => t.mutation(internal.photoPurge.purgeDuePhotos, { now: Date.now() }));
          break;
        case 'sweep':
          await t.mutation(internal.photoPurge.sweepPhotoFiles, { now: Date.now() });
          break;
      }
    }
    await checkInvariants(t, reportId, photos);
  }

  // Faults cleared and the clock run on: everything owed is done.
  failing.ids.clear();
  for (let d = 0; d < 4; d++) {
    await advance(t, 1500);
    await t.mutation(internal.photoPurge.sweepPhotoFiles, { now: Date.now() });
    await t.finishInProgressScheduledFunctions();
  }
  await checkInvariants(t, reportId, photos);
  const end = await t.run(async (ctx) => {
    const rows = await ctx.db.query('photos').collect();
    const live = new Set(
      rows
        .filter((r) => r.purgedAt === undefined && r.bytesMissingAt === undefined)
        .flatMap((r) => [r.storageId, r.thumbStorageId]),
    );
    const named = new Set(rows.flatMap((r) => [r.storageId, r.thumbStorageId]));
    const stored = (await ctx.db.system.query('_storage').collect()).map((f) => f._id as string);
    return {
      ledger: (await ctx.db.query('photoFiles').collect()).length,
      open: (await ctx.db.query('photoRotations').collect()).filter(
        (a) => a.status !== 'reconciled',
      ).length,
      strays: stored.filter((id) => !named.has(id)),
      missing: [...live].filter((id) => !stored.includes(id)),
    };
  });
  expect(end).toEqual({ ledger: 0, open: 0, strays: [], missing: [] });
}

/** One rotation attempt of photo `p`, as its action runs it — stopped dead at `kill`. */
async function attempt(t: T, p: Id<'photos'>, kill: Kill) {
  const begun = await t.mutation(internal.photos.beginRotation, { photoId: p });
  if (begun.kind !== 'go' || kill === 'begin') return;
  const next: string[] = [];
  const steps: [Kill, Kill, string][] = [
    ['store1', 'record1', begun.storageId],
    ['store2', 'record2', begun.thumbStorageId],
  ];
  for (const [storeKill, recordKill, src] of steps) {
    const copy = await t.run(async (ctx) => {
      const bytes = await ctx.storage.get(src as Id<'_storage'>);
      return bytes ? ((await ctx.storage.store(bytes)) as string) : null;
    });
    if (copy === null) return;
    if (kill === storeKill) return;
    await t.mutation(internal.photos.recordRotationCopy, { attemptId: begun.attemptId, copy });
    if (kill === recordKill) return;
    next.push(copy);
  }
  await t.mutation(internal.photos.swapRotated, {
    attemptId: begun.attemptId,
    old: { storageId: begun.storageId, thumbStorageId: begun.thumbStorageId },
    next: { storageId: next[0] as string, thumbStorageId: next[1] as string },
  });
  if (kill === 'swap') return;
  await t.mutation(internal.photos.endRotation, { attemptId: begun.attemptId });
}

async function checkInvariants(t: T, reportId: Id<'reports'>, photos: Id<'photos'>[]) {
  const state = await t.run(async (ctx) => {
    const rows = await ctx.db.query('photos').collect();
    const ledger = await ctx.db.query('photoFiles').collect();
    const attempts = await ctx.db.query('photoRotations').collect();
    const stored = await ctx.db.system.query('_storage').collect();
    return { rows, ledger, attempts, stored };
  });
  const named = new Set(state.rows.flatMap((r) => [r.storageId, r.thumbStorageId]));
  const byLedger = new Map<string, number>();
  for (const r of state.ledger) byLedger.set(r.storageId, (byLedger.get(r.storageId) ?? 0) + 1);
  const ids = new Set(state.stored.map((f) => f._id as string));
  for (const f of state.stored) {
    const id = f._id as string;
    const ledgered = byLedger.get(id) ?? 0;
    const findable = state.attempts.some(
      (a) =>
        a.status !== 'reconciled' &&
        a.sha256.includes(f.sha256) &&
        f._creationTime > a.scanFrom &&
        f._creationTime <= a.startedAt + ACTION_LIFETIME_MS,
    );
    // Invariants 1, 3: named, or one ledger row, or findable by an unreconciled attempt.
    expect(
      named.has(id) || ledgered === 1 || findable,
      `stored file ${id} is named by nothing`,
    ).toBe(true);
    expect(ledgered, `stored file ${id} has more than one ledger row`).toBeLessThanOrEqual(1);
  }
  for (const r of state.ledger) {
    if (r.state === 'copy')
      expect(named.has(r.storageId), 'a recorded copy is a row slot').toBe(false);
  }
  // Invariant 2: a live row's files exist.
  for (const r of state.rows) {
    if (r.purgedAt !== undefined || r.bytesMissingAt !== undefined) continue;
    expect(ids.has(r.storageId), `live photo ${r._id} lost its image`).toBe(true);
    expect(ids.has(r.thumbStorageId), `live photo ${r._id} lost its thumbnail`).toBe(true);
  }
  // Invariant 6: no public read carries a stored file's id.
  const answers = [
    await t.withIdentity({ subject: 'skater' }).query(api.photos.getUrls, { reportId }),
    await t.withIdentity({ subject: 'skater' }).query(api.reports.get, { reportId }),
    ...(await Promise.all(
      photos
        .slice(0, 3)
        .map((id) =>
          t
            .withIdentity({ subject: 'mod' })
            .query(api.contentRecord.item, { targetType: 'photo', targetId: id }),
        ),
    )),
  ];
  const text = JSON.stringify(answers);
  for (const id of ids) expect(text.includes(id), `a read carried stored file ${id}`).toBe(false);
}

/** A fresh seed every run (system randomness; `Date` is faked). Set it to replay a failure. */
const SEED: number = crypto.getRandomValues(new Int32Array(1))[0] as number;

/** Counterexamples the property found, each pinned. */
const PINNED: Record<string, Op[]> = {
  // A copy recorded after its attempt was reconciled (its action alive past the lifetime the watch
  // allows) landed on an attempt nobody would look at again: recording now releases it.
  'seed -600393707': [
    { k: 'upload' },
    { k: 'set', i: 0, status: 'hidden' },
    { k: 'set', i: 0, status: 'hidden' },
    { k: 'failDeletes', i: 0 },
  ],
  // One of a photo's two deletes failing kept the row as the "only pointer" with its other file
  // already gone — a live row naming a missing file. The row now goes (or becomes a tombstone) and
  // each file is released to the ledger.
  'seed 1433456634': [
    { k: 'upload' },
    { k: 'failDeletes', i: 0 },
    { k: 'authorDelete', i: 0 },
    { k: 'upload' },
    { k: 'upload' },
    { k: 'flag', i: 0 },
  ],
  'a failing delete, then the deleter': [
    { k: 'upload' },
    { k: 'failDeletes', i: 0 },
    { k: 'purge' },
    { k: 'deleter', i: 0 },
    { k: 'flag', i: 0 },
  ],
  'a failing purge': [
    { k: 'upload' },
    { k: 'set', i: 0, status: 'removed' },
    { k: 'failDeletes', i: 0 },
    { k: 'advance', minutes: 1500 },
    { k: 'advance', minutes: 1500 },
    { k: 'purge' },
  ],
};

describe('a photo’s stored files under any lifecycle, with faults', () => {
  test.each(Object.entries(PINNED))(
    'pinned: %s',
    async (_name, ops) => {
      await run(ops);
    },
    60_000,
  );

  test('every invariant after every step, and nothing owed at the end', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 3, maxLength: 14 }), (ops) => run(ops)),
      { numRuns: 12, seed: SEED },
    );
  }, 60_000);
});
