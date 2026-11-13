/**
 * The 30-day erasure (D248): what a person withdrew is erased 30 days on unless held — by a
 * moderator's standing verdict or an open flag — and a cleared hold erases at the later of the 30
 * days and the moment it cleared. The sweep reads only due rows; afterward the author's data export
 * holds none of the item's content, and everything that pointed at it still renders.
 */
import { WITHDRAWN_ERASE_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 24 * 60 * 60 * 1000;
/** Midday UTC, so no fixture sits near a date line in any zone. */
const T0 = Date.UTC(2027, 0, 14, 12);

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
};

type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
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
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const t = convexTest(schema, modules);
  const author = await seedUser(t, 'author');
  const other = await seedUser(t, 'other');
  const mod = await seedUser(t, 'mod', 'moderator');
  const waterBodyId = await seedBody(t);
  return { t, author, other, mod, waterBodyId };
}

/** A Post over `n` Reports by `authorId`, each with a note, a point and a photo. */
async function seedPost(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  n: number,
  words = 'thin by the inlet',
) {
  const now = Date.now();
  const reportIds: Id<'reports'>[] = [];
  const photoIds: Id<'photos'>[] = [];
  for (let i = 0; i < n; i++) {
    const photoId = await t.run(async (ctx) =>
      ctx.db.insert('photos', {
        storageId: await ctx.storage.store(new Blob([`full ${i}`])),
        thumbStorageId: await ctx.storage.store(new Blob([`thumb ${i}`])),
        uploaderId: authorId,
        caption: `the inlet ${i}`,
        coord: { lat: 0.4321 + i, lng: 0.8765 },
        placeOnMap: true,
        createdAt: now,
      }),
    );
    photoIds.push(photoId);
    const reportId = await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId,
        point: { lat: 0.4321 + i, lng: 0.8765 },
        skateEndTime: now,
        reportTime: now,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [photoId],
        notes: `${words} ${i}`,
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.run((ctx) => ctx.db.patch(photoId, { reportId }));
    reportIds.push(reportId);
  }
  const postId = await t.run((ctx) =>
    ctx.db.insert('posts', {
      authorId,
      reportIds,
      photoIds,
      title: 'Morey at dawn',
      body: 'go early',
      latestSkateEndTime: now,
      moderationStatus: 'visible',
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { postId }));
  await t.run((ctx) => ctx.db.patch(authorId, { reportCount: n }));
  return { postId, reportIds, photoIds };
}

async function seedHazard(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  originReportId?: Id<'reports'>,
) {
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'pressure_ridge' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
      createdByUserId: authorId,
      description: 'north bay ridge',
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: Date.now(),
      lastConfirmedAt: Date.now(),
      confirmCount: 0,
      goneCount: 0,
      ...(originReportId !== undefined ? { originReportId } : {}),
      createdAt: Date.now(),
    }),
  );
}

const sweep = (t: T) => t.mutation(internal.erasure.eraseDue, {});
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const get = (t: T, id: string) =>
  t.run((ctx) => ctx.db.get(id as never)) as Promise<Record<string, unknown> | null>;
