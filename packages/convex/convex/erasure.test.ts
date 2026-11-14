/**
 * The 30-day erasure (D248): what a person withdrew is erased 30 days on unless held — by a
 * moderator's standing verdict or an open flag — and a cleared hold erases at the later of the 30
 * days and the moment it cleared. The sweep reads only due rows; afterward the author's data export
 * holds none of the item's content, and everything that pointed at it still renders.
 */
import { POST_BODY_MAX_CHARS, POST_TITLE_MAX_CHARS, WITHDRAWN_ERASE_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { DAILY_RETRIES, ERASED_KINDS, MAX_SETTLE_ATTEMPTS, PASS_NEED, ROW_MAX } from './erasure';
import * as audit from './lib/audit';
import * as eraseClock from './lib/eraseClock';
import { MAX_ERASE_ATTEMPTS } from './lib/eraseClock';
import * as photoOrphans from './lib/photoOrphans';
import { TX_BUDGET } from './lib/readBudget';
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

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
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
  // Convex's real per-transaction limits, enforced: what passes here fits a deployment.
  const t = convexTest({ schema, modules, transactionLimits: true });
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

/** One sweep, then whatever it scheduled (its continuation, the photo settlement). */
const sweep = async (t: T) => {
  const result = await t.mutation(internal.erasure.eraseDue, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return result;
};
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const get = (t: T, id: string) =>
  t.run((ctx) => ctx.db.get(id as never)) as Promise<Record<string, unknown> | null>;
/** How many items of a kind the sweep erased, across every pass it took. */
async function erasedCount(t: T, kind: string) {
  return (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
    (r) => r.action === 'erase' && r.targetType === kind,
  ).length;
}
/**
 * A debt of these photos on record for the uploader, and their place in the settlement queue — as
 * an erasure leaves them, or, with `phase`, part-way through a settlement that took this debt on.
 */
async function oweOnRecord(
  t: T,
  uploaderId: Id<'profiles'>,
  photoIds: Id<'photos'>[],
  opts: { phase?: 'reports' | 'hazards' | 'clear'; owedAt?: number; queuedAt?: number } = {},
) {
  return t.run(async (raw) => {
    const ctx = raw as unknown as MutationCtx;
    const debt = await ctx.db.insert('photoSettlements', {
      uploaderId,
      photoIds,
      owedAt: opts.owedAt ?? Date.now(),
    });
    const place = await ctx.db
      .query('photoSettlementQueue')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
      .first();
    if (!place) {
      await ctx.db.insert('photoSettlementQueue', {
        uploaderId,
        queuedAt: opts.queuedAt ?? opts.owedAt ?? Date.now(),
        phase: opts.phase ?? 'take',
        ...(opts.phase !== undefined
          ? { photoIds: opts.phase === 'clear' ? [] : photoIds, owed: [debt] }
          : {}),
      });
    }
    return debt;
  });
}
/** One step of the uploader's settlement, as the walk runs it. */
const step = (t: T, uploaderId: Id<'profiles'>, pageSize?: number) =>
  t.mutation(internal.erasure.settleStep, {
    uploaderId,
    bytes: TX_BUDGET,
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
/** Everything owed settled: the walk, run to its end. */
async function settleAll(t: T) {
  await t.mutation(internal.erasure.settleOwed, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
}
const placeOf = (t: T, uploaderId: Id<'profiles'>) =>
  t.run((raw) =>
    (raw as unknown as MutationCtx).db
      .query('photoSettlementQueue')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', uploaderId))
      .first(),
  );
async function historyOn(t: T, targetId: string) {
  return (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
    (r) => r.targetId === targetId,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('one item that always fails', () => {
  test('at the front of the due range, it never holds up what is due behind it', async () => {
    const { t, author, waterBodyId } = await setup();
    const admin = await seedUser(t, 'admin', 'admin');
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const ids: Id<'comments'>[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await author.as.mutation(api.comments.create, { reportId, body: `c${i}` });
      await author.as.mutation(api.comments.remove, { commentId: id });
      ids.push(id);
      advance(1000);
    }
    // The first deleted is the first due: the head of the range, and its erasure always throws.
    const [poison, ...healthy] = ids as [Id<'comments'>, ...Id<'comments'>[]];
    const real = audit.writeAudit;
    vi.spyOn(audit, 'writeAudit').mockImplementation(async (ctx, entry) => {
      if (entry.action === 'erase' && entry.targetId === poison) throw new Error('poison');
      return real(ctx, entry);
    });
    advance(31 * DAY);
    // The first run: everything behind it erased, and it tried once, not parked yet.
    const first = await t.mutation(internal.erasure.eraseDue, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(first.failed).toBe(1);
    for (const id of healthy) expect(await get(t, id)).toBeNull();
    expect(await get(t, poison)).toMatchObject({ eraseAttempts: 1 });
    // One attempt a run: two more runs, and it is parked, untouched.
    for (let run = 0; run < 2; run++) {
      advance(60 * 60 * 1000);
      await sweep(t);
    }
    expect(await get(t, poison)).toMatchObject({
      body: 'c0',
      eraseAttempts: MAX_ERASE_ATTEMPTS,
      eraseErrorClass: 'Error',
      eraseParkedAt: expect.any(Number),
    });
    expect((await get(t, poison))?.eraseAt).toBeUndefined();
    // Not tried again once parked: a later run leaves it be, and a hold moving doesn't re-queue it.
    advance(60 * 60 * 1000);
    await sweep(t);
    expect((await get(t, poison))?.eraseAttempts).toBe(MAX_ERASE_ATTEMPTS);
    const report = await admin.as.query(api.erasure.parked, {});
    expect(report.items).toEqual([
      expect.objectContaining({ kind: 'comment', id: poison, attempts: 3, errorClass: 'Error' }),
    ]);
    // Released by an operator once fixed: erased on the next run.
    vi.restoreAllMocks();
    await t.mutation(internal.erasure.retryParked, {});
    await sweep(t);
    expect(await get(t, poison)).toBeNull();
  });

  /** Withdrawn heavy items of every kind with a hold to read, parked as three failures leave them. */
  async function parkHeavy(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
    const parked: string[] = [];
    const { reportIds } = await seedPost(t, authorId, waterBodyId, 4);
    for (let i = 0; i < 4; i++) parked.push(await seedHazard(t, authorId, waterBodyId));
    parked.push(...reportIds);
    await t.run(async (ctx) => {
      for (const id of parked) {
        await ctx.db.patch(id as Id<'reports'>, {
          authorDeletedAt: Date.now(),
          eraseAttempts: MAX_ERASE_ATTEMPTS,
          eraseErrorClass: 'Error',
          eraseParkedAt: Date.now(),
        });
      }
    });
    return parked;
  }

  /** `n` uploaders whose settlements are parked. */
  async function parkSettlements(t: T, n: number) {
    const uploaders: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      const { id } = await seedUser(t, `uploader${i}`);
      uploaders.push(id);
      await t.run((ctx) =>
        ctx.db.insert('photoSettlementQueue', {
          uploaderId: id,
          queuedAt: Date.now(),
          phase: 'take',
          attempts: MAX_SETTLE_ATTEMPTS,
          lastErrorClass: 'Error',
          parkedAt: Date.now(),
        }),
      );
    }
    return uploaders;
  }

  test('a retry releases every parked item, however many and however heavy, a budget at a time', async () => {
    const { t, author, waterBodyId } = await setup();
    const parked = await parkHeavy(t, author.id, waterBodyId);
    const uploaders = await parkSettlements(t, 60);
    let released = 0;
    let calls = 0;
    for (; calls < 20; calls++) {
      const result = await t.mutation(internal.erasure.retryParked, {});
      released += result.items;
      if (!result.more) break;
    }
    expect(calls).toBeLessThan(20);
    expect(released).toBe(parked.length);
    for (const id of parked) {
      const row = await get(t, id);
      expect(row?.eraseParkedAt).toBeUndefined();
      expect(row?.eraseAttempts).toBeUndefined();
      expect(row?.eraseAt).toEqual(expect.any(Number));
    }
    for (const id of uploaders) {
      const place = await placeOf(t, id);
      expect(place?.parkedAt).toBeUndefined();
      expect(place?.attempts).toBeUndefined();
    }
  });

  test('the parked read fits its budget with every heavy kind parked, and says when it shows only some', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const admin = await seedUser(t, 'admin', 'admin');
    await parkHeavy(t, author.id, waterBodyId);
    await parkSettlements(t, 60);
    // Parked Posts and flags too: four heavy kinds past what one read can list in full.
    const { postId } = await seedPost(t, other.id, waterBodyId, 1);
    const { postId: second } = await seedPost(t, other.id, waterBodyId, 1);
    await t.run(async (ctx) => {
      for (const id of [postId, second]) {
        await ctx.db.patch(id, { eraseAttempts: 3, eraseParkedAt: Date.now() });
      }
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('contentFlags', {
          flaggerId: other.id,
          targetType: 'post',
          targetId: postId,
          reason: 'spam',
          status: 'retracted',
          retractedAt: Date.now(),
          origin: 'user',
          createdAt: Date.now(),
          eraseAttempts: 3,
          eraseParkedAt: Date.now(),
        });
      }
    });
    const report = await admin.as.query(api.erasure.parked, {});
    expect(report.settlements).toHaveLength(50);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.capped).toBe(true);
  });
});

describe('failures far apart', () => {
  test('fail, partial success, fail, partial success, fail: never parked (Greptile #110)', async () => {
    const { t, author, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [reportId] = reportIds as [Id<'reports'>];
    // Far more revisions than a pass erases at the page seam: each successful pass drains some.
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert('contentRevisions', {
          targetType: 'report',
          targetId: reportId,
          authorId: author.id,
          snapshot: { notes: `draft ${i}` },
          replacedAt: T0 + i,
        });
      }
    });
    await author.as.mutation(api.posts.remove, { postId });
    advance(31 * DAY);
    // Each hourly run takes the item once: it fails, then drains part of what it carries, in turn.
    const outcomes = ['fail', 'progress', 'fail', 'progress', 'fail'] as const;
    const real = eraseClock.refreshClockOf;
    let failNext = false;
    vi.spyOn(eraseClock, 'refreshClockOf').mockImplementation(async (...args) => {
      if (failNext) throw new Error('flaky');
      return real(...args);
    });
    for (const outcome of outcomes) {
      failNext = outcome === 'fail';
      await t.mutation(internal.erasure.eraseDue, { pageSize: 1 });
      await t.run(async (ctx) => {
        for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
          if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id);
        }
      });
      advance(60 * 60 * 1000);
    }
    const row = await get(t, reportId);
    expect(row).not.toBeNull();
    expect(row?.eraseParkedAt).toBeUndefined();
    expect(row?.eraseAttempts).toBe(1);
    // And three failures with no progress between them do park it.
    failNext = true;
    for (let run = 0; run < 2; run++) {
      await t.mutation(internal.erasure.eraseDue, { pageSize: 1 });
      advance(60 * 60 * 1000);
    }
    expect(await get(t, reportId)).toMatchObject({
      eraseAttempts: 3,
      eraseParkedAt: expect.any(Number),
    });
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

    const proposal = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark' as const,
        status: 'open' as const,
        requesterId: author.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId,
        name: 'Long Point',
        reportId: gone,
        createdAt: T0,
      }),
    );

    await author.as.mutation(api.reports.remove, { reportId: gone });
    advance(31 * DAY);
    await sweep(t);
    expect(await erasedCount(t, 'report')).toBe(1);
    // The landmark proposal it filed stays the author's request, without its pointer.
    expect(await get(t, proposal)).toMatchObject({ name: 'Long Point', status: 'open' });
    expect((await get(t, proposal))?.reportId).toBeUndefined();
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
    await sweep(t);
    expect(await erasedCount(t, 'report')).toBe(2);
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
    // The Post's members follow its hold in a job of their own.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
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
  test("content not withdrawn, and an alert a moderator retracted (their decision, not the author's)", async () => {
    const { t, author, mod, waterBodyId } = await setup();
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
        retractedByUserId: mod.id,
        retractedAt: T0,
        // A stale clock: a moderator's retraction never sets one.
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
    expect((await get(t, alertId))?.eraseAt).toBeUndefined();
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

describe('nothing of an item outlives its erasure, however much it carries', () => {
  test('a Report and its Post with more revisions than a pass erase over several passes, never stranding one', async () => {
    const { t, author, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [reportId] = reportIds as [Id<'reports'>];
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert('contentRevisions', {
          targetType: 'report',
          targetId: reportId,
          authorId: author.id,
          snapshot: { notes: `draft ${i} of the report` },
          replacedAt: T0 + i,
        });
        await ctx.db.insert('contentRevisions', {
          targetType: 'post',
          targetId: postId,
          authorId: author.id,
          snapshot: { body: `draft ${i} of the post` },
          replacedAt: T0 + i,
        });
      }
    });
    await author.as.mutation(api.posts.remove, { postId });
    advance(31 * DAY);
    // One row a page, twenty writes a pass: the first pass gets part-way and stops.
    const first = await t.mutation(internal.erasure.eraseDue, { pageSize: 1 });
    expect(first.more).toBe(true);
    // Part-way, the Report is whole and still due: its revisions are never left behind a row that
    // is gone.
    expect(await get(t, reportId)).not.toBeNull();
    expect((await get(t, reportId))?.eraseAt).toBeLessThanOrEqual(Date.now());
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await get(t, reportId)).toBeNull();
    expect(await get(t, postId)).toBeNull();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(bundle.contentRevisions).toEqual([]);
    expect(JSON.stringify(bundle)).not.toContain('draft');
    // One history row each, written only when the item was really gone.
    const erased = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (r) => r.action === 'erase',
    );
    expect(erased.map((r) => r.targetId).sort()).toEqual([postId, reportId].sort());
  });

  test("a Report's links and an item's own votes, more than a pass can write, go over several passes", async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds } = await seedPost(t, author.id, waterBodyId, 2);
    const [reportId] = reportIds as [Id<'reports'>];
    const hazardId = await seedHazard(t, author.id, waterBodyId);
    const linked = await t.run(async (ctx) => {
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: T0,
      });
      const alert = {
        targetType: 'put_in' as const,
        putInId,
        waterBodyId,
        reason: 'not_plowed' as const,
        kind: 'blocker' as const,
        createdByUserId: author.id,
        createdAt: T0,
        season: 2026,
        confirmCount: 0,
        denyCount: 0,
      };
      const alerts: Id<'accessAlerts'>[] = [];
      const requests: Id<'waterBodyRequests'>[] = [];
      const putIns: Id<'putIns'>[] = [];
      for (let i = 0; i < 25; i++) {
        alerts.push(
          await ctx.db.insert('accessAlerts', {
            ...alert,
            status: 'active' as const,
            expiresAt: T0 + 365 * DAY,
            reportId,
          }),
        );
        requests.push(
          await ctx.db.insert('waterBodyRequests', {
            kind: 'name_landmark' as const,
            status: 'open' as const,
            requesterId: author.id,
            coord: { lat: 0.5, lng: 0.5 },
            waterBodyId,
            name: `Point ${i}`,
            reportId,
            createdAt: T0,
          }),
        );
        putIns.push(
          await ctx.db.insert('putIns', {
            waterBodyId,
            coord: { lat: 0.5, lng: 0.5 },
            source: 'derived' as const,
            originReportId: reportId,
            status: 'visible' as const,
            createdAt: T0,
          }),
        );
        // Older rows can hold more than one of a person's votes on one item.
        await ctx.db.insert('hazardConfirmations', {
          hazardId,
          userId: author.id,
          verdict: 'still_there' as const,
          via: 'app_open_nearby' as const,
          createdAt: T0 + i,
        });
      }
      const retracted = await ctx.db.insert('accessAlerts', {
        ...alert,
        status: 'retracted' as const,
        retractedByUserId: author.id,
        retractedAt: T0,
        eraseAt: T0 + WITHDRAWN_ERASE_MS,
      });
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert('accessAlertVotes', {
          accessAlertId: retracted,
          userId: author.id,
          verdict: 'still_blocked' as const,
          observedAt: T0 + i,
          createdAt: T0 + i,
        });
      }
      // Withdrawn by its author, as the withdrawal leaves it.
      await ctx.db.patch(hazardId, {
        moderationStatus: 'removed',
        authorDeletedAt: T0,
        eraseAt: T0 + WITHDRAWN_ERASE_MS,
      });
      return { alerts, requests, putIns, retracted };
    });
    await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    // Twenty writes a pass: every drain runs out part-way at least once.
    const first = await t.mutation(internal.erasure.eraseDue, { pageSize: 1 });
    expect(first.more).toBe(true);
    expect(await get(t, hazardId)).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await get(t, reportId)).toBeNull();
    expect(await get(t, hazardId)).toBeNull();
    expect(await get(t, linked.retracted)).toBeNull();
    // What has its own life stays, without its pointer to the Report.
    for (const id of [...linked.alerts, ...linked.requests]) {
      const row = await get(t, id);
      expect(row).not.toBeNull();
      expect(row?.reportId).toBeUndefined();
    }
    for (const id of linked.putIns) {
      const row = await get(t, id);
      expect(row).not.toBeNull();
      expect(row?.originReportId).toBeUndefined();
    }
    expect(await t.run((ctx) => ctx.db.query('hazardConfirmations').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('accessAlertVotes').collect())).toEqual([]);
    const erased = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (r) => r.action === 'erase',
    );
    expect(erased.map((r) => r.targetId).sort()).toEqual(
      [reportId, hazardId, linked.retracted].sort(),
    );
  });

  test("a photo whose blob outlives the delete is no longer the uploader's", async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 2);
    const [reportId] = reportIds as [Id<'reports'>];
    const [photoId] = photoIds as [Id<'photos'>];
    // A storage id the store can't answer for: the blob's delete fails, so the row must stay.
    await t.run((ctx) => ctx.db.patch(photoId, { storageId: 'not-a-storage-id' }));
    await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    await sweep(t);
    const kept = await get(t, photoId);
    expect(kept).not.toBeNull();
    expect(kept?.erasedAt).toBeDefined();
    expect(kept?.caption).toBeUndefined();
    expect(kept?.coord).toBeUndefined();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(bundle.photos.map((p) => p.photoId)).toEqual([photoIds[1]]);
  });
});

