/**
 * **A photo's stored files under any lifecycle, with faults** (B01-5e, `lib/photoFiles`' invariants).
 * Random sequences of uploads, legacy rows sharing files **in every slot combination** (a row's image
 * as another's image or thumbnail, a thumbnail as either, one file in both of a row's slots, chains of
 * three and more), flags, hides, removals, restores, the uploader's delete, an author's edit dropping
 * photos, deletes by the background deleters, purges, rotation attempts **killed at any step**, the
 * scheduled rotation's action cancelled (a runtime kill before it begins), deletes that fail and later
 * succeed, **a row created naming a file already owed a deletion** (between its dooming and its
 * retry), **a skater's fresh upload of the same bytes** inside an attempt's window, uploads claiming
 * any stored id, `removeBlob` on any stored id, the clock moving minutes to days, the files sweep —
 * and after every step, against the real storage and tables:
 *
 * - **every id any row names, in either slot, exists** — unless the row is a purged tombstone (whose
 *   slots are cleared) or marked missing; nothing named, nothing held, is lost (invariant 2);
 * - every stored file is named by a row's slot, or by exactly one ledger row, or was stored — and
 *   tagged — by an unreconciled attempt inside its own window, or is a skater's unattached upload,
 *   which no machinery but `removeBlob` touches (invariants 1, 3); no recorded copy is a row's slot;
 * - a rotation that swaps a file other rows still name records them as the photo's twins;
 * - no public read's answer carries any stored file's id (invariant 6).
 *
 * And at the end, faults cleared and the clock run on: no ledger row, no open attempt, and storage
 * holds exactly the files rows name and the skaters' unattached uploads (invariants 4, 5). A fresh seed every run (system randomness;
 * the test fakes `Date`); fast-check prints a failing seed and path to pin.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { TOMBSTONE_FILE } from './lib/photoAccess';
import { ACTION_LIFETIME_MS, copyContentType, isCopyOf, SAME_BYTES_MAX } from './lib/photoFiles';
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

/**
 * Files lost from under a row (outside the app's own deletes): every id, so the invariants allow a
 * row to name one; and a hook that loses a photo's file mid-rotation — when its next copy is recorded,
 * after the attempt began, before the action reads on — so the action's own missing-file path runs.
 */
