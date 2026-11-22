/**
 * **A skater who asked hears the answer, and an alert's author hears a retraction** (D285, B01-5c):
 * the `moderator_decision` type end to end, through the real public mutations — a decision, then the
 * flush, then the inbox read — never the helper alone.
 *
 * - Enqueued where D285 says: every ask a decision closes (its siblings on every page of the drain,
 *   each once), a drawing's review, a moderator's retraction of someone else's live alert. Not an ask
 *   a script filed, not a verdict recorded on an alert its author already withdrew, not a fake person.
 * - Held at the flush to the decision's own row: an undo inside the settle window drops the message;
 *   an undo after it leaves the message standing.
 * - Served only to a client that says it words the type (`knows`); every older build reads `unknown`.
 */

import {
  describeNotification,
  NOTIFICATION_PREF_DEFAULTS,
  NOTIFICATION_TYPES,
  type NotificationView,
  RISK_ACK_VERSION,
  requestNameKeyFor,
} from '@skating/core';
import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  AXES,
  fileMember,
  flagSource,
  RECONCILE_COST,
  requestSource,
  type TxCost,
} from './lib/inboxItems';
import { enqueueModeratorDecision, settleReadCost } from './lib/notificationQueue';
import { parsePayload } from './lib/notificationResolve';
import { REQUEST_SIBLINGS_MAX, siblingCost } from './lib/requestDecisions';
import { SEED_CLERK_PREFIX } from './lib/seedPeople';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type As = ReturnType<T['withIdentity']>;
const NOW = Date.now();

/** Every toggle as a fresh profile has it — `moderatorDecision` on (D285). */
const PREFS = { ...NOTIFICATION_PREF_DEFAULTS };

const SQUARE = (x: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x - 0.5, -0.5],
      [x - 0.5, 0.5],
      [x + 0.5, 0.5],
      [x + 0.5, -0.5],
      [x - 0.5, -0.5],
    ],
  ],
});