describe('what was withdrawn before the clock existed', () => {
  test('every withdrawable kind gets its clock from the backfill and is erased when due', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [reportId] = reportIds as [Id<'reports'>];
    const hazardId = await seedHazard(t, author.id, waterBodyId);
    const ids = await t.run(async (ctx) => {
      // As the Part A stamp backfill leaves them: withdrawn, with a time, and no clock.
      await ctx.db.patch(reportId, { moderationStatus: 'removed', authorDeletedAt: T0 });
      await ctx.db.patch(postId, { moderationStatus: 'removed', authorDeletedAt: T0 });
      await ctx.db.patch(hazardId, { moderationStatus: 'removed', authorDeletedAt: T0 });
      const commentId = await ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'an old deleted comment',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        authorDeletedAt: T0,
        createdAt: T0,
      });
      const flagId = await ctx.db.insert('contentFlags', {
        flaggerId: author.id,
        targetType: 'waterbody',
        targetId: waterBodyId,
        reason: 'no_public_access',
        note: 'an old withdrawn report',
        status: 'retracted',
        origin: 'user',
        retractedAt: T0,
        createdAt: T0,
      });
      const requestId = await ctx.db.insert('waterBodyRequests', {
        kind: 'activate',
        status: 'retracted',
        requesterId: author.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId,
        note: 'an old withdrawn ask',
        retractedAt: T0,
        createdAt: T0,
      });
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: T0,
      });
      // The old writer: a status and who retracted it, no time.
      const alertId = await ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        putInId,
        waterBodyId,
        reason: 'not_plowed' as const,
        kind: 'blocker' as const,
        note: 'an old retracted alert',
        createdByUserId: author.id,
        createdAt: T0,
        season: 2026,
        status: 'retracted' as const,
        retractedByUserId: author.id,
        confirmCount: 0,
        denyCount: 0,
      });
      // A moderator's old retraction is not a withdrawal: it gets no time and no clock.
      const theirs = await ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        putInId,
        waterBodyId,
        reason: 'not_plowed' as const,
        kind: 'blocker' as const,
        createdByUserId: other.id,
        createdAt: T0,
        season: 2026,
        status: 'retracted' as const,
        retractedByUserId: author.id,
        confirmCount: 0,
        denyCount: 0,
      });
      return { commentId, flagId, requestId, alertId, theirs };
    });
    advance(10 * DAY);
    const backfillAt = Date.now();
    await t.mutation(internal.erasure.backfillClocks, { pageSize: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of [reportId, hazardId, ids.commentId, ids.flagId, ids.requestId]) {
      expect((await get(t, id))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
    }
    // The Post waits for its Report; the old alert's 30 days start at the backfill.
    expect((await get(t, postId))?.eraseAt).toBeUndefined();
    expect(await get(t, ids.alertId)).toMatchObject({
      retractedAt: backfillAt,
      eraseAt: backfillAt + WITHDRAWN_ERASE_MS,
    });
    expect((await get(t, ids.theirs))?.retractedAt).toBeUndefined();
    expect((await get(t, ids.theirs))?.eraseAt).toBeUndefined();

    advance(31 * DAY);
    await sweep(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of [reportId, postId, hazardId, ids.commentId, ids.flagId, ids.requestId]) {
      expect(await get(t, id)).toBeNull();
    }
    expect(await get(t, ids.alertId)).toBeNull();
    expect(await get(t, ids.theirs)).not.toBeNull();
    const text = JSON.stringify(await t.query(internal.dataExport.collect, { userId: author.id }));
    for (const words of [
      'an old deleted comment',
      'an old withdrawn report',
      'an old withdrawn ask',
      'an old retracted alert',
      'north bay ridge',
    ]) {
      expect(text).not.toContain(words);
    }
  });
});