const lost = vi.hoisted(() => ({
  ids: new Set<string>(),
  midRotation: null as { photoId: string; storageId: string } | null,
}));
vi.mock('./lib/photoFiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/photoFiles')>();
  return {
    ...actual,
    recordCopy: async (...args: Parameters<typeof actual.recordCopy>) => {
      await actual.recordCopy(...args);
      const [ctx, attempt] = args;
      const m = lost.midRotation;
      if (m && m.photoId === attempt.photoId) {
        lost.midRotation = null;
        lost.ids.add(m.storageId);
        await ctx.storage.delete(m.storageId as Id<'_storage'>);
      }
    },
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

type Slot = 'image' | 'thumb';

type Op =
  | { k: 'upload' }
  /** A legacy row: its image is `i`'s `a` slot; its thumbnail `j`'s `b` slot, a fresh file, or the same. */
  | { k: 'legacyShare'; i: number; a: Slot; j: number; b: Slot | 'fresh' | 'same' }
  /** `n` legacy rows naming `i`'s `slot` file as their `as` slot — nine and more twins of one file. */
  | { k: 'legacyMany'; i: number; slot: Slot; as: Slot; n: number }
  /** `i`'s `slot` file lost from storage — now, or mid-rotation (after its next attempt begins). */
  | { k: 'vanish'; i: number; slot: Slot; when: 'now' | 'midRotation' }
  /** A row created naming a doomed file (in `slot`), between its dooming and its retry. */
  | { k: 'adoptDoomed'; i: number; slot: Slot }
  /** A skater's fresh upload of `i`'s image bytes, not yet attached. */
  | { k: 'sameBytes'; i: number }
  /** An upload claiming the `i`th stored id as its image. */
  | { k: 'claim'; i: number }
  /** `removeBlob` on the `i`th stored id. */
  | { k: 'removeBlob'; i: number }
  | { k: 'flag'; i: number }
  | { k: 'set'; i: number; status: 'hidden' | 'removed' | 'visible' }
  | { k: 'authorDelete'; i: number }
  | { k: 'authorEdit'; i: number }
  | { k: 'deleter'; i: number }
  /** One rotation attempt, killed at `kill`; `down` takes the photo down first, as a takedown does. */
  | { k: 'attempt'; i: number; kill: Kill; down: boolean }
  | { k: 'cancelRotations' }
  | { k: 'failDeletes'; i: number; slot?: Slot | 'both' }
  | { k: 'letGo' }
  | { k: 'advance'; minutes: number }
  | { k: 'purge' }
  | { k: 'sweep' };

const UPLOAD: Op = { k: 'upload' };
const idx = fc.nat({ max: 7 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ k: 'upload' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('legacyShare' as const),
      i: idx,
      a: fc.constantFrom<Slot>('image', 'thumb'),
      j: idx,
      b: fc.constantFrom<Slot | 'fresh' | 'same'>('image', 'thumb', 'fresh', 'same'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('vanish' as const),
      i: idx,
      slot: fc.constantFrom<Slot>('image', 'thumb'),
      when: fc.constantFrom('now' as const, 'midRotation' as const),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('legacyMany' as const),
      i: idx,
      slot: fc.constantFrom<Slot>('image', 'thumb'),
      as: fc.constantFrom<Slot>('image', 'thumb'),
      n: fc.constantFrom(7, 8, 9, 10),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('adoptDoomed' as const),
      i: idx,
      slot: fc.constantFrom<Slot>('image', 'thumb'),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('sameBytes' as const), i: idx }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('claim' as const), i: fc.nat({ max: 63 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('removeBlob' as const), i: fc.nat({ max: 63 }) }),
  },
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
      down: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'cancelRotations' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('failDeletes' as const),
      i: idx,
      slot: fc.constantFrom<Slot | 'both'>('image', 'thumb', 'both'),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'letGo' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('advance' as const),
      // Up to 31 days: a removed photo's purge comes due 30 days on.
      minutes: fc.constantFrom(1, 2, 15, 61, 180, 1500, 44_640),
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
  lost.ids.clear();
  lost.midRotation = null;
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
  /** Skaters' unattached uploads: no machinery may delete one (only `removeBlob`, by its id). */
  const uploads = new Set<string>();
  let n = 0;
  const fresh = (kind: string, type = 'image/jpeg') =>
    t.run(
      async (ctx) => (await ctx.storage.store(new Blob([`${kind}-${++n}`], { type }))) as string,
    );
  const slotOf = (row: Doc<'photos'>, s: Slot) =>
    s === 'image' ? row.storageId : row.thumbStorageId;
  const live = (row: Doc<'photos'> | null): row is Doc<'photos'> =>
    row !== null && row.purgedAt === undefined && row.bytesMissingAt === undefined;
  const storedIds = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_storage').collect()).map((f) => f._id as string).sort(),
    );
  const insertLegacy = (storageId: string, thumbStorageId: string) =>
    t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId,
        thumbStorageId,
        uploaderId,
        placeOnMap: false,
        createdAt: T0,
        moderationStatus: 'visible',
      }),
    );
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
        case 'legacyShare': {
          // Rows from before storage ids were keys: any slot may name any live row's file.
          const q = pick(op.j);
          const row = p ? await t.run((ctx) => ctx.db.get(p)) : null;
          const other = q ? await t.run((ctx) => ctx.db.get(q)) : null;
          if (live(row) && (op.b === 'fresh' || op.b === 'same' || live(other))) {
            const image = slotOf(row, op.a);
            const thumb =
              op.b === 'fresh'
                ? await fresh('thumb')
                : op.b === 'same'
                  ? image
                  : slotOf(other as Doc<'photos'>, op.b);
            photos.push(await insertLegacy(image, thumb));
          }
          break;
        }
        case 'legacyMany': {
          const row = p ? await t.run((ctx) => ctx.db.get(p)) : null;
          if (live(row)) {
            const shared = slotOf(row, op.slot);
            for (let m = 0; m < op.n; m++) {
              const other = await fresh('thumb');
              photos.push(
                await (op.as === 'image'
                  ? insertLegacy(shared, other)
                  : insertLegacy(other, shared)),
              );
            }
          }
          break;
        }
        case 'adoptDoomed': {
          // A row naming a file the ledger owes a deletion — imported, restored, or legacy.
          const doomed = await t.run(async (ctx) =>
            (await ctx.db.query('photoFiles').collect()).filter((r) => r.state === 'doomed'),
          );
          const row = doomed[op.i % Math.max(1, doomed.length)];
          if (row) {
            const other = await fresh('thumb');
            photos.push(
              await (op.slot === 'image'
                ? insertLegacy(row.storageId, other)
                : insertLegacy(other, row.storageId)),
            );
          }
          break;
        }
        case 'sameBytes': {
          const row = p ? await t.run((ctx) => ctx.db.get(p)) : null;
          if (live(row)) {
            const id = await t.run(async (ctx) => {
              const bytes = await ctx.storage.get(row.storageId as Id<'_storage'>);
              return bytes
                ? ((await ctx.storage.store(bytes.slice(0, bytes.size, 'image/jpeg'))) as string)
                : null;
            });
            if (id) uploads.add(id);
          }
          break;
        }
        case 'claim': {
          const ids = await storedIds();
          const id = ids[op.i % Math.max(1, ids.length)];
          if (id) {
            const thumb = await fresh('thumb');
            uploads.add(thumb);
            await safely(async () => {
              const photoId = await as('uploader').mutation(api.photos.create, {
                storageId: id as Id<'_storage'>,
                thumbStorageId: thumb as Id<'_storage'>,
                placeOnMap: false,
              });
              photos.push(photoId);
              uploads.delete(id);
              uploads.delete(thumb);
            });
          }
          break;
        }
        case 'removeBlob': {
          const ids = await storedIds();
          const id = ids[op.i % Math.max(1, ids.length)];
          if (id) {
            await safely(() =>
              as('uploader').mutation(api.photos.removeBlob, { storageId: id as Id<'_storage'> }),
            );
            if (!(await storedIds()).includes(id)) uploads.delete(id);
          }
          break;
        }
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
          if (p) {
            if (op.down)
              await t.run(async (ctx) => {
                const row = await ctx.db.get(p);
                if (row && (row.moderationStatus ?? 'visible') === 'visible')
                  await ctx.db.patch(p, { moderationStatus: 'hidden' });
              });
            // A refusal is allowed; a broken promise is not — `safely` would swallow an assertion.
            let broken: string | undefined;
            await safely(async () => {
              broken = await attempt(t, p, op.kill);
            });
            expect(broken).toBeUndefined();
          }
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
            if (row && op.slot !== 'thumb') failing.ids.add(row.storageId);
            if (row && (op.slot === 'thumb' || op.slot === 'both'))
              failing.ids.add(row.thumbStorageId);
          }
          break;
        case 'vanish': {
          const row = p ? await t.run((ctx) => ctx.db.get(p)) : null;
          if (row && row.purgedAt === undefined) {
            const storageId = slotOf(row, op.slot);
            if (op.when === 'midRotation') lost.midRotation = { photoId: row._id, storageId };
            else {
              lost.ids.add(storageId);
              await t.run(async (ctx) => {
                if (await ctx.db.system.get(storageId as Id<'_storage'>))
                  await ctx.storage.delete(storageId as Id<'_storage'>);
              });
            }
          }
          break;
        }
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
    await checkInvariants(t, reportId, photos, uploads);
  }

  // Faults cleared and the clock run on: everything owed is done.
  failing.ids.clear();
  for (let d = 0; d < 4; d++) {
    await advance(t, 1500);
    await t.mutation(internal.photoPurge.sweepPhotoFiles, { now: Date.now() });
    await t.finishInProgressScheduledFunctions();
  }
  await checkInvariants(t, reportId, photos, uploads);
  const end = await t.run(async (ctx) => {
    const rows = await ctx.db.query('photos').collect();
    const live = new Set(
      rows
        .filter((r) => r.purgedAt === undefined && r.bytesMissingAt === undefined)
        .flatMap((r) => [r.storageId, r.thumbStorageId]),
    );
    const named = new Set([...uploads, ...rows.flatMap((r) => [r.storageId, r.thumbStorageId])]);
    const stored = (await ctx.db.system.query('_storage').collect()).map((f) => f._id as string);
    return {
      ledger: (await ctx.db.query('photoFiles').collect()).length,
      open: (await ctx.db.query('photoRotations').collect()).filter(
        (a) => a.status !== 'reconciled',
      ).length,
      strays: stored.filter((id) => !named.has(id)),
      missing: [...live].filter((id) => !stored.includes(id) && !lost.ids.has(id)),
      // A photo marked missing: its watch ended, and nothing was scheduled for it after the marking.
      retriedAfterMissing: (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (f) => {
          const photoId = (f.args[0] as { photoId?: string } | undefined)?.photoId;
          const row = rows.find((r) => r._id === photoId);
          return (
            row?.bytesMissingAt !== undefined &&
            /rotateBlobs|rotationWatch/.test(f.name) &&
            (f.state.kind === 'pending' || Math.floor(f._creationTime) > row.bytesMissingAt)
          );
        },
      ).length,
    };
  });
  expect(end).toEqual({ ledger: 0, open: 0, strays: [], missing: [], retriedAfterMissing: 0 });
}