async function historyOn(t: T, targetId: string) {
  return (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
    (r) => r.targetId === targetId,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the clock', () => {
  test("starts at the author's deletion and runs 30 days", async () => {
    const { t, author, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'hi' });
    await author.as.mutation(api.comments.remove, { commentId });
    expect((await get(t, commentId))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
    advance(WITHDRAWN_ERASE_MS - 1000);
    await sweep(t);
    expect(await get(t, commentId)).not.toBeNull();
    advance(1000);
    await sweep(t);
    expect(await get(t, commentId)).toBeNull();
  });

  test('stops while a verdict stands, and an overturn after 30 days erases from that moment', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'rude' });
    await author.as.mutation(api.comments.remove, { commentId });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'comment',
      targetId: commentId,
      status: 'hidden',
      reason: 'harassment, after the fact',
    });
    expect((await get(t, commentId))?.eraseAt).toBeUndefined();
    advance(45 * DAY);
    await sweep(t);
    expect(await get(t, commentId)).not.toBeNull(); // evidence kept
    const overturnedAt = Date.now();
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'comment',
      targetId: commentId,
      reason: 'appeal upheld',
    });
    expect((await get(t, commentId))?.eraseAt).toBe(overturnedAt);
    await sweep(t);
    expect(await get(t, commentId)).toBeNull();
  });

  test('stops while a flag is open; a hold that clears early still waits out the 30 days', async () => {
    const { t, author, other, mod, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'rude' });
    const flagId = await other.as.mutation(api.contentFlags.flag, {
      targetType: 'comment',
      targetId: commentId,
      reason: 'harassment',
    });
    await author.as.mutation(api.comments.remove, { commentId });
    expect((await get(t, commentId))?.eraseAt).toBeUndefined();
    advance(3 * DAY);
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'dismissed',
      reason: 'not harassment',
    });
    expect((await get(t, commentId))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
  });

  test('the sweep re-reads the hold, and leaves a held row it finds in its range', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'x' });
    await author.as.mutation(api.comments.remove, { commentId });
    // A flag that reached the table without moving the clock (a write path that forgot).
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: other.id,
        targetType: 'comment',
        targetId: commentId,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        createdAt: Date.now(),
      }),
    );
    advance(31 * DAY);
    const result = await sweep(t);
    expect(result.held).toBe(1);
    expect(await get(t, commentId)).not.toBeNull();
    expect((await get(t, commentId))?.eraseAt).toBeUndefined();
  });

  test('pages, and continues itself while a page comes back full', async () => {
    const { t, author, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const ids: Id<'comments'>[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await author.as.mutation(api.comments.create, { reportId, body: `c${i}` });
      await author.as.mutation(api.comments.remove, { commentId: id });
      ids.push(id);
    }
    advance(31 * DAY);
    const first = await t.mutation(internal.erasure.eraseDue, { pageSize: 2 });
    expect(first.more).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of ids) expect(await get(t, id)).toBeNull();
    const history = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (r) => r.action === 'erase',
    );
    // One entry per erasure, with no actor and none of the content.
    expect(history).toHaveLength(5);
    for (const row of history) {
      expect(row.actorId).toBeUndefined();
      expect(row.metadata).toBeUndefined();
      expect(row.reason).not.toMatch(/c\d/);
    }
  });
});

