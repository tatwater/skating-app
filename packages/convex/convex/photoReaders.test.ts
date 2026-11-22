/**
 * **Who gets a photo** (B01-5e, D222): for each reader × each viewer × each status, what comes back. A
 * skater or the public never gets a hidden, removed or purged photo's URL, caption, slot or count; a
 * staff read (asked for, and only with `content.read`) gets it marked `down`. Also: `listPhotos` joins
 * by id, never by position; the Inbox's photo subject serves the bytes only with `content.read`.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { InboxReader, itemView } from './lib/inboxViews';
import { ReadBudget } from './lib/readBudget';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 11, 2, 12);
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
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

/** Each status a photo can stand in, as the row stores it. */
const STATUSES = {
  absent: {},
  visible: { moderationStatus: 'visible' as const },
  hidden: { moderationStatus: 'hidden' as const, moderatedAt: T0 },
  removed: { moderationStatus: 'removed' as const, moderatedAt: T0, purgeAt: T0 + 1 },
  purged: { moderationStatus: 'removed' as const, moderatedAt: T0, purgedAt: T0 },
} satisfies Record<string, Partial<Doc<'photos'>>>;
type Status = keyof typeof STATUSES;
const STATUS_KEYS = Object.keys(STATUSES) as Status[];
const SHOWN: ReadonlySet<Status> = new Set(['absent', 'visible']);

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

/** One photo per status, on a report, a hazard and a put-in; each photo captioned by its status. */
async function world() {
  const t = harness();
  const uploader = await person(t, 'uploader');
  await person(t, 'skater');
  await person(t, 'mod', 'moderator');
  const built = await t.run(async (ctx) => {
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
    const byStatus = {} as Record<Status, Id<'photos'>>;
    for (const status of STATUS_KEYS) {
      byStatus[status] = await ctx.db.insert('photos', {
        storageId: await ctx.storage.store(new Blob([`${status}-full`])),
        thumbStorageId: await ctx.storage.store(new Blob([`${status}-thumb`])),
        uploaderId: uploader,
        caption: status,
        placeOnMap: true,
        coord: { lat: 0.5, lng: 0.5 },
        createdAt: T0,
        ...STATUSES[status],
      });
    }
    const photoIds = STATUS_KEYS.map((s) => byStatus[s]);
    const reportId = await ctx.db.insert('reports', {
      authorId: uploader,
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
    const hazardId = await ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 40,
      bbox: { minLat: 0.49, minLng: 0.49, maxLat: 0.51, maxLng: 0.51 },
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      healingState: 'none' as const,
      confirmCount: 0,
      goneCount: 0,
      snowHidden: false,
      photoIds,
      createdByUserId: uploader,
      createdAt: T0,
      firstReportedAt: T0,
      lastConfirmedAt: T0,
    });
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.5 },
      source: 'derived' as const,
      status: 'visible' as const,
      createdAt: T0,
    });
    const attachments = {} as Record<Status, Id<'accessPhotos'>>;
    for (const status of STATUS_KEYS) {
      attachments[status] = await ctx.db.insert('accessPhotos', {
        targetType: 'put_in' as const,
        putInId,
        photoId: byStatus[status],
        uploaderId: uploader,
        createdAt: T0,
      });
    }
    return { waterBodyId, byStatus, reportId, hazardId, putInId, attachments };
  });
  return { t, ...built };
}

type W = Awaited<ReturnType<typeof world>> & { t: T };

const VIEWERS = ['anonymous', 'uploader', 'skater', 'mod'] as const;
type Viewer = (typeof VIEWERS)[number];
const clientOf = (t: T, v: Viewer) => (v === 'anonymous' ? t : t.withIdentity({ subject: v }));

/** Each skater-facing reader as one function: the photos it returns, by caption (= status). */
const READERS: Record<
  string,
  (w: W, v: Viewer, staff: boolean) => Promise<{ caption?: string; down?: true; url: string | null }[]>