/** Convex's limits: what one transaction may read, and what one document may weigh. */
const READ_LIMIT = 16 * (1 << 20);

describe('a pass is sized by what its rows can weigh', () => {
  test('heavy revisions erase over several passes, and no pass can read past the limit', async () => {
    const { t, author, waterBodyId } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [reportId] = reportIds as [Id<'reports'>];
    // Report notes have no cap but the document limit, so a revision may weigh almost that much.
    const heavy = 'x'.repeat(900 * 1024);
    const REVISIONS = 20;
    for (let i = 0; i < REVISIONS; i++) {
      await t.run((ctx) =>
        ctx.db.insert('contentRevisions', {
          targetType: 'report',
          targetId: reportId,
          authorId: author.id,
          snapshot: { notes: `${i} ${heavy}` },
          replacedAt: T0 + i,
        }),
      );
    }
    await t.run(async (ctx) => {
      // And Post prose at its cap, many times over.
      const full = 'y'.repeat(POST_BODY_MAX_CHARS);
      const title = 't'.repeat(POST_TITLE_MAX_CHARS);
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert('contentRevisions', {
          targetType: 'post',
          targetId: postId,
          authorId: author.id,
          snapshot: { title, body: `${i} ${full}` },
          replacedAt: T0 + i,
        });
      }
    });
    await author.as.mutation(api.posts.remove, { postId });
    advance(31 * DAY);
    // Counted a few rows a transaction: the test's own reads are under the limit too.
    const revisionsLeft = async () => {
      let count = 0;
      for (let cursor: string | null = null; ; ) {
        const page = await t.run((ctx) =>
          ctx.db.query('contentRevisions').paginate({ cursor, numItems: 8 }),
        );
        count += page.page.length;
        if (page.isDone) return count;
        cursor = page.continueCursor;
      }
    };
    const before = await revisionsLeft();
    const first = await t.mutation(internal.erasure.eraseDue, {});
    expect(first.more).toBe(true);
    const deleted = before - (await revisionsLeft());
    // The old budget (twenty writes a row) would have read all of them at once; this pass read what
    // fits: the due rows and the revisions it deleted, each at its heaviest, under the limit.
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(REVISIONS);
    expect((deleted + 4) * ROW_MAX.reportRevision).toBeLessThan(READ_LIMIT);
    // Part-way, the Report is whole and still due.
    expect(await get(t, reportId)).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await revisionsLeft()).toBe(0);
    expect(await get(t, reportId)).toBeNull();
    expect(await get(t, postId)).toBeNull();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(bundle.contentRevisions).toEqual([]);
  });

  test("every row's worst case is under what one pass may read, and every item fits a fresh pass", () => {
    for (const weight of Object.values(ROW_MAX)) expect(weight * 4).toBeLessThan(READ_LIMIT);
    // Progress: the sweep starts an item only when the budget covers it, and a fresh one always does.
    for (const kind of ERASED_KINDS) expect(PASS_NEED[kind]).toBeLessThanOrEqual(TX_BUDGET);
    expect(TX_BUDGET).toBeLessThan(READ_LIMIT);
    // A capped field sizes its row from the cap, not the document limit.
    expect(ROW_MAX.postRevision).toBeLessThan(ROW_MAX.reportRevision);
    expect(ROW_MAX.comment).toBeLessThan(64 * 1024);
  });
});

