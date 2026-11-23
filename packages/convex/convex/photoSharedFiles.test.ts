/**
 * **A file another row names is never deleted** (B01-5e, `lib/photoFiles` invariant 2). Rows written
 * before storage ids were keys may share a file in any slot: one row's image as another's image or
 * thumbnail, a thumbnail as either, one file in both of a row's slots, chains of three. Every path
 * that deletes a photo's files — the delete every background deleter and the uploader's withdrawal
 * call, the purge, the rotation's swap, a doomed file's retry — leaves a file any row still names,
 * checked in the transaction that deletes; a tombstone names nothing, so a live holder is found
 * however many tombstones once shared its file; the window's search takes only its own attempt's
 * tagged copy, never a skater's upload of the same bytes; and a taken-down photo whose old file stays
 * with a twin records the twin, which the Inbox item shows with its status.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { TOMBSTONE_FILE } from './lib/photoAccess';
import { copyContentType, DOOMED_RETRY_MS, isRotationCopy } from './lib/photoFiles';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { BLOB_ATTACHED } from './photos';
import schema from './schema';

/** Deletes that fail, by storage id, until cleared. */
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

async function person(t: T, subject: string, role: Doc<'profiles'>['role'] = 'member') {
  const id = await t.run((ctx) =>
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
      createdAt: T0 - 86_400_000,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

let n = 0;
const file = (t: T, type = 'image/jpeg') =>
  t.run(async (ctx) => (await ctx.storage.store(new Blob([`bytes-${++n}`], { type }))) as string);

async function world() {
  const t = harness();
  const uploader = await person(t, 'uploader');
  const mod = await person(t, 'mod', 'moderator');
  const row = (storageId: string, thumbStorageId: string, over: Partial<Doc<'photos'>> = {}) =>
    t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId,
        thumbStorageId,
        uploaderId: uploader.id,
        placeOnMap: false,
        createdAt: T0,
        moderationStatus: 'visible',
        ...over,
      }),
    );
  return { t, uploader, mod, row };
}

const get = (t: T, id: Id<'photos'>) => t.run((ctx) => ctx.db.get(id));
const exists = (t: T, id: string) =>
  t.run(async (ctx) => (await ctx.db.system.get(id as Id<'_storage'>)) !== null);
const stored = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_storage').collect()).map((f) => f._id as string).sort(),
  );
const ledger = (t: T) => t.run((ctx) => ctx.db.query('photoFiles').collect());
const fileFailures = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('jobFailures').collect()).filter((f) => f.key.startsWith('file:')),
  );

/** Run the schedule a minute at a time, as a deployment's clock moves. */
async function stepThrough(t: T, minutes: number) {
  for (let i = 0; i < minutes; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await t.finishInProgressScheduledFunctions();
  }
}

/** Every id the rows name, in either slot, exists — a tombstone names nothing. */
async function everyNamedFileExists(t: T) {
  const rows = await t.run((ctx) => ctx.db.query('photos').collect());
  const ids = new Set(await stored(t));
  for (const r of rows) {
    if (r.purgedAt !== undefined) {
      expect([r.storageId, r.thumbStorageId]).toEqual([TOMBSTONE_FILE, TOMBSTONE_FILE]);
      continue;
    }
    expect(ids.has(r.storageId), `${r._id} lost its image`).toBe(true);
    expect(ids.has(r.thumbStorageId), `${r._id} lost its thumbnail`).toBe(true);
  }
}

type W = Awaited<ReturnType<typeof world>>;
/** Photo `p`'s files let go by one path. */
const PATHS: Record<string, (w: W, p: Id<'photos'>) => Promise<void>> = {
  'the delete (every background deleter, the uploader’s withdrawal)': async ({ t }, p) => {
    await t.run(async (ctx) => {
      await deletePhotoAndBlobs(ctx, (await ctx.db.get(p)) as Doc<'photos'>);
    });
  },
  'the purge': async ({ t }, p) => {
    await t.run((ctx) => ctx.db.patch(p, { moderationStatus: 'removed', purgeAt: T0 }));
    await t.mutation(internal.photoPurge.purgeDuePhotos, { now: Date.now() });
  },
  'the rotation’s swap': async ({ t, mod }, p) => {
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: p,
      status: 'hidden',
      reason: 'x',
    });
    await stepThrough(t, 90);
  },
};