/** One rotation attempt of photo `p`, as its action runs it — stopped dead at `kill`. */
async function attempt(t: T, p: Id<'photos'>, kill: Kill): Promise<string | undefined> {
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
      // As `rotateBlobs` stores it: tagged with its attempt.
      return bytes
        ? ((await ctx.storage.store(
            bytes.slice(0, bytes.size, copyContentType(bytes.type, begun.attemptId)),
          )) as string)
        : null;
    });
    if (copy === null) {
      // As the action does: a file gone stops the rotation for good, with exactly these arguments.
      await t.mutation(internal.photos.markBytesMissing, {
        photoId: p,
        old: { storageId: begun.storageId, thumbStorageId: begun.thumbStorageId },
      });
      await t.mutation(internal.photos.endRotation, { attemptId: begun.attemptId });
      return;
    }
    if (kill === storeKill) return;
    await t.mutation(internal.photos.recordRotationCopy, { attemptId: begun.attemptId, copy });
    if (kill === recordKill) return;
    next.push(copy);
  }
  // Rows other than `p` naming either old file — its twins, which keep that file.
  const twins = await t.run(async (ctx) =>
    (await ctx.db.query('photos').collect())
      .filter(
        (r) =>
          r._id !== p &&
          [r.storageId, r.thumbStorageId].some(
            (id) => id === begun.storageId || id === begun.thumbStorageId,
          ),
      )
      .map((r) => r._id),
  );
  const prior = await t.run((ctx) => ctx.db.get(p));
  const outcome = await t.mutation(internal.photos.swapRotated, {
    attemptId: begun.attemptId,
    old: { storageId: begun.storageId, thumbStorageId: begun.thumbStorageId },
    next: { storageId: next[0] as string, thumbStorageId: next[1] as string },
  });
  if (outcome === 'rotated') {
    // Eight kept at most; the marker exactly when more than eight were there (or already marked).
    const row = await t.run((ctx) => ctx.db.get(p));
    const all = new Set([...(prior?.sameBytesAs ?? []), ...twins]);
    const recorded = row?.sameBytesAs ?? [];
    const cut = all.size > SAME_BYTES_MAX || prior?.sameBytesCut === true;
    if (recorded.length !== Math.min(all.size, SAME_BYTES_MAX))
      return 'a swap kept the wrong count';
    if (recorded.some((id) => !all.has(id))) return 'a swap recorded a stranger';
    if ((row?.sameBytesCut === true) !== cut) return 'a swap’s cut marker is wrong';
  }
  if (kill === 'swap') return;
  await t.mutation(internal.photos.endRotation, { attemptId: begun.attemptId });
}