> = {
  getUrls: (w, v, staff) =>
    clientOf(w.t, v).query(api.photos.getUrls, { reportId: w.reportId, staff }),
  getHazardUrls: (w, v, staff) =>
    clientOf(w.t, v).query(api.photos.getHazardUrls, { hazardId: w.hazardId, staff }),
  listPhotos: (w, v, staff) =>
    clientOf(w.t, v).query(api.accessPoints.listPhotos, {
      targetType: 'put_in',
      putInId: w.putInId,
      staff,
    }),
};

describe('the privacy table: reader × viewer × status', () => {
  test('a non-staff read gets only visible photos; a staff read (content.read, asked) gets every one marked', async () => {
    const w = (await world()) as W;
    let cells = 0;
    for (const [name, read] of Object.entries(READERS)) {
      for (const viewer of VIEWERS) {
        for (const staff of [false, true]) {
          const got = await read(w, viewer, staff);
          const staffRead = staff && viewer === 'mod';
          for (const status of STATUS_KEYS) {
            cells++;
            const hit = got.find((p) => p.caption === status);
            const label = `${name} · ${viewer} · staff=${staff} · ${status}`;
            if (SHOWN.has(status)) {
              expect(hit, label).toBeDefined();
              expect(hit?.down, label).toBeUndefined();
              expect(hit?.url, label).toEqual(expect.any(String));
            } else if (staffRead) {
              expect(hit, label).toBeDefined();
              expect(hit?.down, label).toBe(true);
            } else {
              expect(hit, label).toBeUndefined();
            }
          }
          // No slot for what is skipped: the list is exactly what was shown.
          expect(got).toHaveLength(staffRead ? STATUS_KEYS.length : SHOWN.size);
        }
      }
    }
    // A purged photo's staff read has no bytes to serve.
    const purged = (await READERS.getUrls?.(w, 'mod', true))?.find((p) => p.caption === 'purged');
    expect(purged?.url).toBeNull();
    expect(cells).toBe(3 * 4 * 2 * 5);
  });

  test('the feed’s thumbnails: visible photos only, for every viewer', async () => {
    const w = (await world()) as W;
    for (const viewer of VIEWERS) {
      const cards = await clientOf(w.t, viewer).query(api.reports.recentCardsForBodies, {
        waterBodyIds: [w.waterBodyId],
      });
      expect(cards[0]?.photoThumbUrls).toHaveLength(SHOWN.size);
    }
  });

  test('the Inbox report subject counts visible photos without content.read, every photo with it', async () => {
    const w = (await world()) as W;
    const mod = await w.t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'skater'))
        .first(),
    );
    const flagId = await w.t.withIdentity({ subject: 'skater' }).mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: w.reportId,
      reason: 'spam',
    });
    for (const canReadContent of [false, true]) {
      const view = await w.t.run(async (ctx) => {
        const m = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
          .first();
        const item = (await ctx.db.get(m?.itemId as Id<'inboxItems'>)) as Doc<'inboxItems'>;
        const r = new InboxReader(ctx, new ReadBudget(), T0, mod?._id as Id<'profiles'>, canReadContent);
        return itemView(r, item);
      });
      const target = (view?.view as { target: { report?: { photoCount: number } } }).target;
      expect(target.report?.photoCount).toBe(canReadContent ? STATUS_KEYS.length : SHOWN.size);
    }
  });

  test('the Inbox photo subject: no URL, no reveal, no down caption without content.read', async () => {
    const w = (await world()) as W;
    const skater = await w.t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'skater'))
        .first(),
    );
    const flagId = await w.t.withIdentity({ subject: 'skater' }).mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: w.byStatus.hidden,
      reason: 'inappropriate',
    });
    for (const canReadContent of [false, true]) {
      const view = await w.t.run(async (ctx) => {
        const m = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
          .first();
        const item = (await ctx.db.get(m?.itemId as Id<'inboxItems'>)) as Doc<'inboxItems'>;
        const r = new InboxReader(
          ctx,
          new ReadBudget(),
          T0,
          skater?._id as Id<'profiles'>,
          canReadContent,
        );
        return itemView(r, item);
      });
      const photo = (
        view?.view as {
          target: {
            photo: {
              url: string | null;
              thumbUrl: string | null;
              canReveal: boolean;
              caption: string | null;
              siblings: { photoId: Id<'photos'>; thumbUrl: string | null }[];
            };
          };
        }
      ).target.photo;
      expect(photo.canReveal).toBe(canReadContent);
      expect(photo.url === null).toBe(!canReadContent);
      expect(photo.thumbUrl === null).toBe(!canReadContent);
      expect(photo.caption).toBe(canReadContent ? 'hidden' : null);
      expect(photo.siblings).toHaveLength(STATUS_KEYS.length - 1);
      // A purged sibling serves no address to anyone; every other one only with content.read.
      const live = photo.siblings.filter((s) => s.photoId !== w.byStatus.purged);
      expect(live.every((s) => (s.thumbUrl === null) === !canReadContent)).toBe(true);
      expect(photo.siblings.find((s) => s.photoId === w.byStatus.purged)?.thumbUrl).toBeNull();
    }
  });
});