/** Photo A's files `a`, `b`; the rows sharing them (a fresh file where `f`). */
const SHARES: Record<string, { a: (x: string[]) => [string, string]; twins: string[][] }> = {
  'A’s image as B’s image': { a: ([a, b]) => [a, b] as never, twins: [['a', 'f']] },
  'A’s image as B’s thumbnail': { a: ([a, b]) => [a, b] as never, twins: [['f', 'a']] },
  'A’s thumbnail as B’s image': { a: ([a, b]) => [a, b] as never, twins: [['b', 'f']] },
  'A’s thumbnail as B’s thumbnail': { a: ([a, b]) => [a, b] as never, twins: [['f', 'b']] },
  'both crossed: B is A’s thumbnail and image': {
    a: ([a, b]) => [a, b] as never,
    twins: [['b', 'a']],
  },
  'one file in both of A’s slots, B’s thumbnail': {
    a: ([a]) => [a, a] as never,
    twins: [['f', 'a']],
  },
  'three rows: B holds A’s thumbnail, C A’s image': {
    a: ([a, b]) => [a, b] as never,
    twins: [
      ['b', 'f'],
      ['f', 'a'],
    ],
  },
};

describe('every path keeps a shared file for the rows still naming it', () => {
  for (const [share, { a: shape, twins: spec }] of Object.entries(SHARES)) {
    for (const [path, letGo] of Object.entries(PATHS)) {
      test(`${share} — ${path}`, async () => {
        const w = await world();
        const { t, row } = w;
        const [a, b] = shape([await file(t), await file(t)]);
        const p = await row(a, b);
        const twins: Id<'photos'>[] = [];
        for (const [img, th] of spec) {
          const pickId = async (k: string) => (k === 'a' ? a : k === 'b' ? b : await file(t));
          twins.push(await row(await pickId(img as string), await pickId(th as string)));
        }
        const sharedIds = new Set(
          (await Promise.all(twins.map((id) => get(t, id)))).flatMap((r) => [
            r?.storageId,
            r?.thumbStorageId,
          ]),
        );
        await letGo(w, p);
        await everyNamedFileExists(t);
        // A's files no twin names are gone; the shared ones stay; nothing owed.
        for (const id of new Set([a, b])) expect(await exists(t, id)).toBe(sharedIds.has(id));
        expect(await ledger(t)).toEqual([]);
        if (path === 'the rotation’s swap') {
          // The taken-down photo has its own copy, and records the twins still showing the image.
          const after = (await get(t, p)) as Doc<'photos'>;
          expect([after.storageId, after.thumbStorageId]).not.toContain(a);
          expect(after.sameBytesAs?.sort()).toEqual([...twins].sort());
        }
        // The twins go too: the last holder's delete takes the file.
        for (const id of twins) {
          await t.run(async (ctx) => {
            await deletePhotoAndBlobs(ctx, (await ctx.db.get(id)) as Doc<'photos'>);
          });
          await everyNamedFileExists(t);
        }
        for (const id of new Set([a, b])) expect(await exists(t, id)).toBe(false);
      });
    }
  }
});

describe('a tombstone names nothing', () => {
  test('a live holder is found behind any number of purged rows that shared its file', async () => {
    const { t, row } = await world();
    const x = await file(t);
    const rows: Id<'photos'>[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(i % 2 === 0 ? await row(x, await file(t)) : await row(await file(t), x));
    }
    const live = rows.pop() as Id<'photos'>;
    await t.run(async (ctx) => {
      for (const id of rows) await ctx.db.patch(id, { moderationStatus: 'removed', purgeAt: T0 });
    });
    await t.mutation(internal.photoPurge.purgeDuePhotos, { now: Date.now() });
    for (const id of rows) expect((await get(t, id))?.purgedAt).toEqual(expect.any(Number));
    expect(await exists(t, x)).toBe(true);
    await everyNamedFileExists(t);
    await t.run(async (ctx) => {
      await deletePhotoAndBlobs(ctx, (await ctx.db.get(live)) as Doc<'photos'>);
    });
    expect(await stored(t)).toEqual([]);
  });
});