describe('a comment', () => {
  test('with replies leaves an empty placeholder the replies hang from; without, it is gone', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const parent = await author.as.mutation(api.comments.create, { reportId, body: 'mean words' });
    const reply = await other.as.mutation(api.comments.create, {
      reportId,
      parentCommentId: parent,
      body: 'that was uncalled for',
    });
    await author.as.mutation(api.comments.remove, { commentId: parent });
    advance(31 * DAY);
    await sweep(t);
    const shell = await get(t, parent);
    expect(shell).toMatchObject({ body: '', moderationStatus: 'removed' });
    expect(shell?.erasedAt).toBeDefined();
    const thread = await t.query(api.comments.listByReport, { reportId });
    expect(thread).toEqual([
      expect.objectContaining({
        id: parent,
        hidden: true,
        comment: null,
        replies: [expect.objectContaining({ id: reply })],
      }),
    ]);
    // Nothing a moderator does reaches it; nobody can report it.
    await expect(
      t.withIdentity({ subject: 'mod' }).mutation(api.moderation.setModerationStatus, {
        targetType: 'comment',
        targetId: parent,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow(/erased/);
    await expect(
      other.as.mutation(api.contentFlags.flag, {
        targetType: 'comment',
        targetId: parent,
        reason: 'spam',
      }),
    ).rejects.toThrow(/not found/);
    // And nobody answers it.
    await expect(
      other.as.mutation(api.comments.create, { reportId, parentCommentId: parent, body: 'what?' }),
    ).rejects.toThrow(/not found/);
    // The author's export holds none of it.
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(JSON.stringify(bundle)).not.toContain('mean words');
    expect(bundle.comments.map((c) => c._id)).not.toContain(parent);

    // The reply's own author deletes it, and 30 days on the placeholder has nothing left to hold.
    await other.as.mutation(api.comments.remove, { commentId: reply });
    advance(31 * DAY);
    await sweep(t);
    expect(await get(t, reply)).toBeNull();
    expect(await get(t, parent)).toBeNull();
  });
});

describe('a report', () => {
  test('is erased with its words, photos, revisions and joins; its hazard and recording stay', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const { postId, reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 2);
    const [gone, kept] = reportIds as [Id<'reports'>, Id<'reports'>];
    const hazardId = await seedHazard(t, author.id, waterBodyId, gone);
    const activityId = await t.run((ctx) =>
      ctx.db.insert('gpsActivities', {
        userId: author.id,
        provider: 'native' as const,
        providerActivityId: 'session-1',
        sportType: 'IceSkate',
        startTime: T0 - 3600_000,
        detectedAt: T0,
        promptState: 'converted' as const,
        linkedReportId: gone,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(gone, { hazardIdsCreated: [hazardId], activityId });
      await ctx.db.insert('contentRevisions', {
        targetType: 'report',
        targetId: gone,
        authorId: author.id,
        snapshot: { notes: 'the first draft of it' },
        replacedAt: T0,
      });
      await ctx.db.insert('pointEvents', {
        userId: author.id,
        delta: 5,
        reason: 'report_submitted',
        refId: gone,
        createdAt: T0,
      });
    });
    // Someone else's comment, rating and vote on what hangs off it.
    const theirs = await other.as.mutation(api.comments.create, {
      reportId: gone,
      body: 'thanks for this',
    });
    await t.run((ctx) =>
      ctx.db.insert('hazardConfirmations', {
        hazardId,
        userId: other.id,
        verdict: 'still_there' as const,
        via: 'app_open_nearby' as const,
        createdAt: T0,
      }),
    );

    // A put-in the pre-D62 purge materialized from this Report's point.
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.4321, lng: 0.8765 },
        source: 'derived' as const,
        originReportId: gone,
        status: 'visible' as const,
        createdAt: T0,
      }),
    );

    await author.as.mutation(api.reports.remove, { reportId: gone });
    advance(31 * DAY);
    const result = await sweep(t);
    expect(result.erased.report).toBe(1);
    // The put-in stays on the community record, without its pointer to the Report.
    const putIn = await get(t, putInId);
    expect(putIn).toMatchObject({ coord: { lat: 0.4321, lng: 0.8765 }, status: 'visible' });
    expect(putIn?.originReportId).toBeUndefined();

    expect(await get(t, gone)).toBeNull();
    expect(await get(t, photoIds[0] as string)).toBeNull();
    expect(await get(t, photoIds[1] as string)).not.toBeNull();
    // The hazard stays exactly as it was, unlinked: still active, still visible, still confirmed.
    const hazard = await get(t, hazardId);
    expect(hazard).toMatchObject({ status: 'active', moderationStatus: 'visible' });
    expect(hazard?.originReportId).toBeUndefined();
    expect(await t.query(api.hazards.get, { hazardId })).not.toBeNull();
    // The recording is the author's private recording again: unlinked, and not prompted for.
    expect(await get(t, activityId)).toMatchObject({ promptState: 'dismissed' });
    expect((await get(t, activityId))?.linkedReportId).toBeUndefined();
    // The Post shows on with its other Report.
    expect(await get(t, postId)).toMatchObject({
      reportIds: [kept],
      photoIds: [photoIds[1]],
      moderationStatus: 'visible',
    });
    // Other people's comment stays theirs; the thread under a Report that is gone is just empty.
    expect(await get(t, theirs)).not.toBeNull();
    expect(await t.query(api.comments.listByReport, { reportId: gone })).toEqual([]);

    // The export holds none of the Report's content: words, revisions, photo keys, coordinates.
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('thin by the inlet 0');
    expect(text).not.toContain('the first draft of it');
    expect(text).not.toContain('the inlet 0');
    expect(text).not.toContain('0.4321');
    expect(bundle.reports.map((r) => r._id)).toEqual([kept]);
    expect(bundle.contentRevisions).toEqual([]);
    // Point events stay, and hold nothing of it but its id.
    expect(bundle.pointEvents).toEqual([
      expect.objectContaining({ delta: 5, reason: 'report_submitted', refId: gone }),
    ]);
    expect(Object.keys(bundle.pointEvents[0] ?? {}).sort()).toEqual(
      ['_creationTime', '_id', 'createdAt', 'delta', 'reason', 'refId', 'userId'].sort(),
    );
  });

  test("one tick's erasures of one author settle their photos together, against what still stands", async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 3);
    const [a, b, stays] = reportIds as [Id<'reports'>, Id<'reports'>, Id<'reports'>];
    const [shared, own] = photoIds as [Id<'photos'>, Id<'photos'>];
    // The Report that stays carries the first one's photo too.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(stays);
      await ctx.db.patch(stays, { photoIds: [...(row?.photoIds ?? []), shared] });
    });
    await author.as.mutation(api.reports.remove, { reportId: a });
    await author.as.mutation(api.reports.remove, { reportId: b });
    advance(31 * DAY);
    const result = await sweep(t);
    expect(result.erased.report).toBe(2);
    expect(await get(t, a)).toBeNull();
    expect(await get(t, b)).toBeNull();
    // Only the erased Reports held this one: it goes with them.
    expect(await get(t, own)).toBeNull();
    // Still on a standing Report: kept, and no longer pointing at the erased one.
    const kept = await get(t, shared);
    expect(kept).not.toBeNull();
    expect(kept?.reportId).toBeUndefined();
    expect(kept?.caption).toBe('the inlet 0');
  });

  test('a verdict on its Post holds the Report as evidence; the Post goes after its last Report', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 1, 'a slur');
    const [reportId] = reportIds as [Id<'reports'>];
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'a slur in the notes',
    });
    await author.as.mutation(api.reports.remove, { reportId });
    expect((await get(t, reportId))?.eraseAt).toBeUndefined();
    advance(31 * DAY);
    await sweep(t);
    // The Post's verdict judged what the Post showed — this Report's words among them.
    expect(await get(t, reportId)).toMatchObject({ notes: 'a slur 0' });
    expect(await get(t, postId)).toMatchObject({ title: 'Morey at dawn' });
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'post',
      targetId: postId,
      reason: 'on appeal',
    });
    expect((await get(t, reportId))?.eraseAt).toBe(Date.now());
    await sweep(t);
    expect(await get(t, reportId)).toBeNull();
    expect(await get(t, postId)).toBeNull();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(JSON.stringify(bundle)).not.toContain('Morey at dawn');
    expect(JSON.stringify(bundle)).not.toContain('a slur');
  });

  test('a Post its author deleted waits for every member, and every member for its own hold', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 2);
    const [a, b] = reportIds as [Id<'reports'>, Id<'reports'>];
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: b,
      status: 'removed',
      reason: 'a doxxing note',
    });
    await author.as.mutation(api.posts.remove, { postId });
    advance(31 * DAY);
    await sweep(t);
    expect(await get(t, a)).toBeNull();
    expect(await get(t, b)).not.toBeNull();
    expect(await get(t, postId)).not.toBeNull();
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'report',
      targetId: b,
      reason: 'resolved',
    });
    await sweep(t);
    expect(await get(t, b)).toBeNull();
    expect(await get(t, postId)).toBeNull();
    const erased = (await historyOn(t, postId)).filter((r) => r.action === 'erase');
    expect(erased).toHaveLength(1);
  });
});