/** Near the document limit: what an uncapped field can weigh. */
const HEAVY = 'h'.repeat(1000 * 1024);

describe('every read fits a transaction, at the heaviest rows Convex allows', () => {
  /** A photo of the author's with a caption near the document limit, each written on its own. */
  async function heavyPhoto(t: T, uploaderId: Id<'profiles'>, i: number) {
    return t.run(async (ctx) =>
      ctx.db.insert('photos', {
        storageId: await ctx.storage.store(new Blob([`full ${i}`])),
        thumbStorageId: await ctx.storage.store(new Blob([`thumb ${i}`])),
        uploaderId,
        caption: `${i} ${HEAVY}`,
        placeOnMap: false,
        createdAt: Date.now(),
      }),
    );
  }

  test('photo settlement checks and deletes a page at a time, never all at once (Greptile #110)', async () => {
    const { t, author, waterBodyId } = await setup();
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const photoIds: Id<'photos'>[] = [];
    for (let i = 0; i < 20; i++) photoIds.push(await heavyPhoto(t, author.id, i));
    await t.run((ctx) => ctx.db.patch(reportId, { photoIds }));
    // The uploader's hazards are read to their end in this call, so it goes straight to the deletes —
    // which must stop where its budget does.
    await t.run((ctx) => ctx.db.delete(reportId));
    await oweOnRecord(t, author.id, photoIds, { phase: 'hazards' });
    await step(t, author.id);
    const left = (await Promise.all(photoIds.map((id) => get(t, id)))).filter(Boolean).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(photoIds.length);
    await settleAll(t);
    for (const id of photoIds) expect(await get(t, id)).toBeNull();
    expect(await placeOf(t, author.id)).toBeNull();
  });

  test('a hazard filed while a settlement is under way keeps the photo it shows', async () => {
    const { t, author, waterBodyId } = await setup();
    const photoIds: Id<'photos'>[] = [];
    for (let i = 0; i < 12; i++) photoIds.push(await heavyPhoto(t, author.id, i));
    await oweOnRecord(t, author.id, photoIds, { phase: 'hazards' });
    await step(t, author.id);
    // Some went in the first pass; the last one is still waiting, and a hazard takes it now.
    const last = photoIds[photoIds.length - 1] as Id<'photos'>;
    expect(await get(t, last)).not.toBeNull();
    const hazardId = await seedHazard(t, author.id, waterBodyId);
    await t.run((ctx) => ctx.db.patch(hazardId, { photoIds: [last] }));
    await settleAll(t);
    expect(await get(t, last)).toMatchObject({ uploaderId: author.id });
    expect((await get(t, last))?.erasedAt).toBeUndefined();
    expect(await get(t, photoIds[0] as string)).toBeNull();
  });

  /** A Post of ten Reports, each with notes near the document limit, every one withdrawn and due. */
  async function heavyPost(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
    const { postId, reportIds } = await seedPost(t, authorId, waterBodyId, 10);
    for (const id of reportIds) {
      await t.run((ctx) =>
        ctx.db.patch(id, {
          notes: HEAVY,
          moderationStatus: 'removed',
          authorDeletedAt: T0,
          eraseAt: T0 + WITHDRAWN_ERASE_MS,
        }),
      );
    }
    await t.run((ctx) =>
      ctx.db.patch(postId, { moderationStatus: 'removed', authorDeletedAt: T0 }),
    );
    return { postId, reportIds };
  }

  test('a Report of a Post whose ten members are as heavy as they can be is erased, and the Post after', async () => {
    const { t, author, waterBodyId } = await setup();
    const { postId, reportIds } = await heavyPost(t, author.id, waterBodyId);
    advance(31 * DAY);
    await sweep(t);
    for (const id of reportIds) expect(await get(t, id)).toBeNull();
    expect(await get(t, postId)).toBeNull();
    expect(await erasedCount(t, 'report')).toBe(10);
    expect(await erasedCount(t, 'post')).toBe(1);
  });

  test("a flag on such a Post holds every member, the members' clocks a few at a time", async () => {
    const { t, author, other, waterBodyId } = await setup();
    const { postId, reportIds } = await heavyPost(t, author.id, waterBodyId);
    await other.as.mutation(api.contentFlags.flag, {
      targetType: 'post',
      targetId: postId,
      reason: 'harassment',
      note: HEAVY.slice(0, 200 * 1024),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of reportIds) expect((await get(t, id))?.eraseAt).toBeUndefined();
    advance(31 * DAY);
    await sweep(t);
    for (const id of reportIds) expect(await get(t, id)).not.toBeNull();
  });

  test("a member erased between two passes of its Post's clock job costs no other member its clock", async () => {
    const { t, author, waterBodyId } = await setup();
    const { postId, reportIds } = await heavyPost(t, author.id, waterBodyId);
    // No clock on any member yet: the job is what starts them.
    for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { eraseAt: undefined }));
    const first = await t.mutation(internal.erasure.refreshMemberClocks, { postId });
    expect(first.more).toBe(true);
    // The sweep erases the first member before the next pass, and the Post drops it.
    const [gone, ...rest] = reportIds as [Id<'reports'>, ...Id<'reports'>[]];
    await t.run(async (ctx) => {
      await ctx.db.delete(gone);
      await ctx.db.patch(postId, { reportIds: rest });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of rest) expect((await get(t, id))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
  });

  test('the clocks backfill gives heavy rows their clocks a page at a time', async () => {
    const { t, author, waterBodyId } = await setup();
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < 12; i++) {
      const id = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
      await t.run(async (ctx) => {
        const report = await ctx.db.get(id);
        if (report?.postId) await ctx.db.delete(report.postId);
        await ctx.db.patch(id, {
          notes: HEAVY,
          postId: undefined,
          moderationStatus: 'removed',
          authorDeletedAt: T0,
        });
      });
      reportIds.push(id);
    }
    await t.mutation(internal.erasure.backfillClocks, { kind: 'report' });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of reportIds) expect((await get(t, id))?.eraseAt).toBe(T0 + WITHDRAWN_ERASE_MS);
  });
});