async function checkInvariants(
  t: T,
  reportId: Id<'reports'>,
  photos: Id<'photos'>[],
  uploads: Set<string>,
) {
  const state = await t.run(async (ctx) => {
    const rows = await ctx.db.query('photos').collect();
    const ledger = await ctx.db.query('photoFiles').collect();
    const attempts = await ctx.db.query('photoRotations').collect();
    const stored = await ctx.db.system.query('_storage').collect();
    const failures = (await ctx.db.query('jobFailures').collect()).filter(
      (f) => f.job === 'photoRotation' && f.key.startsWith('file:'),
    );
    const rotationFailures = (await ctx.db.query('jobFailures').collect()).filter(
      (f) => f.job === 'photoRotation' && !f.key.startsWith('file:'),
    );
    return { rows, ledger, attempts, stored, failures, rotationFailures };
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
        isCopyOf(f.contentType, a._id) &&
        a.sha256.includes(f.sha256) &&
        f._creationTime > a.scanFrom &&
        f._creationTime <= a.startedAt + ACTION_LIFETIME_MS,
    );
    // Invariants 1, 3: named, or one ledger row, or findable by an unreconciled attempt.
    expect(
      named.has(id) || ledgered === 1 || findable || uploads.has(id),
      `stored file ${id} is named by nothing`,
    ).toBe(true);
    expect(ledgered, `stored file ${id} has more than one ledger row`).toBeLessThanOrEqual(1);
  }
  // Machinery lists a file only while the ledger owes its deletion.
  const doomed = new Set(state.ledger.filter((r) => r.state === 'doomed').map((r) => r.storageId));
  for (const f of state.failures) {
    expect(doomed.has(f.key.slice('file:'.length)), `Machinery lists ${f.key}, owed nothing`).toBe(
      true,
    );
  }
  for (const r of state.ledger) {
    if (r.state === 'copy')
      expect(named.has(r.storageId), 'a recorded copy is a row slot').toBe(false);
  }
  // Invariant 2: every id any row names, in either slot, exists — a tombstone names nothing.
  for (const r of state.rows) {
    if (r.purgedAt !== undefined) {
      expect([r.storageId, r.thumbStorageId], `tombstone ${r._id} names a file`).toEqual([
        TOMBSTONE_FILE,
        TOMBSTONE_FILE,
      ]);
      continue;
    }
    if (r.bytesMissingAt !== undefined) {
      // Marked once: one Machinery row, parked, never retried daily.
      const rows = state.rotationFailures.filter((f) => f.key === r._id);
      expect(rows, `photo ${r._id} marked missing, Machinery shows it once`).toEqual([
        expect.objectContaining({ errorClass: 'BytesMissing', parkedAt: expect.any(Number) }),
      ]);
      continue;
    }
    // Only a file lost from outside may be missing — never one the app deleted.
    expect(ids.has(r.storageId) || lost.ids.has(r.storageId), `photo ${r._id} lost its image`).toBe(
      true,
    );
    expect(
      ids.has(r.thumbStorageId) || lost.ids.has(r.thumbStorageId),
      `photo ${r._id} lost its thumbnail`,
    ).toBe(true);
  }
  // A skater's unattached upload is no machinery's to delete.
  for (const id of uploads) expect(ids.has(id), `upload ${id} was deleted`).toBe(true);
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
  'a thumbnail lost mid-rotation (the action’s own missing path)': [
    { k: 'upload' },
    { k: 'vanish', i: 0, slot: 'thumb', when: 'midRotation' },
    { k: 'set', i: 0, status: 'hidden' },
    { k: 'advance', minutes: 61 },
  ],
  'an image lost before the takedown': [
    { k: 'upload' },
    { k: 'vanish', i: 0, slot: 'image', when: 'now' },
    { k: 'set', i: 0, status: 'removed' },
    { k: 'advance', minutes: 61 },
  ],
  'nine twins of one file, then a rotation': [
    { k: 'upload' },
    { k: 'legacyMany', i: 0, slot: 'image', as: 'image', n: 9 },
    { k: 'attempt', i: 0, kill: 'none', down: true },
  ],
  'eight twins across both slots, then a rotation': [
    { k: 'upload' },
    { k: 'legacyMany', i: 0, slot: 'image', as: 'thumb', n: 4 },
    { k: 'legacyMany', i: 0, slot: 'thumb', as: 'image', n: 4 },
    { k: 'attempt', i: 0, kill: 'none', down: true },
  ],
  'a crossed twin, then a rotation': [
    { k: 'upload' },
    { k: 'legacyShare', i: 0, a: 'thumb', j: 0, b: 'image' },
    { k: 'attempt', i: 0, kill: 'none', down: true },
  ],
  'a shared file’s holders purged': [
    { k: 'upload' },
    { k: 'legacyShare', i: 0, a: 'image', j: 0, b: 'image' },
    { k: 'set', i: 0, status: 'removed' },
    { k: 'advance', minutes: 44_640 },
    { k: 'purge' },
  ],
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
      // A few photos first, so most steps act on something.
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(opArb, { minLength: 4, maxLength: 30 }),
        (uploads, ops) => run([...Array.from({ length: uploads }, () => UPLOAD), ...ops]),
      ),
      { numRuns: 30, seed: SEED },
    );
  }, 60_000);
});