describe('what the sweep never erases', () => {
  test('content not withdrawn, and an access alert (its eraser waits on a call)', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds } = await seedPost(t, author.id, waterBodyId, 1);
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    const alertId = await t.run((ctx) =>
      ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        putInId,
        waterBodyId,
        reason: 'not_plowed' as const,
        kind: 'blocker' as const,
        createdByUserId: author.id,
        createdAt: T0,
        season: 2026,
        status: 'retracted' as const,
        retractedByUserId: author.id,
        retractedAt: T0,
        eraseAt: T0 + WITHDRAWN_ERASE_MS,
        confirmCount: 0,
        denyCount: 0,
      }),
    );
    // A clock on a row nobody withdrew (a stale write) is cleared, never acted on.
    await t.run((ctx) => ctx.db.patch(reportIds[0] as Id<'reports'>, { eraseAt: T0 }));
    advance(31 * DAY);
    const result = await sweep(t);
    expect(result.erased).toEqual({});
    expect(await get(t, reportIds[0] as string)).not.toBeNull();
    expect((await get(t, reportIds[0] as string))?.eraseAt).toBeUndefined();
    expect(await get(t, alertId)).not.toBeNull();
  });
});

describe('the clocks backfill', () => {
  test('gives every withdrawn row its clock, kind by kind across pages, and leaves held rows', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const { reportIds } = await seedPost(t, author.id, waterBodyId, 3);
    const [plain, flagged, up] = reportIds as [Id<'reports'>, Id<'reports'>, Id<'reports'>];
    await t.run(async (ctx) => {
      await ctx.db.patch(plain, { moderationStatus: 'removed', authorDeletedAt: T0 - 40 * DAY });
      await ctx.db.patch(flagged, { moderationStatus: 'removed', authorDeletedAt: T0 });
      await ctx.db.insert('contentFlags', {
        flaggerId: other.id,
        targetType: 'report',
        targetId: flagged,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        createdAt: T0,
      });
    });
    await t.mutation(internal.erasure.backfillClocks, { pageSize: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Its 30 days ran out before the clock existed: due now, not 30 days from the backfill.
    expect((await get(t, plain))?.eraseAt).toBe(T0);
    expect((await get(t, flagged))?.eraseAt).toBeUndefined();
    expect((await get(t, up))?.eraseAt).toBeUndefined();
  });
});