describe("a photo is erased only when nothing of its uploader's still uses it", () => {
  async function withPhotoOn(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
    const { reportIds, photoIds } = await seedPost(t, authorId, waterBodyId, 1);
    return { reportId: reportIds[0] as Id<'reports'>, photoId: photoIds[0] as Id<'photos'> };
  }

  test("a run's erasures leave one place per uploader in the queue; one take settles them together", async () => {
    const { t, author, waterBodyId } = await setup();
    const reports: Id<'reports'>[] = [];
    const photos: Id<'photos'>[] = [];
    for (let i = 0; i < 3; i++) {
      const seeded = await seedPost(t, author.id, waterBodyId, 1);
      reports.push(seeded.reportIds[0] as Id<'reports'>);
      photos.push(seeded.photoIds[0] as Id<'photos'>);
    }
    for (const reportId of reports) await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    // Erased pass by pass, nothing scheduled run: three debts, one place in the queue.
    for (const reportId of reports) {
      for (let pass = 0; pass < 20 && (await get(t, reportId)) !== null; pass++) {
        await t.mutation(internal.erasure.eraseDue, { pageSize: 1 });
      }
    }
    expect(await t.run((ctx) => ctx.db.query('photoSettlements').collect())).toHaveLength(3);
    expect(await t.run((ctx) => ctx.db.query('photoSettlementQueue').collect())).toHaveLength(1);
    // One take carries all three debts.
    await step(t, author.id);
    expect((await placeOf(t, author.id))?.owed).toHaveLength(3);
    await settleAll(t);
    for (const id of [...reports, ...photos]) expect(await get(t, id)).toBeNull();
    expect(await placeOf(t, author.id)).toBeNull();
  });

  /** The photo debts on record. */
  const owed = (t: T) => t.run((ctx) => ctx.db.query('photoSettlements').collect());
  /** Sweep passes, run by hand and nothing they schedule, until `id` is erased. */
  async function passesUntilGone(t: T, id: string) {
    for (let pass = 0; pass < 20 && (await get(t, id)) !== null; pass++) {
      await t.mutation(internal.erasure.eraseDue, {});
    }
    expect(await get(t, id)).toBeNull();
  }

  test('a run that dies after an erasure loses no photo it owed: the next run settles it, no step by hand', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [reportId] = reportIds as [Id<'reports'>];
    const [photoId] = photoIds as [Id<'photos'>];
    await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    // The pass that erases the Report writes the debt in the same transaction...
    await passesUntilGone(t, reportId);
    expect((await owed(t)).map((row) => [row.uploaderId, row.photoIds])).toEqual([
      [author.id, [photoId]],
    ]);
    // ...and then everything scheduled after it dies: the run's settlement never happens.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id);
      }
    });
    expect(await get(t, photoId)).not.toBeNull();
    // The next hourly run has nothing due, and still settles what is owed.
    advance(60 * 60 * 1000);
    await sweep(t);
    expect(await get(t, photoId)).toBeNull();
    expect(await owed(t)).toEqual([]);
  });

  test('a debt is cleared exactly when its settlement has finished, not a pass before', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [photoId] = photoIds as [Id<'photos'>];
    for (let i = 0; i < 4; i++) await seedHazard(t, author.id, waterBodyId);
    await t.run(async (ctx) => {
      await ctx.db.delete(reportIds[0] as Id<'reports'>);
      await ctx.db.patch(photoId, { reportId: undefined });
    });
    await oweOnRecord(t, author.id, [photoId]);
    // Step by step, a page a step: the debt stands while the photo does, and goes only after it.
    for (let pass = 0; pass < 40 && (await placeOf(t, author.id)) !== null; pass++) {
      const photo = await get(t, photoId);
      const debts = await owed(t);
      if (photo !== null) expect(debts).toHaveLength(1);
      await step(t, author.id, 1);
    }
    expect(await get(t, photoId)).toBeNull();
    expect(await owed(t)).toEqual([]);
    expect(await placeOf(t, author.id)).toBeNull();
  });

  test('a second erasure while the first is still owed adds its own debt; both are settled, once', async () => {
    const { t, author, waterBodyId } = await setup();
    const first = await seedPost(t, author.id, waterBodyId, 1);
    const second = await seedPost(t, author.id, waterBodyId, 1);
    const shared = first.photoIds[0] as Id<'photos'>;
    // The second Report also carries the first one's photo: one debt each, the photo settled once.
    await t.run((ctx) =>
      ctx.db.patch(second.reportIds[0] as Id<'reports'>, {
        photoIds: [second.photoIds[0] as Id<'photos'>, shared],
      }),
    );
    await author.as.mutation(api.reports.remove, { reportId: first.reportIds[0] as Id<'reports'> });
    advance(31 * DAY);
    await passesUntilGone(t, first.reportIds[0] as string);
    await author.as.mutation(api.reports.remove, {
      reportId: second.reportIds[0] as Id<'reports'>,
    });
    advance(31 * DAY);
    await passesUntilGone(t, second.reportIds[0] as string);
    const debts = await owed(t);
    expect(debts).toHaveLength(2);
    expect(debts.every((row) => row.uploaderId === author.id)).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of [shared, second.photoIds[0] as Id<'photos'>])
      expect(await get(t, id)).toBeNull();
    expect(await owed(t)).toEqual([]);
  });

  test("an uploader whose settlement always fails never holds up anyone else's (Greptile #110)", async () => {
    const { t, author, other } = await setup();
    const photo = (uploaderId: Id<'profiles'>) =>
      t.run(async (ctx) =>
        ctx.db.insert('photos', {
          storageId: await ctx.storage.store(new Blob(['full'])),
          thumbStorageId: await ctx.storage.store(new Blob(['thumb'])),
          uploaderId,
          placeOnMap: false,
          createdAt: T0,
        }),
      );
    // Seven older debts — more than one take's worth — for an uploader whose settlement always fails,
    // and one newer debt for someone else.
    const poisoned: Id<'photos'>[] = [];
    for (let i = 0; i < 7; i++) {
      const photoId = await photo(author.id);
      poisoned.push(photoId);
      await oweOnRecord(t, author.id, [photoId], { owedAt: T0 - 10_000 + i });
    }
    const theirs = await photo(other.id);
    await oweOnRecord(t, other.id, [theirs], { owedAt: T0 });
    const real = photoOrphans.deletePhotoAndBlobs;
    vi.spyOn(photoOrphans, 'deletePhotoAndBlobs').mockImplementation(async (ctx, row) => {
      if (row.uploaderId === author.id) throw new Error('poison');
      return real(ctx, row);
    });
    // Three hourly runs: whatever becomes of the poisoned uploader, the other's photo is settled.
    for (let run = 0; run < 3; run++) {
      await t.mutation(internal.erasure.settleOwed, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      advance(60 * 60 * 1000);
    }
    vi.restoreAllMocks();
    expect(await get(t, theirs)).toBeNull();
    // The poisoned uploader: parked after exactly three attempts, every debt still owed, every photo
    // still there, and not tried again once parked.
    for (const id of poisoned) expect(await get(t, id)).not.toBeNull();
    expect(await placeOf(t, author.id)).toMatchObject({
      attempts: MAX_SETTLE_ATTEMPTS,
      lastErrorClass: 'Error',
      parkedAt: expect.any(Number),
    });
    expect(
      (await owed(t)).filter((row) => row.uploaderId === author.id).map((row) => row.photoIds[0]),
    ).toEqual(poisoned);
    // Visible to the console, and released by an operator's retry.
    const admin = await seedUser(t, 'admin', 'admin');
    const report = await admin.as.query(api.erasure.parked, {});
    expect(report.settlements).toEqual([
      expect.objectContaining({ uploaderId: author.id, attempts: 3, errorClass: 'Error' }),
    ]);
    await t.mutation(internal.erasure.retryParked, {});
    await settleAll(t);
    for (const id of poisoned) expect(await get(t, id)).toBeNull();
    expect(await placeOf(t, author.id)).toBeNull();
  });

  test('an uploader deleted while a settlement is owed leaves no debt row and no photo behind', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 1);
    const [photoId] = photoIds as [Id<'photos'>];
    await t.run(async (ctx) => {
      await ctx.db.delete(reportIds[0] as Id<'reports'>);
      await ctx.db.patch(photoId, { reportId: undefined });
    });
    await oweOnRecord(t, author.id, [photoId]);
    await t.mutation(internal.accountDeletion.finalizeNow, { userId: author.id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await owed(t)).toEqual([]);
    expect(await placeOf(t, author.id)).toBeNull();
    expect(await get(t, photoId)).toBeNull();
    // And a settlement that still finds the debt gone has nothing to do.
    await sweep(t);
    expect(await owed(t)).toEqual([]);
  });

  test('a settlement takes on a second debt only if all of it fits under the ids cap', async () => {
    const { t, author } = await setup();
    /** `n` bare photos of the author's, and a debt naming them. */
    const debtOf = (n: number) =>
      t.run(async (ctx) => {
        const ids: Id<'photos'>[] = [];
        for (let i = 0; i < n; i++) {
          ids.push(
            await ctx.db.insert('photos', {
              storageId: await ctx.storage.store(new Blob([`full ${i}`])),
              thumbStorageId: await ctx.storage.store(new Blob([`thumb ${i}`])),
              uploaderId: author.id,
              placeOnMap: false,
              createdAt: Date.now(),
            }),
          );
        }
        return ids;
      });
    const first = await debtOf(300);
    const second = await debtOf(300);
    await oweOnRecord(t, author.id, first);
    await oweOnRecord(t, author.id, second);
    await step(t, author.id);
    // 300 + 300 is past 500: the first take carries the first debt alone.
    const place = await placeOf(t, author.id);
    expect(place?.photoIds).toHaveLength(300);
    expect(place?.owed).toHaveLength(1);
    await settleAll(t);
    for (const id of [...first, ...second]) expect(await get(t, id)).toBeNull();
    expect(await owed(t)).toEqual([]);
  });

  test('a clear step clears the debts its settlement took on, then takes again', async () => {
    const { t, author } = await setup();
    await oweOnRecord(t, author.id, [], { phase: 'clear' });
    await step(t, author.id);
    expect(await owed(t)).toEqual([]);
    expect(await placeOf(t, author.id)).toMatchObject({ phase: 'take', owed: [] });
  });

  test('a step that goes through clears the failures before it: only failures in a row park', async () => {
    const { t, author } = await setup();
    await oweOnRecord(t, author.id, [], { phase: 'clear' });
    const before = await placeOf(t, author.id);
    await t.run((ctx) =>
      ctx.db.patch(before?._id as Id<'photoSettlementQueue'>, {
        attempts: MAX_SETTLE_ATTEMPTS - 1,
        lastErrorClass: 'Error',
      }),
    );
    await step(t, author.id);
    const after = await placeOf(t, author.id);
    expect(after).toMatchObject({ phase: 'take' });
    expect(after?.attempts).toBeUndefined();
    expect(after?.lastErrorClass).toBeUndefined();
  });

  test('one a surviving hazard shows stays, whole, and in the export', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportId, photoId } = await withPhotoOn(t, author.id, waterBodyId);
    const hazardId = await seedHazard(t, author.id, waterBodyId);
    await t.run((ctx) => ctx.db.patch(hazardId, { photoIds: [photoId] }));
    await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    await sweep(t);
    expect(await get(t, reportId)).toBeNull();
    const photo = await get(t, photoId);
    expect(photo).toMatchObject({ caption: 'the inlet 0' });
    expect(photo?.erasedAt).toBeUndefined();
    expect(photo?.reportId).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.storage.getUrl(photo?.storageId as Id<'_storage'>)),
    ).not.toBeNull();
    const bundle = await t.query(internal.dataExport.collect, { userId: author.id });
    expect(bundle.photos.map((p) => p.photoId)).toEqual([photoId]);
  });

  test('the answer is read whole, a page at a time: untouched until it is, then kept or erased', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportId, photoId } = await withPhotoOn(t, author.id, waterBodyId);
    const second = await seedPost(t, author.id, waterBodyId, 1);
    const shared = second.photoIds[0] as Id<'photos'>;
    // The erased Report also carried a photo that only the uploader's last hazard uses besides —
    // read on the last page. (No Report links it, so the back-link can't answer for it.)
    await t.run(async (ctx) => {
      await ctx.db.patch(reportId, { photoIds: [photoId, shared] });
      await ctx.db.patch(second.reportIds[0] as Id<'reports'>, { photoIds: [] });
      await ctx.db.patch(shared, { reportId: undefined });
    });
    for (let i = 0; i < 5; i++) await seedHazard(t, author.id, waterBodyId);
    const last = await seedHazard(t, author.id, waterBodyId);
    await t.run((ctx) => ctx.db.patch(last, { photoIds: [shared] }));
    // What a tick leaves — the Report gone, its photo unlinked — without the settlement the tick
    // would also schedule, so the paged one below is the only one running.
    await t.run(async (ctx) => {
      await ctx.db.delete(reportId);
      await ctx.db.patch(photoId, { reportId: undefined });
    });
    // A settlement that reads one row a step, to make every page a separate transaction.
    await oweOnRecord(t, author.id, [photoId, shared], { phase: 'reports' });
    // Its fate waits on the whole answer: page after page, nothing is touched.
    for (let page = 0; page < 3; page++) {
      await step(t, author.id, 1);
      expect(await get(t, photoId)).toMatchObject({ caption: 'the inlet 0' });
      expect((await get(t, photoId))?.erasedAt).toBeUndefined();
    }
    await settleAll(t);
    // Used by nothing: gone, blobs and all. Used by the hazard: kept, untouched.
    expect(await get(t, photoId)).toBeNull();
    expect(await get(t, shared)).toMatchObject({ caption: 'the inlet 0' });
    expect((await get(t, shared))?.erasedAt).toBeUndefined();
  });

  test('one an access point shows stays, whole', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportId, photoId } = await withPhotoOn(t, author.id, waterBodyId);
    await t.run(async (ctx) => {
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: T0,
      });
      await ctx.db.insert('accessPhotos', {
        targetType: 'put_in' as const,
        putInId,
        photoId,
        uploaderId: author.id,
        createdAt: T0,
      });
    });
    await author.as.mutation(api.reports.remove, { reportId });
    advance(31 * DAY);
    await sweep(t);
    expect(await get(t, reportId)).toBeNull();
    expect(await get(t, photoId)).toMatchObject({ caption: 'the inlet 0' });
    expect((await get(t, photoId))?.erasedAt).toBeUndefined();
  });

  test('one a Report took behind the scan stays, whole', async () => {
    const { t, author, waterBodyId } = await setup();
    const { reportId, photoId } = await withPhotoOn(t, author.id, waterBodyId);
    const other = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    await seedHazard(t, author.id, waterBodyId);
    await t.run(async (ctx) => {
      await ctx.db.delete(reportId);
      await ctx.db.patch(photoId, { reportId: undefined });
    });
    // The first page reads the only Report left, which doesn't carry it yet.
    await oweOnRecord(t, author.id, [photoId], { phase: 'reports' });
    await step(t, author.id, 1);
    // Now it does, behind the cursor: only the photo's back-link can say so.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(other);
      await ctx.db.patch(other, { photoIds: [...(row?.photoIds ?? []), photoId] });
      await ctx.db.patch(photoId, { reportId: other });
    });
    await settleAll(t);
    expect(await get(t, photoId)).toMatchObject({ caption: 'the inlet 0', reportId: other });
    expect((await get(t, photoId))?.erasedAt).toBeUndefined();
  });
});