async function person(
  t: T,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
  prefs: Partial<Doc<'profiles'>['notificationPrefs']> = PREFS,
): Promise<{ id: Id<'profiles'>; as: As }> {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: prefs as Doc<'profiles'>['notificationPrefs'],
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function lake(t: T, externalId: string, x: number): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId.slice(4)}`,
        type: 'lakePond',
        polygon: SQUARE(x),
        bbox: { minLat: -0.5, minLng: x - 0.5, maxLat: 0.5, maxLng: x + 0.5 },
        centroid: { lat: 0, lng: x },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  return row?._id as Id<'waterBodies'>;
}

/** Staff, an asker, an active lake and a dormant one. */
async function world() {
  const t = harness();
  const admin = await person(t, 'admin', 'admin');
  const mod = await person(t, 'mod', 'moderator');
  const asker = await person(t, 'asker');
  const active = await lake(t, 'osm/A', 0);
  const dormant = await lake(t, 'osm/B', 3);
  await t.run((ctx) =>
    ctx.db.patch(dormant, { dormant: { since: NOW, reason: 'inactive' as const } }),
  );
  return { t, admin, mod, asker, active, dormant };
}
type W = Awaited<ReturnType<typeof world>>;

const activate = (w: W, by: As = w.asker.as) =>
  by.mutation(api.corpusRequests.create, {
    kind: 'activate',
    coord: { lat: 0.2, lng: 3.2 },
    waterBodyId: w.dormant,
  });

/** A moment for the wall clock to pass the asks (a decision drains those that existed by its now). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Every continuation a decision or undo scheduled, run to its end — each its own execution. */
async function drainAll(t: T): Promise<number> {
  const seen = new Set<string>();
  for (let pages = 0; pages < 400; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) => !seen.has(s._id) && s.state.kind === 'pending' && CONTINUATIONS.has(s.name),
    );
    if (!next) return pages;
    seen.add(next._id);
    await t.mutation(makeFunctionReference<'mutation'>(next.name), next.args[0] as never);
  }
  throw new Error('a continuation never ended');
}
const CONTINUATIONS = new Set([
  'corpusRequests:closeSiblings',
  'inboxWrites:reopenRequestsRest',
  'inboxWrites:closeRequestsRest',
]);

const queueRows = (t: T) => t.run((ctx) => ctx.db.query('notificationQueue').collect());
const inboxRows = (t: T) => t.run((ctx) => ctx.db.query('notifications').collect());

/** Every queued row due now, unflushed. */
const makeDue = (t: T) =>
  t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });

/**
 * Make every queued row due and flush until the queue is empty — the cron's work, done now. Each
 * flush is a transaction of its own (the harness holds each to Convex's limits); a large queue takes
 * several, as the flush's own continuation would.
 */
async function flushAllDue(t: T): Promise<Doc<'notifications'>[]> {
  for (let pass = 0; pass < 20; pass++) {
    const rows = await queueRows(t);
    if (rows.length === 0) break;
    await t.run(async (ctx) => {
      for (const row of rows) await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    });
    await t.mutation(internal.notifications.flushNotificationQueue, {});
  }
  expect(await queueRows(t)).toEqual([]);
  return inboxRows(t);
}

/** The person's inbox as a build that words the type reads it — and as one that doesn't. */
async function inboxOf(as: As, knows?: readonly string[]): Promise<NotificationView[]> {
  const page = await as.query(api.notifications.list, {
    paginationOpts: { numItems: 50, cursor: null },
    ...(knows !== undefined ? { knows: [...knows] } : {}),
  });
  return page.page as NotificationView[];
}
const KNOWS = NOTIFICATION_TYPES;

/** The decision rows the audit log holds for `targetId`, newest first. */
const decisionOf = (t: T, action: Doc<'moderationActions'>['action'], targetId: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('moderationActions').collect())
      .filter((r) => r.action === action && r.targetId === targetId)
      .sort((a, b) => b._creationTime - a._creationTime)
      .at(0),
  );

const undo = (w: W, actionId: Id<'moderationActions'> | undefined, as: As = w.admin.as) =>
  as.mutation(api.undo.run, { actionId: actionId as Id<'moderationActions'>, reason: 'Undone' });

describe('an ask’s decision tells its asker (D285)', () => {
  test('a decline reaches the asker with the moderator’s note; an older build reads it as unknown', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, {
      requestId,
      note: 'No public way in this winter',
    });
    const queued = await queueRows(w.t);
    expect(queued.map((r) => [r.userId, r.kind, r.type])).toEqual([
      [w.asker.id, 'request_decided', 'moderator_decision'],
    ]);
    // Settling, not sent: nothing reaches the inbox until the window has passed.
    expect(queued[0]?.flushAfter).toBeGreaterThan(Date.now());
    await w.t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await inboxRows(w.t)).toEqual([]);

    const delivered = await flushAllDue(w.t);
    expect(delivered.map((n) => [n.userId, n.type])).toEqual([[w.asker.id, 'moderator_decision']]);
    const [view] = await inboxOf(w.asker.as, KNOWS);
    expect(view).toMatchObject({
      type: 'moderator_decision',
      about: 'activate',
      outcome: 'declined',
      body: { id: w.dormant, name: 'Pond B' },
      note: 'No public way in this winter',
    });
    expect(describeNotification(view as NotificationView)).toEqual({
      title: 'Your request to add Pond B to the map was declined',
      detail: 'No public way in this winter',
      target: { kind: 'water', id: w.dormant },
    });
    // A build installed before the type (no `knows`) gets the row every build words.
    expect((await inboxOf(w.asker.as)).map((v) => v.type)).toEqual(['unknown']);
    // The moderator who decided is told nothing.
    expect(await inboxOf(w.admin.as, KNOWS)).toEqual([]);
  });

  test('an approval tells the asker what it did, naming the lake', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.approve, { requestId });
    await flushAllDue(w.t);
    const [view] = await inboxOf(w.asker.as, KNOWS);
    expect(view).toMatchObject({ about: 'activate', outcome: 'approved', body: { id: w.dormant } });
    expect(describeNotification(view as NotificationView).title).toBe(
      'Gli added Pond B to the map',
    );
  });

  test('an approved admit names the lake it admitted', async () => {
    const w = await world();
    const requestId = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: w.asker.id,
        coord: { lat: 30.5, lng: 30.5 },
        candidate: {
          source: '3dhp',
          externalId: 'catalog/new',
          name: 'Found Pond',
          featureType: 390,
          cls: 'lakePond',
          polygon: SQUARE(30.5) as never,
          bbox: { minLat: -0.5, minLng: 30, maxLat: 0.5, maxLng: 31 },
          centroid: { lat: 0, lng: 30.5 },
          surfaceAreaSqM: 1_000_000,
          serviceUrl: 'https://example.invalid/3dhp',
          fetchedAt: NOW - 1000,
        },
        candidateExternalId: 'catalog/new',
        resolvedAt: NOW - 1000,
        createdAt: NOW - 10_000,
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    await w.admin.as.mutation(api.corpusRequests.approve, { requestId });
    const admitted = (await w.t.run((ctx) => ctx.db.get(requestId)))?.admittedWaterBodyId;
    expect(admitted).toBeDefined();
    await flushAllDue(w.t);
    const [view] = await inboxOf(w.asker.as, KNOWS);
    expect(view).toMatchObject({
      about: 'admit',
      outcome: 'approved',
      body: { id: admitted, name: 'Found Pond' },
    });
  });

  test('a declined admit has no lake yet, and still reads as a sentence', async () => {
    const w = await world();
    const requestId = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 30, lng: 30 },
    });
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'Not a pond' });
    await flushAllDue(w.t);
    const [view] = await inboxOf(w.asker.as, KNOWS);
    expect(view).toMatchObject({ about: 'admit', outcome: 'declined', body: null });
    expect(describeNotification(view as NotificationView)).toEqual({
      title: 'Your request to add a lake was declined',
      detail: 'Not a pond',
      target: null,
    });
  });

  test('a decline closing many siblings across several pages tells every asker exactly once', async () => {
    const w = await world();
    // The decision's whole reach: the primary and its cap of siblings, each a different person.
    const n = REQUEST_SIBLINGS_MAX + 1;
    const askers: Id<'profiles'>[] = [];
    for (let start = 0; start < n; start += 100) {
      askers.push(
        ...(await w.t.run(async (ctx) => {
          const out: Id<'profiles'>[] = [];
          for (let i = start; i < Math.min(start + 100, n); i++) {
            out.push(
              await ctx.db.insert('profiles', {
                clerkUserId: `s${i}`,
                displayName: `s${i} Test-Person`,
                username: `s${i}`,
                driveTimePrefMinutes: 60,
                profileVisibility: 'public',
                notificationPrefs: PREFS,
                dateOfBirth: Date.UTC(1990, 0, 1),
                reputationPoints: 0,
                role: 'member',
                status: 'active',
                createdAt: NOW,
              }),
            );
          }
          return out;
        })),
      );
    }
    const asks = await bayAsks(w.t, w.active, askers);
    await settle();
    await w.admin.as.mutation(api.corpusRequests.decline, {
      requestId: asks[0] as Id<'waterBodyRequests'>,
      note: 'Not its own place',
    });
    // More than one page: the drain's continuations, each its own transaction.
    expect(await drainAll(w.t)).toBeGreaterThanOrEqual(2);
    const queued = await queueRows(w.t);
    expect(queued).toHaveLength(n);
    expect(new Set(queued.map((r) => r.userId))).toEqual(new Set(askers));
    const delivered = await flushAllDue(w.t);
    expect(delivered).toHaveLength(n);
    expect(new Set(delivered.map((r) => r.userId))).toEqual(new Set(askers));
  }, 120_000);

  test('an ask a script filed tells no one — its requester is staff, and nobody asked (D289)', async () => {
    const w = await world();
    const seedAsk = await w.t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        origin: 'seed',
        requesterId: w.mod.id,
        coord: { lat: 0.2, lng: 0.2 },
        waterBodyId: w.active,
        name: 'Shaker Cove',
        nameKey: requestNameKeyFor('name_bay', 'Shaker Cove'),
        createdAt: NOW - 1000,
      }),
    );
    // Its app-filed sibling is told; the script's ask is not, whoever decides it.
    const appAsk = await w.asker.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.2, lng: 0.2 },
      waterBodyId: w.active,
      name: 'Shaker Cove',
    });
    await settle();
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId: seedAsk, note: 'No' });
    await drainAll(w.t);
    const statuses = await w.t.run(async (ctx) => [
      (await ctx.db.get(seedAsk))?.status,
      (await ctx.db.get(appAsk))?.status,
    ]);
    expect(statuses).toEqual(['declined', 'declined']);
    expect((await queueRows(w.t)).map((r) => r.userId)).toEqual([w.asker.id]);
  });

  test('an undo inside the window drops the message; the decision decided again is one message', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    await undo(w, (await decisionOf(w.t, 'decline_request', requestId))?._id);
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
    expect(await flushAllDue(w.t)).toEqual([]);

    // Declined, undone, declined again inside one window: one message, about the last decision.
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'First' });
    await undo(w, (await decisionOf(w.t, 'decline_request', requestId))?._id);
    await w.mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'Second' });
    expect(await queueRows(w.t)).toHaveLength(1);
    await flushAllDue(w.t);
    expect((await inboxOf(w.asker.as, KNOWS)).map((v) => (v as { note?: string }).note)).toEqual([
      'Second',
    ]);
  });

  test('a row already due when its decision is undone and made again: only the new decision is told', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'First' });
    // Due but not yet flushed: a later event can't join it, so the next decision gets a row of its own.
    await makeDue(w.t);
    await undo(w, (await decisionOf(w.t, 'decline_request', requestId))?._id);
    await w.mod.as.mutation(api.corpusRequests.decline, { requestId, note: 'Second' });
    expect(await queueRows(w.t)).toHaveLength(2);
    // The first row's decision was undone: the ask is closed again, but by another row.
    expect(await flushAllDue(w.t)).toHaveLength(1);
    expect((await inboxOf(w.asker.as, KNOWS)).map((v) => (v as { note?: string }).note)).toEqual([
      'Second',
    ]);
  });

  test('the undo of a reopen declines again inside the window — the message stands, once', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    await undo(w, (await decisionOf(w.t, 'decline_request', requestId))?._id);
    await undo(w, (await decisionOf(w.t, 'reopen_request', requestId))?._id, w.mod.as);
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('declined');
    const delivered = await flushAllDue(w.t);
    expect(delivered).toHaveLength(1);
    expect((await inboxOf(w.asker.as, KNOWS))[0]).toMatchObject({
      outcome: 'declined',
      note: 'No',
    });
  });

  test('an undo after the window: the message has gone, and stands', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    expect(await flushAllDue(w.t)).toHaveLength(1);
    await undo(w, (await decisionOf(w.t, 'decline_request', requestId))?._id);
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe('open');
    // The undo sends nothing of its own, and takes nothing back.
    expect(await flushAllDue(w.t)).toHaveLength(1);
    expect((await inboxOf(w.asker.as, KNOWS)).map((v) => v.type)).toEqual(['moderator_decision']);
  });
});

describe('a drawing’s review tells the person who drew it (D285)', () => {
  let tracks = 0;
  const drawn = async (w: W, by: { as: As } = w.asker) => {
    const T0 = Date.UTC(2026, 0, 15, 14);
    const i = tracks++;
    const activityId = await by.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: `track-${i}`,
      // Each drawing on water of its own, far from the last.
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, k) => [40 + i + k * 0.01, 40.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    return by.as.mutation(api.waterBodies.create, {
      name: 'Hidden Pond',
      type: 'lakePond',
      activityId,
      confirmedNew: true,
    });
  };

  test('an approval and a rejection each reach the drawer; a rejection carries no reason', async () => {
    const w = await world();
    const kept = await drawn(w);
    await w.admin.as.mutation(api.waterBodies.approve, { waterBodyId: kept });
    await flushAllDue(w.t);
    const [approved] = await inboxOf(w.asker.as, KNOWS);
    expect(approved).toMatchObject({ about: 'drawn', outcome: 'approved', body: { id: kept } });
    expect(describeNotification(approved as NotificationView).title).toBe(
      'Gli added Hidden Pond, the lake you drew, to the map',
    );

    const other = await person(w.t, 'drawer2');
    const gone = await drawn(w, other);
    await w.admin.as.mutation(api.waterBodies.reject, {
      waterBodyId: gone,
      reason: 'A puddle on a parking lot',
    });
    await flushAllDue(w.t);
    const [rejected] = await inboxOf(other.as, KNOWS);
    expect(rejected).toMatchObject({ about: 'drawn', outcome: 'rejected' });
    expect(rejected).not.toHaveProperty('note');
    expect(describeNotification(rejected as NotificationView)).toEqual({
      title: 'Gli didn’t add Hidden Pond, the lake you drew, to the map',
      target: null,
    });
  });

  test('a return to review inside the window drops it; after the window the message stands', async () => {
    const w = await world();
    const body = await drawn(w);
    await w.admin.as.mutation(api.waterBodies.approve, { waterBodyId: body });
    await undo(w, (await decisionOf(w.t, 'approve_waterbody', body))?._id);
    expect((await w.t.run((ctx) => ctx.db.get(body)))?.reviewStatus).toBe('pending');
    expect(await flushAllDue(w.t)).toEqual([]);

    await w.admin.as.mutation(api.waterBodies.reject, { waterBodyId: body });
    expect(await flushAllDue(w.t)).toHaveLength(1);
    await undo(w, (await decisionOf(w.t, 'reject_waterbody', body))?._id);
    expect(await flushAllDue(w.t)).toHaveLength(1);
  });

  test('a review’s row already due when it is undone and made again: only the new review is told', async () => {
    const w = await world();
    const body = await drawn(w);
    await w.admin.as.mutation(api.waterBodies.approve, { waterBodyId: body });
    await makeDue(w.t);
    await undo(w, (await decisionOf(w.t, 'approve_waterbody', body))?._id);
    await w.mod.as.mutation(api.waterBodies.approve, { waterBodyId: body });
    expect(await queueRows(w.t)).toHaveLength(2);
    // Approved again, but the first row's approval was undone: one message.
    expect(await flushAllDue(w.t)).toHaveLength(1);
  });

  test('a review undone and made again inside the window is one message, about the last review', async () => {
    const w = await world();
    const body = await drawn(w);
    await w.admin.as.mutation(api.waterBodies.approve, { waterBodyId: body });
    await undo(w, (await decisionOf(w.t, 'approve_waterbody', body))?._id);
    await w.mod.as.mutation(api.waterBodies.reject, { waterBodyId: body });
    expect(await queueRows(w.t)).toHaveLength(1);
    await flushAllDue(w.t);
    expect(
      (await inboxOf(w.asker.as, KNOWS)).map((v) => (v as { outcome: string }).outcome),
    ).toEqual(['rejected']);
  });
});

describe('a moderator’s retraction tells the alert’s author (D285)', () => {
  const alert = async (w: W, extra: Partial<Doc<'accessAlerts'>> = {}) =>
    w.t.run(async (ctx) => {
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId: w.active,
        coord: { lat: 0.1, lng: 0.1 },
        source: 'osm',
        status: 'visible',
        name: 'North Ramp',
        createdAt: NOW,
      });
      return ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        putInId,
        waterBodyId: w.active,
        reason: 'gate_locked',
        kind: 'blocker',
        createdByUserId: w.asker.id,
        createdAt: NOW,
        season: 2026,
        status: 'active',
        expiresAt: NOW + 86_400_000,
        confirmCount: 0,
        denyCount: 0,
        ...extra,
      });
    });

  test('the Inbox’s Retract reaches the author, naming the spot and never the reason', async () => {
    const w = await world();
    const accessAlertId = await alert(w);
    const filer = await person(w.t, 'filer');
    const flagId = await filer.as.mutation(api.contentFlags.flag, {
      targetType: 'accessAlert',
      targetId: accessAlertId,
      reason: 'other',
      note: 'The gate was open',
    });
    const itemId = await w.t.run(async (ctx) => {
      await fileMember(ctx, flagSource(flagId));
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
        .first();
      return m?.itemId as Id<'inboxItems'>;
    });
    await w.mod.as.mutation(api.inboxWrites.alertVerdict, {
      itemId,
      verb: 'retract',
      reason: 'A false claim, again',
    });
    await flushAllDue(w.t);
    const views = await inboxOf(w.asker.as, KNOWS);
    const decision = views.find((v) => v.type === 'moderator_decision');
    expect(decision).toEqual(
      expect.objectContaining({
        about: 'accessAlert',
        outcome: 'retracted',
        body: { id: w.active, name: 'Pond A' },
        place: 'North Ramp',
      }),
    );
    expect(decision).not.toHaveProperty('note');
    expect(describeNotification(decision as NotificationView).title).toBe(
      'A moderator took down your access alert at North Ramp, Pond A',
    );
  });

  test('an unretraction inside the window drops it; after the window the message stands', async () => {
    const w = await world();
    const accessAlertId = await alert(w);
    await w.mod.as.mutation(api.accessAlerts.retract, { accessAlertId, reason: 'False' });
    await undo(w, (await decisionOf(w.t, 'retract_access_alert', accessAlertId))?._id);
    expect((await w.t.run((ctx) => ctx.db.get(accessAlertId)))?.status).toBe('active');
    expect(await flushAllDue(w.t)).toEqual([]);

    await w.mod.as.mutation(api.accessAlerts.retract, { accessAlertId, reason: 'False' });
    expect(await flushAllDue(w.t)).toHaveLength(1);
    await undo(w, (await decisionOf(w.t, 'retract_access_alert', accessAlertId))?._id);
    expect(await flushAllDue(w.t)).toHaveLength(1);
  });

  test('a pinned alert is live: its retraction tells its author too', async () => {
    const w = await world();
    const accessAlertId = await alert(w, { status: 'official', expiresAt: undefined });
    await w.mod.as.mutation(api.accessAlerts.retract, { accessAlertId, reason: 'Gone' });
    expect((await queueRows(w.t)).map((r) => [r.userId, r.kind])).toEqual([
      [w.asker.id, 'alert_retracted'],
    ]);
  });

  test('no message for an alert its author already withdrew, nor for one already over', async () => {
    const w = await world();
    // Withdrawn by its author, then a moderator's verdict recorded on it (D248): nothing is sent.
    const withdrawn = await alert(w);
    await w.asker.as.mutation(api.accessAlerts.retract, { accessAlertId: withdrawn });
    await w.mod.as.mutation(api.accessAlerts.retract, {
      accessAlertId: withdrawn,
      reason: 'A pattern of false claims',
    });
    expect(
      await w.t.run(async (ctx) =>
        (await ctx.db.query('contentVerdicts').collect()).map((v) => v.kind),
      ),
    ).toEqual(['retracted']);
    // Expired and resolved: over already, live for nobody.
    for (const status of ['expired', 'resolved'] as const) {
      const over = await alert(w, { status });
      await w.mod.as.mutation(api.accessAlerts.retract, { accessAlertId: over, reason: 'Wrong' });
      expect((await w.t.run((ctx) => ctx.db.get(over)))?.status).toBe('retracted');
    }
    expect(await queueRows(w.t)).toEqual([]);
  });
});

describe('who is never told', () => {
  test('a fake person from the dev seed: queued while real, a seed person by the flush — dropped there (D287)', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    expect(await queueRows(w.t)).toHaveLength(1);
    // The flush's own gate, whatever the enqueue saw (`recipientWants`).
    await w.t.run((ctx) => ctx.db.patch(w.asker.id, { clerkUserId: `${SEED_CLERK_PREFIX}asker` }));
    expect(await flushAllDue(w.t)).toEqual([]);
  });

  test('a fake person asking is never queued at all', async () => {
    const w = await world();
    const fake = await person(w.t, `${SEED_CLERK_PREFIX}ada`);
    const requestId = await activate(w, fake.as);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    expect(await queueRows(w.t)).toEqual([]);
  });

  test('the toggle off, or absent before the backfill, tells no one; on by default for a new profile', async () => {
    const w = await world();
    const off = await person(w.t, 'off', 'member', { ...PREFS, moderatorDecision: false });
    const { moderatorDecision: _absent, ...beforeBackfill } = PREFS;
    const absent = await person(w.t, 'absent', 'member', beforeBackfill);
    for (const who of [off, absent]) {
      const requestId = await activate(w, who.as);
      await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    }
    expect(await queueRows(w.t)).toEqual([]);

    // Onboarding writes every key from core's defaults (`upsertFromClerk`): this one on.
    const fresh = w.t.withIdentity({ subject: 'clerk_fresh' });
    await fresh.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Fresh',
      username: 'fresh',
      dateOfBirth: Date.UTC(1990, 0, 1),
      riskAckVersion: RISK_ACK_VERSION,
    });
    const profile = await fresh.query(api.profiles.current, {});
    expect(profile?.notificationPrefs.moderatorDecision).toBe(true);
  });

  test('a toggle switched off inside the window drops the queued message at the flush', async () => {
    const w = await world();
    const requestId = await activate(w);
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    await w.t.run(async (ctx) => {
      const p = await ctx.db.get(w.asker.id);
      await ctx.db.patch(w.asker.id, {
        notificationPrefs: {
          ...(p as Doc<'profiles'>).notificationPrefs,
          moderatorDecision: false,
        },
      });
    });
    expect(await flushAllDue(w.t)).toEqual([]);
  });

  test('the decider is never told their own decision, and a block on the moderator mutes nothing', async () => {
    const w = await world();
    // The self gate, at the helper every producer goes through: unreachable by a public write today
    // (no staffer decides what they filed, D289), held here in case a path ever reaches it.
    const requestId = await activate(w);
    const told = await w.t.run(async (ctx) => {
      const actionId = await ctx.db.insert('moderationActions', {
        actorId: w.admin.id,
        action: 'decline_request',
        targetType: 'waterBodyRequest',
        targetId: requestId,
        reason: 'No',
        createdAt: NOW,
      });
      return enqueueModeratorDecision(ctx, {
        recipientId: w.admin.id,
        deciderId: w.admin.id,
        trigger: { kind: 'request_decided', requestId, outcome: 'declined', actionId },
      });
    });
    expect(told).toBe(false);
    expect(await queueRows(w.t)).toEqual([]);
    // The asker blocked the moderator: the answer still arrives (the moderator is not the actor).
    await w.t.run((ctx) =>
      ctx.db.insert('blocks', { blockerId: w.asker.id, blockedId: w.admin.id, createdAt: NOW }),
    );
    await w.admin.as.mutation(api.corpusRequests.decline, { requestId, note: 'No' });
    expect(await flushAllDue(w.t)).toHaveLength(1);
  });
});

describe('the stored payload, read back', () => {
  test('only the pairs a writer gives are read; a drawing’s reason never reaches its drawer', () => {
    const read = (p: Record<string, unknown>) => parsePayload('moderator_decision', p);
    expect(
      read({ kind: 'request_decided', about: 'drawn', outcome: 'rejected', note: 'Duplicate' }),
    ).toEqual({ kind: 'request_decided', about: 'drawn', outcome: 'rejected' });
    expect(
      read({ kind: 'request_decided', about: 'restore', outcome: 'declined', note: 'No' }),
    ).toEqual({ kind: 'request_decided', about: 'restore', outcome: 'declined', note: 'No' });
    // An empty note is no note.
    expect(
      read({ kind: 'request_decided', about: 'admit', outcome: 'declined', note: '' }),
    ).toEqual({ kind: 'request_decided', about: 'admit', outcome: 'declined' });
    for (const bad of [
      { kind: 'request_decided', about: 'drawn', outcome: 'declined' },
      { kind: 'request_decided', about: 'admit', outcome: 'rejected' },
      { kind: 'request_decided', about: 'admit', outcome: 'retracted' },
      { kind: 'request_decided', about: 'photo', outcome: 'approved' },
      { kind: 'request_decided', outcome: 'approved' },
      { kind: 'alert_retracted', accessAlertId: 'a' },
      { kind: 'something_else' },
    ]) {
      expect(read(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(read({ kind: 'alert_retracted', accessAlertId: 'a', waterBodyId: 'b' })).toEqual({
      kind: 'alert_retracted',
      accessAlertId: 'a',
      waterBodyId: 'b',
    });
  });
});

describe('what it costs', () => {
  test('the settle re-check reads what the flush charges for it: the decided row and one more', () => {
    const anyId = 'x' as never;
    expect(
      settleReadCost({
        kind: 'request_decided',
        requestId: anyId,
        outcome: 'declined',
        actionId: anyId,
      }),
    ).toBe(2);
    expect(settleReadCost({ kind: 'alert_retracted', accessAlertId: anyId, actionId: anyId })).toBe(
      2,
    );
  });

  test('a decline’s drain, every asker wanting the message: each further sibling within its budget', async () => {
    const t = harness();
    await person(t, 'admin', 'admin');
    const lakeId = await lake(t, 'osm/A', 0);
    const askers: Id<'profiles'>[] = [];
    for (let i = 0; i < 30; i++) askers.push((await person(t, `q${i}`)).id);
    const few = await bayAsks(t, lakeId, askers.slice(0, 10), 'Cove');
    const many = await bayAsks(t, lakeId, askers, 'North Bay');
    await settle();
    const decline = (requestId: Id<'waterBodyRequests'> | undefined) =>
      measured(t, { requestId, note: 'No' });
    const small = await decline(few[0]);
    const large = await decline(many[0]);
    const each = {
      documentsRead: (large.documentsRead - small.documentsRead) / 20,
      databaseQueries: (large.databaseQueries - small.databaseQueries) / 20,
    };
    const row = await t.run((ctx) => ctx.db.get(many[1] as Id<'waterBodyRequests'>));
    const budget = Object.fromEntries(
      AXES.map((k) => [k, siblingCost(row as Doc<'waterBodyRequests'>)[k] + RECONCILE_COST[k]]),
    ) as TxCost;
    expect(each.documentsRead).toBeLessThanOrEqual(budget.documentsRead);
    expect(each.databaseQueries).toBeLessThanOrEqual(budget.databaseQueries);
    // Every one of them queued: the measure includes the enqueue it is meant to price.
    expect(await queueRows(t)).toHaveLength(40);
  });
});

/** `askers.length` bay asks by one name on one lake, each filed into the Inbox — one question. */
async function bayAsks(
  t: T,
  lakeId: Id<'waterBodies'>,
  askers: Id<'profiles'>[],
  name = 'North Bay',
): Promise<Id<'waterBodyRequests'>[]> {
  const ids: Id<'waterBodyRequests'>[] = [];
  for (let start = 0; start < askers.length; start += 50) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'waterBodyRequests'>[] = [];
        for (let i = start; i < Math.min(start + 50, askers.length); i++) {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: askers[i] as Id<'profiles'>,
            coord: { lat: 0.2, lng: 0.2 },
            waterBodyId: lakeId,
            name,
            nameKey: requestNameKeyFor('name_bay', name),
            createdAt: NOW - 1000 + i,
          });
          await fileMember(ctx, requestSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

/** A decline in a transaction of its own, under limits no decision reaches, and what it read. */
async function measured(
  t: T,
  args: Record<string, unknown>,
): Promise<{ documentsRead: number; databaseQueries: number }> {
  return t.withIdentity({ subject: 'admin' }).run(async (ctx) => {
    const before = await ctx.meta.getTransactionMetrics();
    await (
      ctx as unknown as { runMutation: (f: unknown, a: unknown, o: unknown) => Promise<unknown> }
    ).runMutation(api.corpusRequests.decline, args, {
      transactionLimits: {
        bytesRead: 1 << 30,
        documentsRead: 10_000_000,
        databaseQueries: 1_000_000,
        documentsWritten: 1_000_000,
      },
    });
    const after = await ctx.meta.getTransactionMetrics();
    return {
      documentsRead: before.documentsRead.remaining - after.documentsRead.remaining,
      databaseQueries: before.databaseQueries.remaining - after.databaseQueries.remaining,
    };
  });
}