describe('listPhotos joins by id, never by position', () => {
  test('a hidden photo between two visible ones: each result names its own attachment', async () => {
    const w = (await world()) as W;
    // Its own put-in, attached in the order visible, hidden, visible: a positional join would hand
    // the second visible photo the hidden one's attachment.
    const { putInId, rows } = await w.t.run(async (ctx) => {
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId: w.waterBodyId,
        coord: { lat: 0.4, lng: 0.4 },
        source: 'derived' as const,
        status: 'visible' as const,
        createdAt: T0,
      });
      const uploaderId = ((await ctx.db.get(w.byStatus.visible)) as Doc<'photos'>).uploaderId;
      const rows: Record<string, Id<'accessPhotos'>> = {};
      for (const status of ['visible', 'hidden', 'absent'] as const) {
        rows[status] = await ctx.db.insert('accessPhotos', {
          targetType: 'put_in' as const,
          putInId,
          photoId: w.byStatus[status],
          uploaderId,
          createdAt: T0,
        });
      }
      return { putInId, rows };
    });
    const got = await w.t.query(api.accessPoints.listPhotos, { targetType: 'put_in', putInId });
    expect(got.map((p) => p.caption)).toEqual(['visible', 'absent']);
    for (const p of got) {
      expect(p.accessPhotoId).toBe(rows[p.caption as string]);
      expect(p.photoId).toBe(w.byStatus[p.caption as Status]);
    }
  });
});

describe('recommended counts visible photos only', () => {
  test('a report that clears the bar on its listed photos but not its visible ones loses its card; the next wins', async () => {
    const { selectOnVisiblePhotos } = await import('./reports');
    const w = (await world()) as W;
    const make = (reportId: string, photoCount: number) => ({
      reportId,
      waterBodyId: w.waterBodyId as string,
      skateEndTime: T0 - 60_000,
      skateQuality: 'great' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      photoCount,
      corroborationCount: 9,
      authorTrust: 'expert' as const,
    });
    const picked = await w.t.run(async (ctx) => {
      // Two photos listed, one hidden: below the bar of two once counted.
      const mostlyDown = (await ctx.db.get(w.reportId)) as Doc<'reports'>;
      await ctx.db.patch(w.reportId, {
        photoIds: [w.byStatus.visible, w.byStatus.hidden],
      });
      const shown = await ctx.db.insert('reports', {
        ...(({ _id, _creationTime, ...rest }) => rest)(mostlyDown),
        photoIds: [w.byStatus.visible, w.byStatus.absent],
        skateEndTime: T0 - 120_000,
      });
      const byId = new Map<string, Doc<'reports'>>([
        [w.reportId, (await ctx.db.get(w.reportId)) as Doc<'reports'>],
        [shown, (await ctx.db.get(shown)) as Doc<'reports'>],
      ]);
      // The first ranks first on its listed count (more corroboration ties broken by photos).
      const candidates = [make(w.reportId, 2), make(shown, 2)];
      candidates[0] = { ...candidates[0], corroborationCount: 10 } as (typeof candidates)[0];
      return { cards: await selectOnVisiblePhotos(ctx, candidates, byId, T0), shown };
    });
    expect(picked.cards.flatMap((c) => c.reportIds)).toEqual([picked.shown]);
  });
});
