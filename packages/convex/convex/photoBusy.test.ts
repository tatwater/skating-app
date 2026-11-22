/**
 * **The photo axis at busy rows** (B01-5e), under the harness's real limits (index ranges, scanned
 * documents, bytes — `vitest.config.ts`): a report with hundreds of photos, most of them down, through
 * every read and a takedown; an uploader with hundreds of removed photos through the purge's pages; a
 * photo with hundreds of decided flags and a busy neighbor through the hold and the purge.
 *
 * There is no cap on a report's photos at the write (only Convex's 8,192-item array limit), so "the
 * most the form allows" is not a number the server holds; these fixtures take 400.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { PHOTO_SIBLINGS_READ } from './lib/inboxViews';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { PURGE_PAGE } from './photoPurge';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 11, 2, 12);
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
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
      createdAt: T0 - 86_400_000,
    }),
  );
}

const CAPTION = 'c'.repeat(500); // at the caption cap: every photo row at its worst

/** `n` photos sharing two blobs (the reads weigh rows, not bytes), `down` of them hidden. */
async function manyPhotos(t: T, uploaderId: Id<'profiles'>, n: number, over: (i: number) => Partial<Doc<'photos'>>) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(['full']));
    const thumbStorageId = await ctx.storage.store(new Blob(['thumb']));
    const ids: Id<'photos'>[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert('photos', {
          storageId,
          thumbStorageId,
          uploaderId,
          caption: CAPTION,
          placeOnMap: false,
          createdAt: T0 - i,
          ...over(i),
        }),
      );
    }
    return ids;
  });
}

async function lakeAndReport(t: T, authorId: Id<'profiles'>, photoIds: Id<'photos'>[]) {
  return t.run(async (ctx) => {
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
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds,
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
    });
    for (const id of photoIds) await ctx.db.patch(id, { reportId });
    return { waterBodyId, reportId };
  });
}

const BUSY_REPORT = 400;

describe('a report with hundreds of photos, most of them down', () => {
  test('every read fits; non-staff reads show only the visible; the strip is capped; a takedown fits', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    await person(t, 'skater');
    await person(t, 'mod', 'moderator');
    const ids = await manyPhotos(t, uploader, BUSY_REPORT, (i) =>
      i % 4 === 0 ? {} : { moderationStatus: 'hidden' as const },
    );
    const { waterBodyId, reportId } = await lakeAndReport(t, uploader, ids);
    const skater = t.withIdentity({ subject: 'skater' });
    const mod = t.withIdentity({ subject: 'mod' });

    expect(await skater.query(api.photos.getUrls, { reportId })).toHaveLength(BUSY_REPORT / 4);
    expect(await mod.query(api.photos.getUrls, { reportId, staff: true })).toHaveLength(BUSY_REPORT);
    const cards = await skater.query(api.reports.recentCardsForBodies, { waterBodyIds: [waterBodyId] });
    expect(cards[0]?.photoThumbUrls).toHaveLength(BUSY_REPORT / 4);

    const target = ids[1] as Id<'photos'>; // a hidden one; flag the first visible instead
    const visible = ids[0] as Id<'photos'>;
    const flagId = await skater.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: visible,
      reason: 'inappropriate',
    });
    const itemId = await t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
        .first();
      return m?.itemId as Id<'inboxItems'>;
    });
    const read = await mod.query(api.inbox.item, { ref: itemId });
    const photo = (read.item as { target: { photo: { siblings: unknown[]; siblingsCapped: boolean; photoCount: number } } }).target.photo;
    expect(photo.siblings).toHaveLength(PHOTO_SIBLINGS_READ);
    expect(photo.siblingsCapped).toBe(true);
    expect(photo.photoCount).toBe(BUSY_REPORT);

    const out = await mod.mutation(api.inboxWrites.takeDown, { itemId, status: 'removed', reason: 'x' });
    expect(out.status).toBe('removed');
    void target;
  }, 60_000);

  test('an author’s edit that drops them all keeps every held one, in one transaction', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const ids = await manyPhotos(t, uploader, BUSY_REPORT, (i) =>
      i % 4 === 0 ? {} : { moderationStatus: 'hidden' as const },
    );
    const { reportId } = await lakeAndReport(t, uploader, ids);
    const { keepHeldPhotos } = await import('./lib/photoAccess');
    const kept = await t.run(async (ctx) => {
      const r = (await ctx.db.get(reportId)) as Doc<'reports'>;
      return keepHeldPhotos(ctx, [], r.photoIds);
    });
    expect(kept).toHaveLength((BUSY_REPORT * 3) / 4);
  }, 60_000);
});

describe('an uploader with hundreds of removed photos: the purge’s pages', () => {
  test('three pages at the real page size, each under the limits; every one a tombstone', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const n = PURGE_PAGE * 2 + 37;
    const ids = await t.run(async (ctx) => {
      const out: Id<'photos'>[] = [];
      for (let i = 0; i < n; i++) {
        out.push(
          await ctx.db.insert('photos', {
            storageId: await ctx.storage.store(new Blob([`f${i}`])),
            thumbStorageId: await ctx.storage.store(new Blob([`t${i}`])),
            uploaderId: uploader,
            caption: CAPTION,
            placeOnMap: false,
            createdAt: T0 - i,
            moderationStatus: 'removed',
            purgeAt: T0 - 1 - i,
          }),
        );
      }
      return out;
    });
    // Busy neighbors with no clock: never read by the due range.
    await manyPhotos(t, uploader, 300, () => ({}));
    const first = await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 });
    expect(first).toMatchObject({ purged: PURGE_PAGE, more: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    expect(rows.filter((r) => r?.purgedAt !== undefined)).toHaveLength(n);
    expect(await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)).toBe(2);
  }, 60_000);
});

describe('a photo with hundreds of decided flags, and a busy neighbor', () => {
  test('the hold is point reads: decided flags never hold, never scanned', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const [quiet, busy] = await manyPhotos(t, uploader, 2, () => ({}));
    await t.run(async (ctx) => {
      for (let i = 0; i < 400; i++) {
        await ctx.db.insert('contentFlags', {
          targetType: 'photo',
          targetId: quiet as Id<'photos'>,
          flaggerId: flagger,
          reason: 'spam',
          status: 'dismissed',
          createdAt: T0 - i,
          origin: 'user',
        } as never);
        // The neighbor's open flags: never the quiet photo's hold.
        await ctx.db.insert('contentFlags', {
          targetType: 'photo',
          targetId: busy as Id<'photos'>,
          flaggerId: flagger,
          reason: 'spam',
          status: 'open',
          createdAt: T0 - i,
          origin: 'user',
        } as never);
      }
    });
    const results = await t.run(async (ctx) => [
      await deletePhotoAndBlobs(ctx, (await ctx.db.get(busy as Id<'photos'>)) as Doc<'photos'>),
      await deletePhotoAndBlobs(ctx, (await ctx.db.get(quiet as Id<'photos'>)) as Doc<'photos'>),
    ]);
    expect(results).toEqual(['held', 'deleted']);
  }, 60_000);
});