describe('the erasure holds under any order', () => {
  type Kind = 'comment' | 'report' | 'hazard';
  type Op =
    | { op: 'delete' | 'hide' | 'remove' | 'restore' | 'overturn' | 'undo' | 'flag'; kind: Kind }
    | { op: 'resolve' | 'retract' | 'sweep' }
    | { op: 'advance'; days: number }
    | { op: 'noise'; kind: Kind; rows: number };
  const kind = fc.constantFrom<Kind>('comment', 'report', 'hazard');
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      op: fc.constantFrom(
        'delete',
        'hide',
        'remove',
        'restore',
        'overturn',
        'undo',
        'flag' as const,
      ),
      kind,
    }) as fc.Arbitrary<Op>,
    fc.record({ op: fc.constantFrom('resolve', 'retract', 'sweep' as const) }) as fc.Arbitrary<Op>,
    fc.record({ op: fc.constant('advance' as const), days: fc.integer({ min: 0, max: 40 }) }),
    fc.record({ op: fc.constant('noise' as const), kind, rows: fc.integer({ min: 1, max: 40 }) }),
  );

  /** A standing verdict, or an undecided flag, on the item — or, for a Report, on its Post. */
  async function heldNow(t: T, type: Kind, id: string, postId: string) {
    return t.run(async (raw) => {
      const ctx = raw as unknown as MutationCtx;
      const on = async (targetType: Kind | 'post', targetId: string) => {
        const verdict = await ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_standing', (q) =>
            q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
          )
          .first();
        if (verdict) return true;
        for (const status of ['open', 'reviewing'] as const) {
          const flag = await ctx.db
            .query('contentFlags')
            .withIndex('by_target_status_reason', (q) =>
              q.eq('targetType', targetType).eq('targetId', targetId).eq('status', status),
            )
            .first();
          if (flag) return true;
        }
        return false;
      };
      return (await on(type, id)) || (type === 'report' && (await on('post', postId)));
    });
  }

  test('nothing held is erased, nothing unheld outlives its time, a reversed verdict never stands, a used photo stays, no job stalls', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 20 }), async (ops) => {
        const { t, author, other, mod, waterBodyId } = await setup();
        const { postId, reportIds, photoIds } = await seedPost(t, author.id, waterBodyId, 2);
        const reportId = reportIds[0] as Id<'reports'>;
        const sharedPhoto = photoIds[0] as Id<'photos'>;
        const commentId = await author.as.mutation(api.comments.create, {
          reportId: reportIds[1] as Id<'reports'>,
          body: 'you are all wrong',
        });
        const hazardId = await seedHazard(t, author.id, waterBodyId);
        // The hazard shows the Report's photo too: erasing the Report must not take it.
        await t.run((ctx) => ctx.db.patch(hazardId, { photoIds: [sharedPhoto] }));
        const ids: Record<Kind, string> = {
          comment: commentId,
          report: reportId,
          hazard: hazardId,
        };
        const withdrawn: Record<Kind, boolean> = { comment: false, report: false, hazard: false };
        const flags: Id<'contentFlags'>[] = [];
        const attempt = async (fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch {
            // a refusal is an outcome
          }
        };
        const set = (k: Kind, status: 'visible' | 'hidden' | 'removed') =>
          mod.as.mutation(api.moderation.setModerationStatus, {
            targetType: k,
            targetId: ids[k],
            status,
            reason: `${status} it`,
          });
        const sweepChecked = async () => {
          const held = {} as Record<Kind, boolean>;
          for (const k of ['comment', 'report', 'hazard'] as const) {
            held[k] = await heldNow(t, k, ids[k], postId);
          }
          await sweep(t);
          for (const k of ['comment', 'report', 'hazard'] as const) {
            // Nothing held is erased; nothing never withdrawn is erased.
            if (held[k] || !withdrawn[k]) expect(await get(t, ids[k])).not.toBeNull();
          }
          // A photo something still shows stays.
          if (await get(t, hazardId)) expect(await get(t, sharedPhoto)).not.toBeNull();
        };

        for (const step of ops) {
          if (step.op === 'advance') {
            // Time passes, and the hourly sweep with it.
            advance(step.days * DAY);
            await sweepChecked();
          } else if (step.op === 'sweep') await sweepChecked();
          else if (step.op === 'resolve' || step.op === 'retract') {
            const flagId = flags.shift();
            if (flagId) {
              await attempt(() =>
                step.op === 'resolve'
                  ? mod.as.mutation(api.moderation.resolveFlag, {
                      flagId,
                      resolution: 'dismissed',
                      reason: 'not this',
                    })
                  : other.as.mutation(api.contentFlags.retract, { flagId }),
              );
            }
          } else if (step.op === 'noise') {
            const target = ids[step.kind];
            await t.run(async (ctx) => {
              for (let i = 0; i < step.rows; i++) {
                await ctx.db.insert('moderationActions', {
                  actorId: mod.id,
                  action: 'dismiss_flag',
                  targetType: step.kind,
                  targetId: target,
                  reason: 'noise',
                  createdAt: Date.now(),
                });
              }
            });
          } else {
            const k = (step as { kind: Kind }).kind;
            if ((await get(t, ids[k])) === null) continue;
            if (step.op === 'delete') {
              await attempt(async () => {
                if (k === 'comment') {
                  await author.as.mutation(api.comments.remove, { commentId });
                } else if (k === 'report') {
                  await author.as.mutation(api.reports.remove, { reportId });
                } else {
                  await author.as.mutation(api.hazardWithdrawal.withdraw, { hazardId });
                }
                withdrawn[k] = true;
              });
            } else if (step.op === 'hide') await attempt(() => set(k, 'hidden'));
            else if (step.op === 'remove') await attempt(() => set(k, 'removed'));
            else if (step.op === 'restore') await attempt(() => set(k, 'visible'));
            else if (step.op === 'overturn') {
              await attempt(() =>
                mod.as.mutation(api.moderation.overturnVerdict, {
                  targetType: k,
                  targetId: ids[k],
                  reason: 'on appeal',
                }),
              );
            } else if (step.op === 'undo') {
              const rows = await t.run((raw) =>
                (raw as unknown as MutationCtx).db
                  .query('moderationActions')
                  .withIndex('by_target', (q) => q.eq('targetType', k).eq('targetId', ids[k]))
                  .order('desc')
                  .take(1),
              );
              const row = rows[0];
              if (row && row.action !== 'dismiss_flag') {
                await attempt(() =>
                  mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'x' }),
                );
              }
            } else {
              await attempt(async () => {
                flags.push(
                  await other.as.mutation(api.contentFlags.flag, {
                    targetType: k,
                    targetId: ids[k],
                    reason: 'harassment',
                  }),
                );
              });
            }
          }
          // The member clocks a Post's hold moves follow in their own jobs.
          await t.finishAllScheduledFunctions(vi.runAllTimers);
          // A verdict stands at most once on an item.
          for (const k of ['comment', 'report', 'hazard'] as const) {
            const standing = await t.run((raw) =>
              (raw as unknown as MutationCtx).db
                .query('contentVerdicts')
                .withIndex('by_target_standing', (q) =>
                  q.eq('targetType', k).eq('targetId', ids[k]).eq('standing', true),
                )
                .collect(),
            );
            expect(standing.length).toBeLessThanOrEqual(1);
          }
        }

        // One rule, two answers never: the backfill, replaying every history whole a page at a time,
        // lands where the live writers did — so no reversed verdict stands.
        const snapshot = async () =>
          (await t.run((ctx) => ctx.db.query('contentVerdicts').collect()))
            .map((v) => `${v.actionId} ${v.standing} ${v.endedByActionId ?? '-'}`)
            .sort();
        const live = await snapshot();
        await t.run(async (ctx) => {
          for (const v of await ctx.db.query('contentVerdicts').collect())
            await ctx.db.delete(v._id);
        });
        await t.mutation(internal.contentRecord.backfillVerdicts, { pageSize: 7, clocks: false });
        await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
        expect(await snapshot()).toEqual(live);

        // Every hold let go, 30 days on: everything withdrawn is gone, everything else stays.
        for (const flagId of flags) {
          await attempt(() =>
            mod.as.mutation(api.moderation.resolveFlag, {
              flagId,
              resolution: 'dismissed',
              reason: 'x',
            }),
          );
        }
        for (const k of ['comment', 'report', 'hazard'] as const) {
          if (withdrawn[k]) {
            await attempt(() =>
              mod.as.mutation(api.moderation.overturnVerdict, {
                targetType: k,
                targetId: ids[k],
                reason: 'closing out',
              }),
            );
          }
        }
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        advance(31 * DAY);
        await sweepChecked();
        for (const k of ['comment', 'report', 'hazard'] as const) {
          if (withdrawn[k]) expect(await get(t, ids[k])).toBeNull();
          else expect(await get(t, ids[k])).not.toBeNull();
        }
      }),
      { numRuns: 60 },
    );
  }, 300_000);
});