describe('a doomed file is re-checked at its retry', () => {
  test('a row naming it since keeps it; nothing is owed, Machinery’s row cleared', async () => {
    const { t, row } = await world();
    const [a, b] = [await file(t), await file(t)];
    const p = await row(a, b);
    failing.ids.add(a);
    await t.run(async (ctx) => {
      await deletePhotoAndBlobs(ctx, (await ctx.db.get(p)) as Doc<'photos'>);
    });
    expect(await ledger(t)).toEqual([expect.objectContaining({ storageId: a, state: 'doomed' })]);
    expect(await fileFailures(t)).toHaveLength(1);
    // Between its dooming and its retry, a row comes to name it (an import, a legacy restore).
    const adopter = await row(await file(t), a);
    failing.ids.clear();
    await vi.advanceTimersByTimeAsync((DOOMED_RETRY_MS[0] as number) + 1);
    await t.mutation(internal.photoPurge.sweepPhotoFiles, { now: Date.now() });
    expect(await exists(t, a)).toBe(true);
    expect(await ledger(t)).toEqual([]);
    expect(await fileFailures(t)).toEqual([]);
    await everyNamedFileExists(t);
    expect(await get(t, adopter)).not.toBeNull();
  });

  test('a twin created after a takedown is scheduled, before its swap: kept and recorded', async () => {
    const { t, mod, row } = await world();
    const [a, b] = [await file(t), await file(t)];
    const p = await row(a, b);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: p,
      status: 'hidden',
      reason: 'x',
    });
    const twin = await row(a, await file(t));
    await stepThrough(t, 90);
    expect(await exists(t, a)).toBe(true);
    expect(await exists(t, b)).toBe(false);
    expect((await get(t, p))?.sameBytesAs).toEqual([twin]);
    await everyNamedFileExists(t);
  });
});

describe('the window’s search takes only its own attempt’s copy', () => {
  test('the action stores each copy tagged, still the image it was', async () => {
    const { t, mod, row } = await world();
    const p = await row(await file(t), await file(t, 'image/webp'));
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: p,
      status: 'hidden',
      reason: 'x',
    });
    await stepThrough(t, 90);
    const after = (await get(t, p)) as Doc<'photos'>;
    const types = await t.run(async (ctx) =>
      Promise.all(
        [after.storageId, after.thumbStorageId].map(
          async (id) => (await ctx.db.system.get(id as Id<'_storage'>))?.contentType,
        ),
      ),
    );
    expect(types.map((c) => isRotationCopy(c))).toEqual([true, true]);
    expect(types.map((c) => c?.split(';')[0])).toEqual(['image/jpeg', 'image/webp']);
  });

  test('a skater’s same-bytes upload, another attempt’s copy: kept; its own untagged copy can’t exist', async () => {
    const { t, row } = await world();
    const a = await file(t);
    const b = await file(t);
    const p = await row(a, b, { moderationStatus: 'hidden' });
    const begun = await t.mutation(internal.photos.beginRotation, { photoId: p });
    if (begun.kind !== 'go') throw new Error('not begun');
    const copyOf = (src: string, type: string) =>
      t.run(async (ctx) => {
        const bytes = (await ctx.storage.get(src as Id<'_storage'>)) as Blob;
        return (await ctx.storage.store(bytes.slice(0, bytes.size, type))) as string;
      });
    // Its own copy, stored and never recorded (the action killed): tagged, so found and deleted.
    const own = await copyOf(a, copyContentType('image/jpeg', begun.attemptId));
    // A skater's fresh upload of the same image in the same minute: untagged — never this attempt's.
    const upload = await copyOf(a, 'image/jpeg');
    // Another attempt's tag on the same bytes: not this one's either.
    const otherTag = await copyOf(
      a,
      copyContentType('image/jpeg', 'kd7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Id<'photoRotations'>),
    );
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await t.mutation(internal.photoPurge.sweepPhotoFiles, { now: Date.now() });
    expect(await exists(t, own)).toBe(false);
    expect(await exists(t, upload)).toBe(true);
    expect(await exists(t, otherTag)).toBe(true);
    await everyNamedFileExists(t);
  });

  test('removeBlob refuses any rotation copy; a fresh untagged upload it takes', async () => {
    const { t, uploader, row } = await world();
    const p = await row(await file(t), await file(t), { moderationStatus: 'hidden' });
    const begun = await t.mutation(internal.photos.beginRotation, { photoId: p });
    if (begun.kind !== 'go') throw new Error('not begun');
    const copy = await file(t, copyContentType('image/jpeg', begun.attemptId));
    await expect(
      uploader.as.mutation(api.photos.removeBlob, { storageId: copy as Id<'_storage'> }),
    ).rejects.toThrow(BLOB_ATTACHED);
    expect(await exists(t, copy)).toBe(true);
    const upload = await file(t);
    await uploader.as.mutation(api.photos.removeBlob, { storageId: upload as Id<'_storage'> });
    expect(await exists(t, upload)).toBe(false);
  });
});