describe('fairness under failure, under any mix', () => {
  type Outcome = 'fail' | 'succeed' | 'held';
  const RUNS = 6;
  const HOUR = 60 * 60 * 1000;

  /** The rule's model: consecutive failures since the last success; parked at three. */
  function model(outcomes: readonly Outcome[]) {
    let failures = 0;
    let parked = false;
    let done = false;
    return outcomes.map((o) => {
      const attempted = !done && !parked && o !== 'held';
      if (attempted && o === 'fail') {
        failures++;
        if (failures >= MAX_ERASE_ATTEMPTS) parked = true;
      } else if (attempted && o === 'succeed') {
        done = true;
        failures = 0;
      }
      return { attempted, failures, parked, done };
    });
  }

  test('eraseDue, over any outcomes across runs: one attempt a run; parked exactly after three failures in a row; healthy items done in their run; the daily retry frees what heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.constantFrom<Outcome>('fail', 'succeed', 'held'), {
            minLength: RUNS,
            maxLength: RUNS,
          }),
          {
            minLength: 1,
            maxLength: 5,
          },
        ),
        async (plans) => {
          // A run a shrink abandoned part-way leaves no spy behind for the next.
          vi.restoreAllMocks();
          const { t, author, other, mod, waterBodyId } = await setup();
          const reportId = (await seedPost(t, author.id, waterBodyId, 1))
            .reportIds[0] as Id<'reports'>;
          const ids: Id<'comments'>[] = [];
          for (const [i] of plans.entries()) {
            const id = await author.as.mutation(api.comments.create, { reportId, body: `c${i}` });
            await author.as.mutation(api.comments.remove, { commentId: id });
            ids.push(id);
          }
          const expected = plans.map(model);
          const failing = new Set<string>();
          const real = audit.writeAudit;
          const writes = vi.spyOn(audit, 'writeAudit').mockImplementation(async (ctx, entry) => {
            if (entry.action === 'erase' && failing.has(entry.targetId)) throw new Error('poison');
            return real(ctx, entry);
          });
          advance(31 * DAY);
          for (let run = 0; run < RUNS; run++) {
            failing.clear();
            const flags: Id<'contentFlags'>[] = [];
            for (const [i, plan] of plans.entries()) {
              if (plan[run] === 'fail') failing.add(ids[i] as string);
              if (plan[run] === 'held' && (await get(t, ids[i] as string))) {
                flags.push(
                  await other.as.mutation(api.contentFlags.flag, {
                    targetType: 'comment',
                    targetId: ids[i] as string,
                    reason: 'harassment',
                  }),
                );
              }
            }
            writes.mockClear();
            await sweep(t);
            for (const [i, id] of ids.entries()) {
              const tries = writes.mock.calls.filter(
                ([, entry]) => entry.action === 'erase' && entry.targetId === id,
              ).length;
              const want = expected[i]?.[run];
              // At most one attempt per item per run, and only when the rule says it is attempted.
              expect(tries).toBe(want?.attempted ? 1 : 0);
              const row = await get(t, id);
              if (want?.done) expect(row).toBeNull();
              else {
                expect(row?.eraseAttempts ?? 0).toBe(want?.failures ?? 0);
                expect(row?.eraseParkedAt !== undefined).toBe(want?.parked ?? false);
              }
            }
            for (const flagId of flags) {
              await mod.as.mutation(api.moderation.resolveFlag, {
                flagId,
                resolution: 'dismissed',
                reason: 'not this',
              });
            }
            advance(HOUR);
          }
          // Everything heals: the daily retry frees every parked item — a few a day — and nobody
          // releases anything by hand.
          failing.clear();
          for (let day = 0; day < 3; day++) {
            await t.mutation(internal.erasure.retryParkedDaily, {});
            await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
            advance(DAY);
          }
          // And the hourly run for what was never parked.
          await sweep(t);
          for (const id of ids) expect(await get(t, id)).toBeNull();
          vi.restoreAllMocks();
        },
      ),
      { numRuns: 20 },
    );
  }, 300_000);

  test('settleOwed, over any outcomes across runs: one attempt a run; parked exactly after three failures in a row; healthy uploaders settled in their run; the daily retry frees what heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            debts: fc.integer({ min: 1, max: 9 }),
            plan: fc.array(fc.constantFrom<Outcome>('fail', 'succeed'), {
              minLength: RUNS,
              maxLength: RUNS,
            }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (uploaders) => {
          vi.restoreAllMocks();
          const { t } = await setup();
          const people: { id: Id<'profiles'>; photos: Id<'photos'>[] }[] = [];
          for (const [n, spec] of uploaders.entries()) {
            const person = await seedUser(t, `u${n}`);
            const photos: Id<'photos'>[] = [];
            for (let i = 0; i < spec.debts; i++) {
              const photoId = await t.run(async (ctx) =>
                ctx.db.insert('photos', {
                  storageId: await ctx.storage.store(new Blob([`f${i}`])),
                  thumbStorageId: await ctx.storage.store(new Blob([`t${i}`])),
                  uploaderId: person.id,
                  placeOnMap: false,
                  createdAt: T0,
                }),
              );
              photos.push(photoId);
              await oweOnRecord(t, person.id, [photoId], { owedAt: T0 - 1000 + i });
            }
            people.push({ id: person.id, photos });
          }
          const expected = uploaders.map((u) => model(u.plan));
          const failing = new Set<string>();
          const real = photoOrphans.deletePhotoAndBlobs;
          const deletes = vi
            .spyOn(photoOrphans, 'deletePhotoAndBlobs')
            .mockImplementation(async (ctx, row) => {
              if (failing.has(row.uploaderId)) throw new Error('poison');
              return real(ctx, row);
            });
          for (let run = 0; run < RUNS; run++) {
            failing.clear();
            for (const [i, spec] of uploaders.entries()) {
              if (spec.plan[run] === 'fail') failing.add(people[i]?.id as string);
            }
            deletes.mockClear();
            await settleAll(t);
            for (const [i, person] of people.entries()) {
              const want = expected[i]?.[run];
              const tries = deletes.mock.calls.filter(
                ([, row]) => row.uploaderId === person.id,
              ).length;
              // A failing attempt fails on its first photo: once a run, and only when attempted.
              if (uploaders[i]?.plan[run] === 'fail') expect(tries).toBe(want?.attempted ? 1 : 0);
              const place = await placeOf(t, person.id);
              if (want?.done) {
                expect(place).toBeNull();
                for (const id of person.photos) expect(await get(t, id)).toBeNull();
              } else {
                expect(place?.attempts ?? 0).toBe(want?.failures ?? 0);
                expect(place?.parkedAt !== undefined).toBe(want?.parked ?? false);
                // Nothing of a failing uploader's is cleared or deleted.
                for (const id of person.photos) expect(await get(t, id)).not.toBeNull();
              }
            }
            advance(HOUR);
          }
          failing.clear();
          for (let day = 0; day < 3; day++) {
            await t.mutation(internal.erasure.retryParkedDaily, {});
            await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
            advance(DAY);
          }
          await settleAll(t);
          for (const person of people) {
            expect(await placeOf(t, person.id)).toBeNull();
            for (const id of person.photos) expect(await get(t, id)).toBeNull();
          }
          vi.restoreAllMocks();
        },
      ),
      { numRuns: 20 },
    );
  }, 300_000);
});

describe('parking heals itself', () => {
  test('a parked item that always fails never keeps another from its daily retry', async () => {
    const { t, author, waterBodyId } = await setup();
    const admin = await seedUser(t, 'admin', 'admin');
    const reportId = (await seedPost(t, author.id, waterBodyId, 1)).reportIds[0] as Id<'reports'>;
    const ids: Id<'comments'>[] = [];
    for (let i = 0; i < DAILY_RETRIES + 2; i++) {
      const id = await author.as.mutation(api.comments.create, { reportId, body: `c${i}` });
      await author.as.mutation(api.comments.remove, { commentId: id });
      ids.push(id);
      advance(1000);
    }
    const [poison] = ids as [Id<'comments'>];
    // All of them parked, the poison the longest ago: three failing runs.
    const broken = new Set<string>(ids);
    const real = audit.writeAudit;
    vi.spyOn(audit, 'writeAudit').mockImplementation(async (ctx, entry) => {
      if (entry.action === 'erase' && broken.has(entry.targetId)) throw new Error('poison');
      return real(ctx, entry);
    });
    advance(31 * DAY);
    for (let run = 0; run < 3; run++) {
      await sweep(t);
      advance(60 * 60 * 1000);
    }
    for (const id of ids) expect((await get(t, id))?.eraseParkedAt).toBeDefined();
    // A fix ships for all but the poison. Day by day, a few at a time, least recently tried first:
    // the poison is re-stamped behind the rest each time it fails, so every other gets its turn.
    broken.clear();
    broken.add(poison);
    for (let day = 0; day < 2; day++) {
      await t.mutation(internal.erasure.retryParkedDaily, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
      advance(DAY);
    }
    for (const id of ids.slice(1)) expect(await get(t, id)).toBeNull();
    const still = await get(t, poison);
    expect(still).toMatchObject({
      eraseParkedAt: expect.any(Number),
      eraseRetriedAt: expect.any(Number),
    });
    const report = await admin.as.query(api.erasure.parked, {});
    expect(report.items).toEqual([
      expect.objectContaining({ id: poison, dailyRetriedAt: expect.any(Number) }),
    ]);
  });
});