describe('the Inbox shows a taken-down photo’s twins', () => {
  async function flagged() {
    const w = await world();
    const { t, uploader, row } = w;
    const skater = await person(t, 'skater');
    const [a, b] = [await file(t), await file(t)];
    const p = await row(a, b);
    const twin = await row(await file(t), a, { moderationStatus: 'hidden' });
    await t.run(async (ctx) => {
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
      const reportId = await ctx.db.insert('reports', {
        authorId: uploader.id,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [p],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
      await ctx.db.patch(p, { reportId });
    });
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: p,
      reason: 'inappropriate',
    });
    const itemId = await t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
        .first();
      return m?.itemId as Id<'inboxItems'>;
    });
    const photoShown = async () => {
      const read = await w.mod.as.query(api.inbox.item, { ref: itemId });
      const target = (
        read.item as { target: { photo: { sameBytesAs: unknown[]; sameBytesCut: boolean } } }
      ).target;
      return target.photo;
    };
    const twinsShown = async () => (await photoShown()).sameBytesAs;
    return { ...w, skater, p, twin, a, twinsShown, photoShown };
  }

  test('before the rotation (by the shared id) and after it (recorded), with the twin’s status', async () => {
    const { t, mod, p, twin, a, twinsShown } = await flagged();
    expect(await twinsShown()).toEqual([
      { photoId: twin, moderationStatus: 'hidden', openFlagId: null, reportId: null },
    ]);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: p,
      status: 'removed',
      reason: 'x',
    });
    await stepThrough(t, 90);
    expect((await get(t, p))?.storageId).not.toBe(a);
    expect(await exists(t, a)).toBe(true);
    expect(await twinsShown()).toEqual([
      { photoId: twin, moderationStatus: 'hidden', openFlagId: null, reportId: null },
    ]);
    // A twin gone since (its row deleted — a hidden twin is held, so by erasure's path): not shown.
    await t.run((ctx) => ctx.db.delete(twin));
    expect(await twinsShown()).toEqual([]);
  });

  test('each twin with its own open flag and its report; past eight, a floor', async () => {
    const { t, row, skater, p, a, twinsShown, photoShown } = await flagged();
    const reportId = (await get(t, p))?.reportId as Id<'reports'>;
    const shown = await row(await file(t), a);
    await t.run(async (ctx) => {
      await ctx.db.patch(shown, { reportId });
      const report = await ctx.db.get(reportId);
      await ctx.db.patch(reportId, { photoIds: [...(report?.photoIds ?? []), shown] });
    });
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: shown,
      reason: 'inappropriate',
    });
    expect(await twinsShown()).toContainEqual({
      photoId: shown,
      moderationStatus: 'visible',
      openFlagId: flagId,
      reportId,
    });
    expect((await photoShown()).sameBytesCut).toBe(false);
    // Seven more rows naming the shared file: nine twins, eight shown, the list a floor.
    for (let i = 0; i < 7; i++) await row(await file(t), a);
    const full = await photoShown();
    expect(full.sameBytesAs).toHaveLength(8);
    expect(full.sameBytesCut).toBe(true);
  });

  // The twins name the shared file in the photo's own slot, so the photo is inside every range read.
  for (const n of [8, 9, 10]) {
    test(`${n} twins: eight shown, cut only past eight — before the takedown and after its swap`, async () => {
      const { t, mod, row, p, a, photoShown } = await flagged();
      for (let i = 1; i < n; i++) await row(a, await file(t));
      const before = await photoShown();
      expect(before.sameBytesAs).toHaveLength(8);
      expect(before.sameBytesCut).toBe(n > 8);
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: p,
        status: 'hidden',
        reason: 'x',
      });
      await stepThrough(t, 90);
      const rotated = (await get(t, p)) as Doc<'photos'>;
      expect(rotated.storageId).not.toBe(a);
      // Recorded from a read that proved a ninth: eight ids and the marker, never a guess.
      expect(rotated.sameBytesAs).toHaveLength(8);
      expect(rotated.sameBytesCut).toBe(n > 8 ? true : undefined);
      const after = await photoShown();
      expect(after.sameBytesAs.map((x) => (x as { photoId: string }).photoId)).toEqual(
        rotated.sameBytesAs,
      );
      expect(after.sameBytesCut).toBe(n > 8);
    });
  }
});
