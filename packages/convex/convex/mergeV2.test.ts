/**
 * **A merge records everything an unmerge needs** (B01-5d, change set `version: 2`), and the Shape
 * tab's preview says what the merge then does.
 *
 * - One test per addition: a delisted bay's row and a folded label's row (`sideActions`), a
 *   re-clipped survivor bay (`survivorSubAreasBefore`), a partner (`dedupAfter`), a drawn loser
 *   (`loserReview`, `reviewStatus: 'merged'`, its item decided by the merge's row), a skate
 *   (`movedActivities`, fork 2).
 * - The drawer is told once, through the settle queue — and only for a person's merge of a drawing.
 * - `bodyConsole.mergePreview`'s counts equal what the merge then moves, kind by kind, over a world of
 *   every kind; its refusals are the write's.
 * - A question past the asks' cap is refused, not left behind (fork 3).
 * - From the Inbox (board 2.5): the drawing's live survivor is one function (`drawnSurvivorOf`) for
 *   the rule's fact, the item's `overlap` and `mergeDrawn`'s currency check; the backfill files a
 *   merged drawing from its own phase (`drawn:merged`) and the drift repair decides one left open;
 *   `reviewAuditOf` reads an unmerge as the latest review row. (The rule-versus-write cells for
 *   `mergeDrawn` are in `inboxRulesVsWrites.test.ts`.)
 */

import { NOTIFICATION_PREF_DEFAULTS } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { STAYS_BEHIND_CAP } from './bodyConsole';
import { BACKFILL_PHASES, reviewAuditOf } from './inboxItems';
import { readSnapshot } from './lib/audit';
import { bodySource, fileMember, flagSource, inboxBatch, requestSource } from './lib/inboxItems';
import {
  DRAWN_SURVIVOR_READ,
  drawnSurvivorOf,
  OWN_DRAWING,
  SURVIVOR_CHANGED_REFUSAL,
} from './lib/inboxRules';
import {
  baseCost,
  fitsOneTransaction,
  MERGE_FIXED,
  MERGE_TOO_BIG,
  type MergeCost,
  RETARGET_CAP,
  rowCost,
  THRESHOLDS,
} from './lib/mergeLoad';
import { UNMERGING_REFUSAL } from './lib/unmergeState';
import schema from './schema';
import type { MergeChangeSet } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

/** More launches than any merge moves — past every ceiling (time's ≈ 1,000, index ranges' ≈ 2,650). */
const TOO_MANY_LAUNCHES = 3_000;

/** `c` scaled by `n` on every axis. */
const scaled = (c: MergeCost, n: number): MergeCost =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v * n])) as MergeCost;
/** `a` and `b` summed on every axis. */
const plus = (a: MergeCost, b: MergeCost): MergeCost =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, v + b[k as keyof MergeCost]]),
  ) as MergeCost;
/** The largest `n` for which `base + f(n)` fits every threshold — `f` grows with `n` (a search). */
function largestFitting(base: MergeCost, f: (n: number) => MergeCost): number {
  let hi = 1;
  while (fitsOneTransaction(plus(base, f(hi)))) hi *= 2;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsOneTransaction(plus(base, f(mid)))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A square of half-width `r` degrees around (lng, lat). */
const square = (lng: number, lat: number, r: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng - r, lat - r],
      [lng - r, lat + r],
      [lng + r, lat + r],
      [lng + r, lat - r],
      [lng - r, lat - r],
    ],
  ],
});
const boxOf = (lng: number, lat: number, r: number) => ({
  minLat: lat - r,
  minLng: lng - r,
  maxLat: lat + r,
  maxLng: lng + r,
});
const LNG = -72;
const LAT = 44;

async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A body over the shared water: half-width `r`; a drawing is pending and filed. */
async function body(
  t: T,
  name: string,
  r: number,
  extra: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const id = (await ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: square(LNG, LAT, r),
      bbox: boxOf(LNG, LAT, r),
      centroid: { lat: LAT, lng: LNG },
      surfaceAreaSqM: 1_000_000,
      createdAt: NOW,
      ...extra,
    } as never)) as Id<'waterBodies'>;
    if (extra.source === 'user') await fileMember(ctx, bodySource(id));
    return id;
  });
}

function bay(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  name: string,
  r: number,
  by: Id<'profiles'>,
  lng = LNG,
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId,
      name,
      searchText: name,
      polygon: square(lng, LAT, r),
      bbox: boxOf(lng, LAT, r),
      centroid: { lat: LAT, lng },
      surfaceAreaSqM: 10_000,
      displayScore: 0,
      minVisibleZoom: 10,
      createdByUserId: by,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

function landmark(t: T, waterBodyId: Id<'waterBodies'>, name: string, lat = LAT) {
  return t.run((ctx) =>
    ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name,
      kind: 'island',
      point: { lat, lng: LNG },
      source: 'gnis',
      externalIds: [`gnis:${name}:${waterBodyId}`],
      aliases: [],
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

const changeSetOf = (t: T, actionId: Id<'moderationActions'>) =>
  t.run((ctx) => readSnapshot<MergeChangeSet>(ctx, actionId)) as Promise<MergeChangeSet>;

/** Staff, a skater, a survivor lake and a skater's drawing inside it. */
async function pair() {
  const t = harness();
  const mod = await person(t, 'mod', 'moderator');
  const skater = await person(t, 'skater');
  const survivor = await body(t, 'Lake Morey', 0.01);
  const loser = await body(t, 'Morey East Bay', 0.008, {
    source: 'user',
    reviewStatus: 'pending',
    createdByUserId: skater.id,
    dedupStatus: 'suspected_duplicate',
    duplicateCandidateIds: [],
  });
  await t.run((ctx) => ctx.db.patch(loser, { duplicateCandidateIds: [survivor] }));
  const merge = async () =>
    mod.as.mutation(api.waterBodies.merge, {
      survivorId: survivor,
      loserId: loser,
      reason: 'Same',
    });
  return { t, mod, skater, survivor, loser, merge };
}

describe('change set version 2 (B01-5d)', () => {
  test('a bay delisted by a name clash: its automatic row is a side action', async () => {
    const w = await pair();
    await bay(w.t, w.survivor, 'North Bay', 0.002, w.mod.id);
    const clash = await bay(w.t, w.loser, 'North Bay', 0.002, w.mod.id);
    // An older row on the same bay, by the same moderator: never mistaken for the merge's.
    await w.t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: w.mod.id,
        action: 'remove',
        targetType: 'waterBodySubArea',
        targetId: clash,
        reason: 'An earlier delist',
        createdAt: NOW - 60_000,
      }),
    );
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.version).toBe(2);
    expect(cs.subAreasDelisted).toEqual([clash]);
    const rows = await w.t.run(async (ctx) =>
      Promise.all((cs.sideActions ?? []).map((id) => ctx.db.get(id))),
    );
    expect(rows.map((r) => [r?.action, r?.targetId, r?.metadata?.automatic])).toEqual([
      ['remove', clash, true],
    ]);
  });

  test('a label folded into its twin: its row is a side action, the twin’s untouched row is not', async () => {
    const w = await pair();
    await landmark(w.t, w.survivor, 'Apple Island');
    const moved = await landmark(w.t, w.loser, 'Apple Island');
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    const rows = await w.t.run(async (ctx) =>
      Promise.all((cs.sideActions ?? []).map((id) => ctx.db.get(id))),
    );
    expect(rows.map((r) => [r?.action, r?.targetId])).toEqual([['remove', moved]]);
    expect(cs.landmarksAfter.find((a) => a.id === moved)?.removed).toBe(true);
  });

  test('a survivor label a moved bay now names is retired, and recorded as changed (R12)', async () => {
    const w = await pair();
    // The survivor's label "Heron Bay" sits in the water a moved bay of that name now holds.
    const label = await landmark(w.t, w.survivor, 'Heron Bay');
    await bay(w.t, w.loser, 'Heron Bay', 0.002, w.mod.id);
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.landmarksAfter.find((a) => a.id === label)).toMatchObject({ removed: true });
    const rows = await w.t.run(async (ctx) =>
      Promise.all((cs.sideActions ?? []).map((id) => ctx.db.get(id))),
    );
    expect(rows.map((r) => [r?.action, r?.targetId])).toContainEqual(['promote_landmark', label]);
  });

  test('a moved report’s bay joins follow it to the survivor, read once a bay (R12)', async () => {
    const w = await pair();
    const west = await bay(w.t, w.loser, 'West Bay', 0.002, w.mod.id, LNG - 0.004);
    const east = await bay(w.t, w.loser, 'East Bay', 0.002, w.mod.id, LNG + 0.004);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        const reportId = await ctx.db.insert('reports', {
          authorId: w.skater.id,
          waterBodyId: w.loser,
          subAreaIds: [west, east],
          point: { lat: LAT, lng: LNG },
          skateEndTime: NOW - i,
          reportTime: NOW,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: NOW,
          updatedAt: NOW,
        } as never);
        for (const subAreaId of [west, east]) {
          await ctx.db.insert('reportSubAreas', {
            reportId,
            subAreaId,
            waterBodyId: w.loser,
            moderationStatus: 'visible',
            skateEndTime: NOW - i,
          });
        }
      }
    });
    await w.merge();
    const joins = await w.t.run((ctx) => ctx.db.query('reportSubAreas').collect());
    expect(joins).toHaveLength(6);
    expect(joins.every((j) => j.waterBodyId === w.survivor)).toBe(true);
  });

  test('a survivor bay the re-clip changed is kept as it stood; an untouched one is not', async () => {
    const w = await pair();
    // Half outside the survivor's water: the re-clip cuts it to the shore.
    const straddling = await bay(w.t, w.survivor, 'Outer Bay', 0.003, w.mod.id, LNG + 0.008);
    await bay(w.t, w.survivor, 'Inner Bay', 0.002, w.mod.id);
    const before = await w.t.run((ctx) => ctx.db.get(straddling));
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.survivorSubAreasBefore?.map((b) => b.id)).toEqual([straddling]);
    expect(cs.survivorSubAreasBefore?.[0]?.polygon).toEqual(before?.polygon);
    const after = await w.t.run((ctx) => ctx.db.get(straddling));
    expect(after?.polygon).not.toEqual(before?.polygon);
  });

  test('a partner: its flag before and as the merge left it', async () => {
    const w = await pair();
    const partner = await body(w.t, 'Morey Twin', 0.01, {
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: [w.loser],
    });
    await w.t.run((ctx) => ctx.db.patch(w.loser, { duplicateCandidateIds: [w.survivor, partner] }));
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    const p = (list: MergeChangeSet['dedupBefore'] | undefined) =>
      list?.find((d) => d.id === partner);
    expect(p(cs.dedupBefore)).toMatchObject({
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: [w.loser],
    });
    const now = await w.t.run((ctx) => ctx.db.get(partner));
    expect(p(cs.dedupAfter)).toEqual({
      id: partner,
      dedupStatus: now?.dedupStatus,
      duplicateCandidateIds: now?.duplicateCandidateIds ?? null,
      mergedIntoId: null,
    });
    expect(p(cs.dedupAfter)).not.toEqual(p(cs.dedupBefore));
  });

  test('a drawn loser: merged in review, its item decided by the merge’s row, the drawer told once', async () => {
    const w = await pair();
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.loserReview).toEqual({ reviewStatus: 'pending', decidedItem: true });
    const state = await w.t.run(async (ctx) => {
      const member = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'waterBodies').eq('sourceId', w.loser))
        .first();
      return {
        loser: await ctx.db.get(w.loser),
        member,
        item: member ? await ctx.db.get(member.itemId) : null,
        queue: await ctx.db.query('notificationQueue').collect(),
      };
    });
    expect(state.loser).toMatchObject({ reviewStatus: 'merged', dedupStatus: 'merged' });
    expect(state.member).toMatchObject({ status: 'closed', closedByActionId: actionId });
    expect(state.item).toMatchObject({ status: 'decided', decision: 'merged' });
    expect(state.item?.decisionActionId).toBe(actionId);
    expect(state.queue.map((q) => [q.userId, q.trigger])).toEqual([
      [w.skater.id, { kind: 'request_decided', waterBodyId: w.loser, outcome: 'merged', actionId }],
    ]);
  });

  test('a catalog loser keeps its review status and tells no one; nor does the ETL’s merge of a drawing', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const skater = await person(t, 'skater');
    const survivor = await body(t, 'Lake', 0.01);
    const catalog = await body(t, 'Lake again', 0.01);
    const { actionId } = await mod.as.mutation(api.waterBodies.merge, {
      survivorId: survivor,
      loserId: catalog,
    });
    expect((await changeSetOf(t, actionId)).loserReview).toEqual({
      reviewStatus: null,
      decidedItem: false,
    });
    expect((await t.run((ctx) => ctx.db.get(catalog)))?.reviewStatus).toBeUndefined();
    // The ETL's path: `mergeBodyInto` with no actor — the drawing is decided, nobody is owed word.
    const drawing = await body(t, 'Drawn', 0.005, {
      source: 'user',
      reviewStatus: 'pending',
      createdByUserId: skater.id,
    });
    await t.run(async (ctx) => {
      const { mergeBodyInto } = await import('./waterBodies');
      const [s, l] = [await ctx.db.get(survivor), await ctx.db.get(drawing)];
      await mergeBodyInto(ctx, { survivor: s as never, loser: l as never, reason: 'ETL' });
    });
    expect((await t.run((ctx) => ctx.db.get(drawing)))?.reviewStatus).toBe('merged');
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test('a skate on the loser moves, both its body fields recorded', async () => {
    const w = await pair();
    const other = await body(w.t, 'Elsewhere', 0.001, { centroid: { lat: 45, lng: -71 } });
    const skate = await w.t.run((ctx) =>
      ctx.db.insert('gpsActivities', {
        userId: w.skater.id,
        provider: 'native',
        providerActivityId: 'founding',
        sportType: 'IceSkate',
        startTime: NOW - 3_600_000,
        detectedAt: NOW,
        promptState: 'converted',
        waterBodyId: w.loser,
        waterBodyIds: [w.loser, other, w.survivor],
      }),
    );
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.movedActivities).toEqual([
      { id: skate, waterBodyId: w.loser, waterBodyIds: [w.loser, other, w.survivor] },
    ]);
    const after = await w.t.run((ctx) => ctx.db.get(skate));
    expect(after?.waterBodyId).toBe(w.survivor);
    // The loser became the survivor once — never listed twice.
    expect(after?.waterBodyIds).toEqual([w.survivor, other]);
  });
});

describe('the merge’s refusals (fork 3)', () => {
  test('a question past the asks’ cap is refused, preview and write alike, and nothing moves', async () => {
    const w = await pair();
    await w.t.run(async (ctx) => {
      for (let i = 0; i <= RETARGET_CAP; i++) {
        await ctx.db.insert('waterBodyRequests', {
          kind: 'activate',
          status: 'declined',
          requesterId: w.skater.id,
          coord: { lat: LAT, lng: LNG },
          waterBodyId: w.loser,
          createdAt: NOW,
        });
      }
    });
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    expect(preview).toMatchObject({
      ok: true,
      tooBig: true,
      refusal: MERGE_TOO_BIG,
      code: 'tooBig',
    });
    const err = await w.merge().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    // The sentence, with its code (R10-D): a Drawn lever's `can` never asks the weight.
    expect((err as ConvexError<{ message: string; code: string }>).data).toEqual({
      message: MERGE_TOO_BIG,
      code: 'tooBig',
    });
    expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.dedupStatus).toBe('suspected_duplicate');
    // The ETL's path asks no preview: the merge itself refuses the group past the cap.
    const etl = await w.t
      .run(async (ctx) => {
        const { mergeBodyInto } = await import('./waterBodies');
        const [s, l] = [await ctx.db.get(w.survivor), await ctx.db.get(w.loser)];
        await mergeBodyInto(ctx, { survivor: s as never, loser: l as never, reason: 'ETL' });
      })
      .catch((e: unknown) => e);
    expect((etl as ConvexError<string>).data).toBe(MERGE_TOO_BIG);
  });

  test('more launches than a merge moves: refused, preview and write alike', async () => {
    const w = await pair();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < TOO_MANY_LAUNCHES; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: w.loser,
          coord: { lat: LAT, lng: LNG },
          source: 'osm',
          status: 'visible',
          createdAt: NOW,
        });
      }
    });
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    if (!preview.ok) throw new Error(preview.refusal);
    expect(preview.moves.putIns.capped).toBe(true);
    expect(preview.moves.putIns.count).toBeLessThan(TOO_MANY_LAUNCHES);
    expect(preview).toMatchObject({ tooBig: true, code: 'tooBig' });
    // The kinds after the one that stopped the count were never read: said to be cut, not zeroed —
    // and the ones before it, read whole, still split exactly.
    expect(preview.favoritesDeduped).toEqual({ count: 0, capped: true });
    expect(preview.baysClashing).toEqual({ names: [], capped: true });
    expect(preview.moves.flags.capped).toBe(false);
    await expect(w.merge()).rejects.toThrow(MERGE_TOO_BIG);
    // From the Inbox: the lever's can never asks the weight, so the write's refusal carries the code
    // the web needs to say it properly (R10-D).
    const { item } = await w.mod.as.query(api.inbox.item, { ref: `body:${w.loser}` });
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(item.can.mergeDrawn).toBeNull();
    const err = await w.mod.as
      .mutation(api.inboxWrites.mergeDrawn, { itemId: item.itemId, survivorId: w.survivor })
      .catch((e: unknown) => e);
    expect((err as ConvexError<{ message: string; code: string }>).data).toEqual({
      message: MERGE_TOO_BIG,
      code: 'tooBig',
    });
  });

  test('what stays behind is counted to its cap, and one row past it says the count is a floor', async () => {
    const w = await pair();
    const stays = async (alerts: number, lots: number) => {
      await w.t.run(async (ctx) => {
        const putInId = await ctx.db.insert('putIns', {
          waterBodyId: w.survivor,
          coord: { lat: LAT, lng: LNG },
          source: 'osm',
          status: 'visible',
          createdAt: NOW,
        });
        const parkingAreaId = await ctx.db.insert('parkingAreas', {
          coord: { lat: LAT, lng: LNG },
          source: 'osm',
          status: 'visible',
          amenities: [],
          createdAt: NOW,
        });
        for (let i = 0; i < alerts; i++) {
          await ctx.db.insert('accessAlerts', {
            targetType: 'put_in',
            putInId,
            waterBodyId: w.loser,
            reason: 'not_plowed',
            kind: 'blocker',
            createdByUserId: w.skater.id,
            createdAt: NOW,
            season: 2025,
            status: 'expired',
            confirmCount: 0,
            denyCount: 0,
          } as never);
        }
        for (let i = 0; i < lots; i++) {
          await ctx.db.insert('parkingAreaBodies', {
            parkingAreaId,
            waterBodyId: w.loser,
            inferred: true,
            createdAt: NOW,
          });
        }
      });
      const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
        loserId: w.loser,
        survivorId: w.survivor,
      });
      if (!preview.ok) throw new Error(preview.refusal);
      return preview.staysBehind;
    };
    // At the cap: exact.
    expect(await stays(STAYS_BEHIND_CAP, STAYS_BEHIND_CAP)).toEqual({
      accessAlerts: { count: STAYS_BEHIND_CAP, capped: false },
      parkingLots: { count: STAYS_BEHIND_CAP, capped: false },
    });
    // One past it: the count stops at the cap and says it is a floor.
    expect(await stays(1, 1)).toEqual({
      accessAlerts: { count: STAYS_BEHIND_CAP, capped: true },
      parkingLots: { count: STAYS_BEHIND_CAP, capped: true },
    });
  });

  test('the drawer never merges their own drawing (D289): one sentence and code on both entry points', async () => {
    const w = await pair();
    // Drawn by the moderator, so the Inbox's member names them as its filer.
    const own = await body(w.t, 'Mine', 0.005, {
      source: 'user',
      reviewStatus: 'pending',
      createdByUserId: w.mod.id,
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: [w.survivor],
    });
    const said = { refusal: OWN_DRAWING.refusal, code: OWN_DRAWING.code };
    // The Shape tab's read, from the drawer's seat.
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: own,
      survivorId: w.survivor,
    });
    expect(preview).toEqual({ ok: false, ...said });
    // The Inbox's read, from the same seat: the lever's refusal and its code.
    const { item } = await w.mod.as.query(api.inbox.item, { ref: `body:${own}` });
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    expect({ refusal: item.can.mergeDrawn, code: item.canCode.mergeDrawn }).toEqual(said);
    // Both writes refuse it in the same words.
    await expect(
      w.mod.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: own }),
    ).rejects.toThrow(said.refusal);
    await expect(
      w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
        itemId: item.itemId,
        survivorId: w.survivor,
      }),
    ).rejects.toThrow(said.refusal);
    // Another moderator's seat: offered, with no code.
    const other = await person(w.t, 'other', 'moderator');
    const theirs = await other.as.query(api.inbox.item, { ref: `body:${own}` });
    if (theirs.item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(theirs.item.can.mergeDrawn).toBeNull();
    expect(theirs.item.canCode).toEqual({});
  });

  test('a merge waits while an unmerge runs on either body: the preview, can and the writes agree', async () => {
    const w = await pair();
    const unmergeId = await w.t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: w.mod.id,
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: w.loser,
        reason: 'Two lakes',
        metadata: { done: false },
        createdAt: NOW,
      }),
    );
    const said = { refusal: UNMERGING_REFUSAL, code: 'unmerging' };
    for (const marked of [w.loser, w.survivor]) {
      await w.t.run(async (ctx) => {
        await ctx.db.patch(w.loser, { unmergeActionId: undefined });
        await ctx.db.patch(w.survivor, { unmergeActionId: undefined });
        await ctx.db.patch(marked, { unmergeActionId: unmergeId });
      });
      expect(
        await w.mod.as.query(api.bodyConsole.mergePreview, {
          loserId: w.loser,
          survivorId: w.survivor,
        }),
      ).toEqual({ ok: false, ...said });
      const { item } = await w.mod.as.query(api.inbox.item, { ref: `body:${w.loser}` });
      if (item?.kind !== 'drawn') throw new Error('no drawn item');
      expect({ refusal: item.can.mergeDrawn, code: item.canCode.mergeDrawn }).toEqual(said);
      await expect(w.merge()).rejects.toThrow(UNMERGING_REFUSAL);
      await expect(
        w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
          itemId: item.itemId,
          survivorId: w.survivor,
        }),
      ).rejects.toThrow(UNMERGING_REFUSAL);
    }
    // Done: the marker gone, the merge offered and taken.
    await w.t.run((ctx) => ctx.db.patch(w.survivor, { unmergeActionId: undefined }));
    await w.merge();
  });

  test('every refusal the write gives, the preview gives in its words', async () => {
    const w = await pair();
    const member = await person(w.t, 'member');
    const read = (loserId: Id<'waterBodies'>, survivorId: Id<'waterBodies'>, as = w.mod.as) =>
      as.query(api.bodyConsole.mergePreview, { loserId, survivorId });
    const write = (loserId: Id<'waterBodies'>, survivorId: Id<'waterBodies'>) =>
      w.mod.as
        .mutation(api.waterBodies.merge, { loserId, survivorId })
        .then(() => null)
        .catch((e: ConvexError<string>) => e.data);
    expect(await read(w.loser, w.loser)).toEqual({
      ok: false,
      refusal: await write(w.loser, w.loser),
      code: 'sameBody',
    });
    // A survivor merged away, and a loser merged already.
    const gone = await body(w.t, 'Gone', 0.01);
    await w.mod.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: gone });
    expect(await read(w.loser, gone)).toEqual({
      ok: false,
      refusal: await write(w.loser, gone),
      code: 'survivorMerged',
    });
    expect(await read(gone, w.survivor)).toEqual({
      ok: false,
      refusal: await write(gone, w.survivor),
      code: 'loserMerged',
    });
    // A body gone altogether.
    const deleted = await body(w.t, 'Deleted', 0.01);
    await w.t.run((ctx) => ctx.db.delete(deleted));
    expect(await read(w.loser, deleted)).toEqual({
      ok: false,
      refusal: await write(w.loser, deleted),
      code: 'gone',
    });
    // The lists together over a cap.
    const links = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        label: `${tag}${i}`,
        url: `https://e.org/${tag}/${i}`,
      }));
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.survivor, { referenceLinks: links(5, 's') });
      await ctx.db.patch(w.loser, { referenceLinks: links(5, 'l') });
    });
    const lists = await write(w.loser, w.survivor);
    expect(lists).toMatch(/links/);
    expect(await read(w.loser, w.survivor)).toEqual({
      ok: false,
      refusal: lists,
      code: 'listsOverCap',
    });
    // A viewer without the merge's capability: refused in `requireCapability`'s words.
    await expect(read(w.loser, w.survivor, member.as)).rejects.toThrow(/Requires/);
  });
});

/** `n` people outside the pair, `tag`-named. */
async function crowd(t: T, n: number, tag: string): Promise<Id<'profiles'>[]> {
  return t.run(async (ctx) => {
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert('profiles', {
          clerkUserId: `${tag}${i}`,
          displayName: `${tag}${i} Test-Person`,
          username: `${tag}${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: NOW,
        }),
      );
    }
    return ids;
  });
}

/** `n` rows inserted by `make`, `CHUNK` a transaction, so the fixture never meets the limits itself. */
async function inChunks(t: T, n: number, make: (ctx: MutationCtx, i: number) => Promise<unknown>) {
  const CHUNK = 100;
  for (let from = 0; from < n; from += CHUNK) {
    // One Inbox batch a chunk, as a writer files many: each item recounted once, at its end.
    await t.run((ctx) =>
      inboxBatch(ctx, async () => {
        for (let i = from; i < Math.min(n, from + CHUNK); i++) await make(ctx, i);
      }),
    );
  }
}

/**
 * **A busy survivor** (Greptile on #173): `n` rows of every kind the merge reads beside but doesn't
 * move. On the survivor, from people outside the pair: open flags (filed into the survivor's access
 * item, so a moved flag joins an item of `n` members), closed flags, favorites, open asks (filed), open
 * place names, recent reports, active hazards, open bounties, launches, skates and live landmarks. On
 * the loser, its rows the merge leaves: closed flags, placed and dismissed names, and access alerts.
 * A read or estimate that scans the survivor's rows — once, or once per loser row — reads thousands
 * of documents here; one that reads by the loser's rows and point reads reads none of them.
 */
async function busy(t: T, survivor: Id<'waterBodies'>, loser: Id<'waterBodies'>, n: number) {
  const others = await crowd(t, n, `busy-${survivor}-`);
  const who = (i: number) => others[i] as Id<'profiles'>;
  const flag = (targetId: Id<'waterBodies'>, i: number, status: Doc<'contentFlags'>['status']) => ({
    flaggerId: who(i),
    targetType: 'waterbody' as const,
    targetId,
    reason: 'no_public_access' as const,
    status,
    createdAt: NOW,
  });
  await inChunks(t, n, async (ctx, i) => {
    await fileMember(
      ctx,
      flagSource(await ctx.db.insert('contentFlags', flag(survivor, i, 'open'))),
    );
    await ctx.db.insert('contentFlags', { ...flag(survivor, i, 'dismissed'), reason: 'spam' });
    await ctx.db.insert('contentFlags', flag(loser, i, i % 2 === 0 ? 'actioned' : 'dismissed'));
  });
  await inChunks(t, n, async (ctx, i) => {
    await ctx.db.insert('waterBodyFavorites', {
      userId: who(i),
      waterBodyId: survivor,
      createdAt: NOW,
    });
    await fileMember(
      ctx,
      requestSource(
        await ctx.db.insert('waterBodyRequests', {
          kind: 'activate',
          status: 'open',
          requesterId: who(i),
          coord: { lat: LAT + i * 1e-6, lng: LNG },
          waterBodyId: survivor,
          createdAt: NOW,
        }),
      ),
    );
    for (const [waterBodyId, status] of [
      [survivor, 'open'],
      [loser, i % 2 === 0 ? 'placed' : 'dismissed'],
    ] as const) {
      await ctx.db.insert('corpusPlaceNames', {
        name: `Busy Point ${i}`,
        askKey: `busy point ${i}`,
        aliases: [],
        messages: 1,
        skatedMessages: 0,
        states: ['VT'],
        waterBodyId,
        status,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  });
  await inChunks(t, n, async (ctx, i) => {
    await ctx.db.insert('reports', {
      authorId: who(i),
      waterBodyId: survivor,
      point: { lat: LAT, lng: LNG },
      skateEndTime: NOW - i,
      reportTime: NOW,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert('hazards', {
      waterBodyId: survivor,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [LNG, LAT] },
      radiusMeters: 30,
      bbox: boxOf(LNG, LAT, 0.001),
      createdByUserId: who(i),
      photoIds: [],
      status: 'active',
      moderationStatus: 'visible',
      firstReportedAt: NOW,
      lastConfirmedAt: NOW,
      confirmCount: 0,
      goneCount: 0,
      createdAt: NOW,
    });
    await ctx.db.insert('bounties', {
      requesterId: who(i),
      waterBodyId: survivor,
      windowHours: 48,
      status: 'open',
      rewardPoints: 10,
      fulfillingReportIds: [],
      createdAt: NOW,
      expiresAt: NOW + 1000,
    });
  });
  await inChunks(t, n, async (ctx, i) => {
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId: survivor,
      coord: { lat: LAT, lng: LNG },
      source: 'osm',
      status: 'visible',
      createdAt: NOW,
    });
    await ctx.db.insert('gpsActivities', {
      userId: who(i),
      provider: 'native',
      providerActivityId: `busy-${i}`,
      sportType: 'IceSkate',
      startTime: NOW - 3_600_000,
      detectedAt: NOW,
      promptState: 'converted',
      waterBodyId: survivor,
    });
    await ctx.db.insert('bodyLandmarks', {
      waterBodyId: survivor,
      name: `Busy Isle ${i}`,
      kind: 'island',
      point: { lat: LAT + 0.004 + i * 1e-6, lng: LNG },
      source: 'gnis',
      externalIds: [`gnis:busy:${i}`],
      aliases: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert('accessAlerts', {
      targetType: 'put_in',
      putInId,
      waterBodyId: loser,
      reason: 'not_plowed',
      kind: 'blocker',
      createdByUserId: who(i),
      createdAt: NOW,
      season: 2025,
      status: 'expired',
      confirmCount: 0,
      denyCount: 0,
    } as never);
  });
}

/**
 * A world of every kind a merge moves; the preview's counts and splits, then the merge, compared kind
 * by kind. `busyRows`: over a {@link busy} survivor and loser too — the counts the same, every read
 * inside the harness's limits.
 */
async function everyKind(busyRows = 0) {
  const w = await pair();
  if (busyRows > 0) await busy(w.t, w.survivor, w.loser, busyRows);
  const { t, loser, survivor, skater, mod } = w;
  const both = await person(t, 'both');
  const twice = await person(t, 'twice');
  await bay(t, survivor, 'North Bay', 0.002, mod.id);
  await bay(t, loser, 'North Bay', 0.002, mod.id);
  await bay(t, loser, 'Cove', 0.001, mod.id, LNG - 0.004);
  await landmark(t, survivor, 'Apple Island');
  await landmark(t, loser, 'Apple Island');
  await landmark(t, loser, 'Gull Rock', LAT + 0.003);
  await t.run(async (ctx) => {
    await ctx.db.insert('reports', {
      authorId: skater.id,
      waterBodyId: loser,
      point: { lat: LAT, lng: LNG },
      skateEndTime: NOW,
      reportTime: NOW,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert('hazards', {
      waterBodyId: loser,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [LNG, LAT] },
      radiusMeters: 30,
      bbox: boxOf(LNG, LAT, 0.001),
      createdByUserId: skater.id,
      photoIds: [],
      status: 'active',
      moderationStatus: 'visible',
      firstReportedAt: NOW,
      lastConfirmedAt: NOW,
      confirmCount: 0,
      goneCount: 0,
      createdAt: NOW,
    });
    await ctx.db.insert('bounties', {
      requesterId: skater.id,
      waterBodyId: loser,
      windowHours: 48,
      status: 'open',
      rewardPoints: 10,
      fulfillingReportIds: [],
      createdAt: NOW,
      expiresAt: NOW + 1000,
    });
    await ctx.db.insert('bodyFeatures', {
      waterBodyId: loser,
      type: 'spring_current',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [LNG, LAT] },
      radiusMeters: 20,
      bbox: boxOf(LNG, LAT, 0.001),
      addedByUserId: mod.id,
      active: true,
      createdAt: NOW,
    });
    await ctx.db.insert('putIns', {
      waterBodyId: loser,
      coord: { lat: LAT, lng: LNG },
      source: 'osm',
      status: 'visible',
      createdAt: NOW,
    });
    // One person favorites the drawing only; another favorites both (dropped, not moved).
    await ctx.db.insert('waterBodyFavorites', {
      userId: skater.id,
      waterBodyId: loser,
      createdAt: NOW,
    });
    await ctx.db.insert('waterBodyFavorites', {
      userId: both.id,
      waterBodyId: loser,
      createdAt: NOW,
    });
    await ctx.db.insert('waterBodyFavorites', {
      userId: both.id,
      waterBodyId: survivor,
      createdAt: NOW,
    });
    await ctx.db.insert('waterBodyRequests', {
      kind: 'contest_access',
      status: 'open',
      requesterId: skater.id,
      coord: { lat: LAT, lng: LNG },
      waterBodyId: loser,
      createdAt: NOW,
    });
    await ctx.db.insert('corpusPlaceNames', {
      name: 'The Narrows',
      askKey: 'the narrows',
      aliases: [],
      messages: 3,
      skatedMessages: 1,
      states: ['VT'],
      waterBodyId: loser,
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
    });
    // A flag that moves, and one whose flagger already flagged the survivor (it stays).
    for (const [flaggerId, targetId] of [
      [skater.id, loser],
      [twice.id, survivor],
      [twice.id, loser],
    ] as const) {
      await ctx.db.insert('contentFlags', {
        flaggerId,
        targetType: 'waterbody',
        targetId,
        reason: 'no_public_access',
        status: 'open',
        createdAt: NOW,
      });
    }
    await ctx.db.insert('gpsActivities', {
      userId: skater.id,
      provider: 'native',
      providerActivityId: 'founding',
      sportType: 'IceSkate',
      startTime: NOW - 3_600_000,
      detectedAt: NOW,
      promptState: 'converted',
      waterBodyId: loser,
    });
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId: survivor,
      coord: { lat: LAT, lng: LNG },
      source: 'osm',
      status: 'visible',
      createdAt: NOW,
    });
    // An alert stays where it was raised (fork 2: alerts and lots don't move in this PR).
    await ctx.db.insert('accessAlerts', {
      targetType: 'put_in',
      putInId,
      waterBodyId: loser,
      reason: 'not_plowed',
      kind: 'blocker',
      createdByUserId: skater.id,
      createdAt: NOW,
      season: 2025,
      status: 'expired',
      confirmCount: 0,
      denyCount: 0,
    } as never);
  });
  const preview = await mod.as.query(api.bodyConsole.mergePreview, {
    loserId: loser,
    survivorId: survivor,
  });
  if (!preview.ok) throw new Error(preview.refusal);
  const { actionId } = await w.merge();
  const cs = await changeSetOf(t, actionId);
  const moved = (table: MergeChangeSet['moved'][number]['table']) =>
    cs.moved.filter((m) => m.table === table).length;
  const audit = await t.run((ctx) => ctx.db.get(actionId));
  const repointed = audit?.metadata?.repointed as Record<string, number>;
  const counted = Object.fromEntries(Object.entries(preview.moves).map(([k, c]) => [k, c.count]));
  expect(counted).toEqual({
    reports: moved('reports'),
    hazards: moved('hazards'),
    bounties: moved('bounties'),
    bodyFeatures: moved('bodyFeatures'),
    putIns: moved('putIns'),
    favorites: moved('waterBodyFavorites'),
    requests: moved('waterBodyRequests'),
    placeNames: moved('corpusPlaceNames'),
    flags: moved('contentFlags'),
    subAreas: cs.subAreasBefore.length,
    landmarks: repointed.landmarks,
    gpsActivities: cs.movedActivities?.length,
  });
  // Every kind is in the world, so a count can't agree by both being zero.
  expect(Object.values(counted).every((n) => n > 0)).toBe(true);
  expect(Object.values(preview.moves).some((c) => c.capped)).toBe(false);
  expect(preview.favoritesDeduped).toEqual({ count: cs.deletedFavorites.length, capped: false });
  expect(preview.favoritesDeduped.count).toBe(1);
  expect(preview.baysClashing).toEqual({ names: ['North Bay'], capped: false });
  expect(cs.subAreasDelisted).toHaveLength(1);
  const alerts = 1 + busyRows;
  expect(preview.staysBehind).toEqual({
    accessAlerts: { count: Math.min(alerts, STAYS_BEHIND_CAP), capped: alerts > STAYS_BEHIND_CAP },
    parkingLots: { count: 0, capped: false },
  });
  expect(preview).toMatchObject({ tooBig: false, refusal: null, code: null });
  expect(preview.lists.caps).toEqual({ pins: 8, aliases: 20, links: 8 });
}

describe('the preview says what the merge moves', () => {
  test('every kind, counted before, equals what the merge moved', () => everyKind());

  test(
    'over a busy survivor and loser: the same counts, every read inside its limits',
    () => everyKind(400),
    600_000,
  );
});

/** A survivor lake, a second lake over the same water, and a drawing whose candidates are both. */
async function twoCandidates() {
  const w = await pair();
  const twin = await body(w.t, 'Lake Morey (twin)', 0.01);
  await w.t.run((ctx) => ctx.db.patch(w.loser, { duplicateCandidateIds: [twin, w.survivor] }));
  return { ...w, twin };
}

const itemOf = async (w: Awaited<ReturnType<typeof pair>>) =>
  w.mod.as.query(api.inbox.item, { ref: `body:${w.loser}` });

describe('the drawing’s live survivor (one function)', () => {
  const doc = (id: string, extra: Partial<Doc<'waterBodies'>> = {}) =>
    ({
      _id: id,
      dedupStatus: 'clean',
      polygon: {
        type: 'Polygon',
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
      ...extra,
    }) as unknown as Doc<'waterBodies'>;
  const drawing = (candidates: string[]) =>
    ({
      ...doc('d'),
      duplicateCandidateIds: candidates,
    }) as unknown as Doc<'waterBodies'>;

  test('the first candidate neither merged nor gone, with the drawing’s share inside it', async () => {
    const bodies = new Map<string, Doc<'waterBodies'>>([
      ['merged', doc('merged', { dedupStatus: 'merged', mergedIntoId: 'live' as never })],
      ['pointing', doc('pointing', { mergedIntoId: 'live' as never })],
      ['live', doc('live')],
      ['later', doc('later')],
    ]);
    const get = async (id: Id<'waterBodies'>) => bodies.get(id) ?? null;
    const found = await drawnSurvivorOf(
      drawing(['gone', 'merged', 'pointing', 'd', 'live', 'later']),
      get,
    );
    expect(found?.survivor._id).toBe('live');
    expect(found).toMatchObject({ share: 1, suggested: true });
    expect(await drawnSurvivorOf(drawing(['gone', 'merged']), get)).toBeNull();
    expect(await drawnSurvivorOf(drawing([]), get)).toBeNull();
    // Past the read's bound a live candidate isn't looked for.
    const far = [...Array.from({ length: DRAWN_SURVIVOR_READ }, () => 'gone'), 'live'];
    expect(await drawnSurvivorOf(drawing(far), get)).toBeNull();
    // An outline that can't be measured: no merge to offer.
    bodies.set('flat', doc('flat', { polygon: undefined as never }));
    expect(await drawnSurvivorOf(drawing(['flat']), get)).toBeNull();
  });

  test('a tombstoned first candidate: the item, its can and the write all name the next', async () => {
    const w = await twoCandidates();
    await w.mod.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: w.twin });
    const { item } = await itemOf(w);
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(item.overlap?.body.waterBodyId).toBe(w.survivor);
    expect(item.can.mergeDrawn).toBeNull();
    expect(item.canCode).toEqual({});
    const result = await w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
      itemId: item.itemId,
      survivorId: w.survivor,
    });
    expect(result).toMatchObject({ itemId: item.itemId, flagsClosed: 0, survivorId: w.survivor });
    expect(typeof result.undoable).toBe('boolean');
    const row = await w.t.run((ctx) => ctx.db.get(result.actionId));
    expect(row).toMatchObject({ action: 'merge_waterbody', targetId: w.loser });
    expect(row?.metadata?.survivorId).toBe(w.survivor);
    expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.mergedIntoId).toBe(w.survivor);
  });

  test('a gone candidate is passed over too; none live, and the merge is neither drawn nor written', async () => {
    const w = await twoCandidates();
    await w.t.run((ctx) => ctx.db.delete(w.twin));
    const first = await itemOf(w);
    if (first.item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(first.item.overlap?.body.waterBodyId).toBe(w.survivor);
    await w.t.run((ctx) => ctx.db.delete(w.survivor));
    const { item } = await itemOf(w);
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(item.overlap).toBeNull();
    expect(item.can).not.toHaveProperty('mergeDrawn');
    await expect(
      w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
        itemId: item.itemId,
        survivorId: w.survivor,
      }),
    ).rejects.toThrow('This drawing overlaps no known body.');
  });
});

describe('inboxWrites.mergeDrawn', () => {
  test('a survivor the bar no longer shows is refused, and nothing moves; the one it shows now merges', async () => {
    const w = await twoCandidates();
    const { item } = await itemOf(w);
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    const shown = item.overlap?.body.waterBodyId as Id<'waterBodies'>;
    expect(shown).toBe(w.twin);
    // Another moderator merges the twin away while the page is open.
    await w.mod.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: w.twin });
    const err = await w.mod.as
      .mutation(api.inboxWrites.mergeDrawn, { itemId: item.itemId, survivorId: shown })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<string>).data).toBe(SURVIVOR_CHANGED_REFUSAL);
    expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.reviewStatus).toBe('pending');
    await w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
      itemId: item.itemId,
      survivorId: w.survivor,
      reason: 'The same east bay',
    });
    const loser = await w.t.run((ctx) => ctx.db.get(w.loser));
    expect(loser).toMatchObject({ reviewStatus: 'merged', mergedIntoId: w.survivor });
  });

  test('an item that isn’t a drawing is refused in plain words', async () => {
    const w = await pair();
    const ticketId = await w.skater.as.mutation(api.support.create, { category: 'bug', body: 'x' });
    const item = await w.t.run(async (ctx) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) =>
          q.eq('sourceTable', 'supportTickets').eq('sourceId', ticketId),
        )
        .first(),
    );
    await expect(
      w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
        itemId: item?.itemId as Id<'inboxItems'>,
        survivorId: w.survivor,
      }),
    ).rejects.toThrow('This item is not a drawn body.');
  });
});

describe('the backfill and the repair (drawn:merged)', () => {
  test('a merged drawing is filed decided from its own phase, dated by its merge row', async () => {
    expect(BACKFILL_PHASES).toContain('drawn:merged');
    const w = await pair();
    // Merged before the Inbox's items existed: no member, the merge's row and the review status.
    const at = NOW - 86_400_000;
    await w.t.run(async (ctx) => {
      for (const m of await ctx.db.query('inboxItemMembers').collect()) await ctx.db.delete(m._id);
      for (const i of await ctx.db.query('inboxItems').collect()) await ctx.db.delete(i._id);
      for (const c of await ctx.db.query('inboxCounts').collect()) await ctx.db.delete(c._id);
      await ctx.db.patch(w.loser, {
        reviewStatus: 'merged',
        dedupStatus: 'merged',
        mergedIntoId: w.survivor,
      });
      await ctx.db.insert('moderationActions', {
        actorId: w.mod.id,
        action: 'merge_waterbody',
        targetType: 'waterbody',
        targetId: w.loser,
        reason: 'Same',
        createdAt: at,
      });
    });
    for (let pass = 0; pass < 100; pass++) {
      if ((await w.t.mutation(internal.inboxItems.backfill, {})).done) break;
    }
    const item = await w.t.run(async (ctx) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_key', (q) => q.eq('key', `drawn:${w.loser}`))
        .first(),
    );
    expect(item).toMatchObject({ status: 'decided', decision: 'merged', decidedAt: at });
  });

  test('an item a merge left open is decided by the drift repair', async () => {
    const w = await pair();
    // The tombstone written with no Inbox hook — the drift the repair exists for.
    await w.t.run((ctx) =>
      ctx.db.patch(w.loser, {
        reviewStatus: 'merged',
        dedupStatus: 'merged',
        mergedIntoId: w.survivor,
      }),
    );
    const open = await w.t.run((ctx) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_key', (q) => q.eq('key', `drawn:${w.loser}`).eq('status', 'open'))
        .first(),
    );
    expect(open).not.toBeNull();
    await w.t.mutation(internal.inboxItems.repair, {});
    const after = await w.t.run((ctx) => ctx.db.get(open?._id as Id<'inboxItems'>));
    expect(after).toMatchObject({ status: 'decided', decision: 'merged' });
  });

  test('reviewAuditOf reads an unmerge as the latest review row', async () => {
    const w = await pair();
    const row = (action: Doc<'moderationActions'>['action'], createdAt: number) =>
      w.t.run((ctx) =>
        ctx.db.insert('moderationActions', {
          actorId: w.mod.id,
          action,
          targetType: 'waterbody',
          targetId: w.loser,
          reason: action,
          createdAt,
        }),
      );
    const merged = await row('merge_waterbody', NOW - 2_000);
    expect((await w.t.run((ctx) => reviewAuditOf(ctx, w.loser)))?._id).toBe(merged);
    const unmerged = await row('unmerge_waterbody', NOW - 1_000);
    expect((await w.t.run((ctx) => reviewAuditOf(ctx, w.loser)))?._id).toBe(unmerged);
  });
});

describe('the ETL’s absorb: a batch never dies on one heavy body (R10-C)', () => {
  /** A catalog lake with a key the pass resolves it by. */
  const catalog = (t: T, key: string) =>
    body(t, `Lake ${key}`, 0.01, { externalId: key, osmId: key } as Partial<Doc<'waterBodies'>>);
  const pairOf = (survivor: string, absorbed: string) => ({
    survivor: { source: 'osm', externalId: survivor },
    absorbed: { source: 'osm', externalId: absorbed },
  });
  const retire = (t: T, pairs: ReturnType<typeof pairOf>[]) =>
    t.mutation(internal.waterBodies.retireAbsorbedBodies, { pairs, apply: true });
  const mergedAway = async (t: T, key: string) =>
    (
      await t.run((ctx) =>
        ctx.db
          .query('waterBodies')
          .withIndex('by_external_id', (q) => q.eq('source', 'osm').eq('externalId', key))
          .unique(),
      )
    )?.dedupStatus === 'merged';

  test('one too-heavy body among ordinary ones: skipped, named and flagged; the rest retired', async () => {
    const t = harness();
    const ids: Record<string, Id<'waterBodies'>> = {};
    for (const key of ['s1', 'a1', 's2', 'h2', 's3', 'a3']) ids[key] = await catalog(t, key);
    // Past the rows of one kind a merge moves: too heavy, whatever the transaction has left.
    await t.run(async (ctx) => {
      for (let i = 0; i < TOO_MANY_LAUNCHES; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: ids.h2 as Id<'waterBodies'>,
          coord: { lat: LAT, lng: LNG },
          source: 'osm',
          status: 'visible',
          createdAt: NOW,
        });
      }
    });
    const res = await retire(t, [pairOf('s1', 'a1'), pairOf('s2', 'h2'), pairOf('s3', 'a3')]);
    expect(res.retired).toBe(2);
    expect(res.deferred).toEqual([]);
    expect(res.skipped).toEqual({
      'too much moves for one transaction, so a person merges them': 1,
    });
    expect([
      await mergedAway(t, 'a1'),
      await mergedAway(t, 'h2'),
      await mergedAway(t, 'a3'),
    ]).toEqual([true, false, true]);
    // Put in front of a person: the duplicate queue.
    expect((await t.run((ctx) => ctx.db.get(ids.h2 as Id<'waterBodies'>)))?.dedupStatus).not.toBe(
      'clean',
    );
    // The dry run predicts it the same way.
    const dry = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [pairOf('s2', 'h2')],
    });
    expect(dry.skipped).toEqual({
      'too much moves for one transaction, so a person merges them': 1,
    });
  });

  test('a pair one of whose bodies is mid-unmerge is skipped and named, never absorbed', async () => {
    const t = harness();
    const survivor = await catalog(t, 'u-s');
    await catalog(t, 'u-a');
    const unmergeId = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: survivor,
        reason: 'Two lakes',
        metadata: { done: false },
        createdAt: NOW,
      }),
    );
    await t.run((ctx) => ctx.db.patch(survivor, { unmergeActionId: unmergeId }));
    const res = await retire(t, [pairOf('u-s', 'u-a')]);
    expect(res).toMatchObject({
      retired: 0,
      skipped: { 'an unmerge is still running on one of them': 1 },
    });
    expect(await mergedAway(t, 'u-a')).toBe(false);
  });

  /** Points a ring of a 4-ring survivor bay may carry for its merge to project `share` of the time. */
  const ringPointsForShare = (share: number): number => {
    const ring = (n: number) => ({
      polygon: {
        type: 'MultiPolygon',
        coordinates: Array.from({ length: 4 }, () => [
          Array.from({ length: n }, (_, i) => [LNG + i * 1e-7, LAT + i * 1e-7]),
        ]),
      },
      name: 'Points Bay',
      bbox: boxOf(LNG, LAT, 0.008),
    });
    // The pair's own base is a few small catalog rows: the fixed part's time stands in for it.
    const time = (n: number) => MERGE_FIXED.timeMs + rowCost('survivorSubAreas', ring(n), 5).timeMs;
    let lo = 3;
    let hi = 8_000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (time(mid) <= share * THRESHOLDS.timeMs) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  test('execution time across a batch: two pairs each in the time budget, never both in one call', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const keys = [1, 2].map((i) => ({ s: `geo-s${i}`, a: `geo-a${i}` }));
    for (const k of keys) {
      const survivor = await catalog(t, k.s);
      await catalog(t, k.a);
      // A survivor bay of 4 rings, each ring's points the most for which this one merge projects
      // within 60 % of the time budget — so one fits a call, two never do.
      const n = ringPointsForShare(0.6);
      await t.run((ctx) =>
        ctx.db.insert('waterBodySubAreas', {
          waterBodyId: survivor,
          name: 'Points Bay',
          searchText: 'Points Bay',
          polygon: {
            type: 'MultiPolygon',
            coordinates: Array.from({ length: 4 }, (_, p) => [
              [
                ...Array.from({ length: n - 1 }, (_, i) => {
                  const a = (2 * Math.PI * i) / (n - 1);
                  return [LNG - 0.006 + p * 0.003 + 0.001 * Math.cos(a), LAT + 0.001 * Math.sin(a)];
                }),
                [LNG - 0.006 + p * 0.003 + 0.001, LAT],
              ],
            ]),
          } as never,
          bbox: boxOf(LNG, LAT, 0.008),
          centroid: { lat: LAT, lng: LNG },
          surfaceAreaSqM: 10_000,
          displayScore: 0,
          minVisibleZoom: 10,
          createdByUserId: mod.id,
          createdAt: NOW,
          updatedAt: NOW,
        } as never),
      );
    }
    const first = await retire(
      t,
      keys.map((k) => pairOf(k.s, k.a)),
    );
    expect(first.retired).toBe(1);
    expect(first.deferred).toEqual([pairOf(keys[1]?.s as string, keys[1]?.a as string)]);
    const second = await retire(t, first.deferred);
    expect(second).toMatchObject({ retired: 1, deferred: [] });
  }, 60_000);

  test('bodies that together pass one transaction: the rest come back, and the next calls take them', async () => {
    const t = harness();
    const keys = [1, 2, 3].map((i) => ({ s: `big-s${i}`, a: `big-a${i}` }));
    for (const k of keys) {
      await catalog(t, k.s);
      const absorbed = await catalog(t, k.a);
      // Four launches whose names no writer caps, ~500 KiB each: ~2 MiB a merge moves — one fits a
      // transaction's time and bytes, two never do.
      for (let start = 0; start < 4; start += 2) {
        await t.run(async (ctx) => {
          for (let i = start; i < start + 2; i++) {
            await ctx.db.insert('putIns', {
              waterBodyId: absorbed,
              coord: { lat: LAT, lng: LNG },
              source: 'osm',
              status: 'visible',
              name: `${i}${'P'.repeat(500 * 1024)}`,
              createdAt: NOW,
            });
          }
        });
      }
    }
    let pending = keys.map((k) => pairOf(k.s, k.a));
    let calls = 0;
    let retired = 0;
    while (pending.length > 0) {
      calls++;
      if (calls > 10) throw new Error('the pass never finished');
      const res = await retire(t, pending);
      // Each call advances, and none dies on the transaction's limits (the harness enforces them).
      expect(res.retired).toBeGreaterThan(0);
      retired += res.retired;
      pending = res.deferred;
    }
    expect(retired).toBe(3);
    expect(calls).toBeGreaterThan(1);
    for (const k of keys) expect(await mergedAway(t, k.a)).toBe(true);
  }, 120_000);
});

describe('the merge estimate is a bound in every dimension (R11)', () => {
  /** A merge from the Shape tab's seat: the preview's answer, then the write's. */
  const tryMerge = async (w: Awaited<ReturnType<typeof pair>>) => {
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    if (!preview.ok) throw new Error(preview.refusal);
    const wrote = await w
      .merge()
      .then(() => 'merged')
      .catch((e: ConvexError<{ message?: string } | string>) =>
        typeof e.data === 'string' ? e.data : (e.data?.message ?? String(e)),
      );
    return { tooBig: preview.tooBig, wrote };
  };
  const launches = (w: Awaited<ReturnType<typeof pair>>, n: number, name?: (i: number) => string) =>
    w.t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: w.loser,
          coord: { lat: LAT, lng: LNG },
          source: 'osm',
          status: 'visible',
          ...(name ? { name: name(i) } : {}),
          createdAt: NOW,
        });
      }
    });

  type W = Awaited<ReturnType<typeof pair>>;
  const TABLE = {
    putIns: 'putIns',
    favorites: 'waterBodyFavorites',
    requests: 'waterBodyRequests',
    flags: 'contentFlags',
    reports: 'reports',
  } as const;
  /** A loser row of `kind`, as stored — the sample the arithmetic weighs. */
  const sampleOf = (w: W, kind: keyof typeof TABLE) =>
    w.t.run(async (ctx) => {
      const rows = await ctx.db.query(TABLE[kind]).collect();
      const row = rows.find((r) =>
        kind === 'flags'
          ? (r as Doc<'contentFlags'>).targetId === w.loser
          : (r as { waterBodyId?: string }).waterBodyId === w.loser,
      );
      return row as unknown as Record<string, unknown>;
    });
  /** The pair's own spend before any row: the fixed part and its two bodies, as the check charges. */
  const baseOf = (w: W) =>
    w.t.run(async (ctx) =>
      baseCost(
        (await ctx.db.get(w.survivor)) as Doc<'waterBodies'>,
        (await ctx.db.get(w.loser)) as Doc<'waterBodies'>,
      ),
    );
  /**
   * **One kind at its edge, from the module's own arithmetic** (the harness can't enforce time, so
   * this tests the arithmetic and the refusal, not the clock): the most rows the projection admits,
   * found by search over `rowCost`; one fewer merges, one more is refused by the preview and the
   * write alike. `extra` charges rows the shape needs besides (the bays reports join).
   */
  const atTheEdge = async (
    kind: keyof typeof TABLE,
    insert: (w: W, from: number, n: number) => Promise<void>,
    extra: (w: W) => Promise<MergeCost | null> = async () => null,
    /** Over a {@link busy} survivor and loser: the same edge, since none of their rows move. */
    busyRows = 0,
  ): Promise<number> => {
    const probe = await pair();
    await insert(probe, 0, 1);
    const sample = await sampleOf(probe, kind);
    const more = await extra(probe);
    let base = more ? plus(await baseOf(probe), more) : await baseOf(probe);
    if (busyRows > 0) {
      // Of a busy survivor's rows, the estimate charges only what the merge reads of them: its
      // labels (every one, to the cap, checked for a twin). Nothing else of it may matter.
      await busy(probe.t, probe.survivor, probe.loser, 1);
      const label = await probe.t.run((ctx) =>
        ctx.db
          .query('bodyLandmarks')
          .withIndex('by_water_body', (q) => q.eq('waterBodyId', probe.survivor))
          .first(),
      );
      base = plus(
        base,
        scaled(
          rowCost('survivorLandmarks', label as unknown as Record<string, unknown>, 5),
          busyRows,
        ),
      );
    }
    const edge = largestFitting(base, (n) => scaled(rowCost(kind, sample, 5), n));
    const busied = async () => {
      const w = await pair();
      if (busyRows > 0) await busy(w.t, w.survivor, w.loser, busyRows);
      return w;
    };
    const under = await busied();
    await insert(under, 0, edge - 1);
    expect(await tryMerge(under)).toEqual({ tooBig: false, wrote: 'merged' });
    const over = await busied();
    await insert(over, 0, edge + 1);
    expect(await tryMerge(over)).toEqual({ tooBig: true, wrote: MERGE_TOO_BIG });
    return edge;
  };
  const people = (w: W, from: number, n: number, tag: string) =>
    w.t.run(async (ctx) => {
      const ids: Id<'profiles'>[] = [];
      for (let i = from; i < from + n; i++) {
        ids.push(
          await ctx.db.insert('profiles', {
            clerkUserId: `${tag}${i}`,
            displayName: `${tag}${i} Test-Person`,
            username: `${tag}${i}`,
            driveTimePrefMinutes: 60,
            profileVisibility: 'public',
            notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
            dateOfBirth: Date.UTC(1990, 0, 1),
            reputationPoints: 0,
            role: 'member',
            status: 'active',
            createdAt: NOW,
          }),
        );
      }
      return ids;
    });

  test('launches at their edge (time binds before index ranges)', async () => {
    const edge = await atTheEdge('putIns', (w, _from, n) => launches(w, n));
    expect(edge).toBeLessThan(Math.floor(THRESHOLDS.databaseQueries));
  }, 120_000);

  const fansOn = async (w: W, from: number, n: number) => {
    const fans = await people(w, from, n, 'fan');
    await w.t.run(async (ctx) => {
      for (const userId of fans) {
        await ctx.db.insert('waterBodyFavorites', {
          userId,
          waterBodyId: w.loser,
          createdAt: NOW,
        });
      }
    });
  };

  test('favorites at their edge', async () => {
    await atTheEdge('favorites', fansOn);
  }, 120_000);

  test('favorites at their edge, over a busy survivor: the twin test is a point read a favorite', async () => {
    await atTheEdge('favorites', fansOn, undefined, 400);
  }, 600_000);

  const asks = (kind: 'activate' | 'name_landmark') => (w: W, from: number, n: number) =>
    w.t.run(async (ctx) => {
      for (let i = from; i < from + n; i++) {
        await ctx.db.insert('waterBodyRequests', {
          kind,
          status: 'open',
          requesterId: w.skater.id,
          coord: { lat: LAT + i * 1e-5, lng: LNG },
          waterBodyId: w.loser,
          ...(kind === 'name_landmark' ? { name: `Rock ${i}` } : {}),
          createdAt: NOW,
        });
      }
    });

  test('asks at their edge', async () => {
    await atTheEdge('requests', asks('activate'));
  }, 120_000);

  test('landmark asks at their edge (the same-place rule)', async () => {
    await atTheEdge('requests', asks('name_landmark'));
  }, 120_000);

  const flagsOn = async (w: W, from: number, n: number) => {
    const flaggers = await people(w, from, n, 'flagger');
    await w.t.run(async (ctx) => {
      for (const flaggerId of flaggers) {
        await ctx.db.insert('contentFlags', {
          flaggerId,
          targetType: 'waterbody',
          targetId: w.loser,
          reason: 'no_public_access',
          status: 'open',
          createdAt: NOW,
        });
      }
    });
  };

  test('flags at their edge', async () => {
    await atTheEdge('flags', flagsOn);
  }, 120_000);

  test('flags at their edge, over a busy survivor: the preview and the write read a point a flag (Greptile on #173)', async () => {
    await atTheEdge('flags', flagsOn, undefined, 400);
  }, 600_000);

  test('a heavy survivor: its own bays at their edge — the estimate refuses before the transaction would fail', async () => {
    // Every listed survivor bay is re-clipped to its outline, so the survivor's bays are the
    // merge's own rows, counted by the estimate (`survivorSubAreas`): one fewer than the edge merges
    // inside every limit; one more is refused by the preview and the write alike, never by the backend.
    const bays = (w: W, n: number) =>
      inChunks(w.t, n, (ctx, i) =>
        ctx.db.insert('waterBodySubAreas', {
          waterBodyId: w.survivor,
          name: `Survivor Bay ${i}`,
          searchText: `Survivor Bay ${i}`,
          polygon: square(LNG + 0.0001 * (i % 50), LAT + 0.0001 * Math.floor(i / 50), 0.00004),
          bbox: boxOf(LNG + 0.0001 * (i % 50), LAT + 0.0001 * Math.floor(i / 50), 0.00004),
          centroid: { lat: LAT, lng: LNG },
          surfaceAreaSqM: 100,
          displayScore: 0,
          minVisibleZoom: 10,
          createdByUserId: w.mod.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    const probe = await pair();
    await bays(probe, 1);
    const sample = (await probe.t.run((ctx) =>
      ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => q.eq('waterBodyId', probe.survivor))
        .first(),
    )) as unknown as Record<string, unknown>;
    const edge = largestFitting(await baseOf(probe), (n) =>
      scaled(rowCost('survivorSubAreas', sample, 5), n),
    );
    const under = await pair();
    await bays(under, edge - 1);
    expect(await tryMerge(under)).toEqual({ tooBig: false, wrote: 'merged' });
    const over = await pair();
    await bays(over, edge + 1);
    expect(await tryMerge(over)).toEqual({ tooBig: true, wrote: MERGE_TOO_BIG });
  }, 600_000);

  test('reports each in two bays at their edge', async () => {
    // By the world itself: separate harnesses hand out the same ids.
    const bays = new Map<W, Id<'waterBodySubAreas'>[]>();
    const baysOf = async (w: W) => {
      const known = bays.get(w);
      if (known) return known;
      const ids = [
        await bay(w.t, w.loser, 'West Bay', 0.002, w.mod.id, LNG - 0.004),
        await bay(w.t, w.loser, 'East Bay', 0.002, w.mod.id, LNG + 0.004),
      ];
      bays.set(w, ids);
      return ids;
    };
    await atTheEdge(
      'reports',
      async (w, from, n) => {
        const two = await baysOf(w);
        await w.t.run(async (ctx) => {
          for (let i = from; i < from + n; i++) {
            const reportId = await ctx.db.insert('reports', {
              authorId: w.skater.id,
              waterBodyId: w.loser,
              subAreaIds: two,
              point: { lat: LAT, lng: LNG },
              skateEndTime: NOW - i,
              reportTime: NOW,
              source: 'native',
              iceTypes: [],
              surfaceTags: [],
              photoIds: [],
              moderationStatus: 'visible',
              hazardIdsCreated: [],
              createdAt: NOW,
              updatedAt: NOW,
            } as never);
            for (const subAreaId of two) {
              await ctx.db.insert('reportSubAreas', {
                reportId,
                subAreaId,
                waterBodyId: w.loser,
                moderationStatus: 'visible',
                skateEndTime: NOW - i,
              });
            }
          }
        });
      },
      async (w) => {
        const two = await baysOf(w);
        const docs = await w.t.run(async (ctx) => Promise.all(two.map((id) => ctx.db.get(id))));
        return docs
          .map((d) => rowCost('subAreas', d as unknown as Record<string, unknown>, 5))
          .reduce(plus);
      },
    );
  }, 120_000);

  test('heavy rows: launches near the document limit at their edge (their bytes cost time)', async () => {
    const edge = await atTheEdge('putIns', async (w, from, n) => {
      // Two a transaction: each ~900 KiB, and a transaction writes at most 16 MiB.
      for (let i = from; i < from + n; i += 2) {
        await launches(w, Math.min(2, from + n - i), (k) => `${i + k}${'P'.repeat(900 * 1024)}`);
      }
    });
    expect(edge).toBeGreaterThan(0);
  }, 120_000);

  test('execution time: a bay re-clipped at the edge of the time budget merges; past it, refused', async () => {
    /** A bay of four small rings around the middle, each `n` points (a ring stays under 8,192). */
    const bayDoc = (w: W, n: number) => ({
      waterBodyId: w.survivor,
      name: 'Many Points Bay',
      searchText: 'Many Points Bay',
      polygon: {
        type: 'MultiPolygon',
        coordinates: Array.from({ length: 4 }, (_, p) => [
          [
            ...Array.from({ length: n - 1 }, (_, i) => {
              const a = (2 * Math.PI * i) / (n - 1);
              return [LNG - 0.006 + p * 0.003 + 0.001 * Math.cos(a), LAT + 0.001 * Math.sin(a)];
            }),
            [LNG - 0.006 + p * 0.003 + 0.001, LAT],
          ],
        ]),
      },
      bbox: boxOf(LNG, LAT, 0.008),
      centroid: { lat: LAT, lng: LNG },
      surfaceAreaSqM: 10_000,
      displayScore: 0,
      minVisibleZoom: 10,
      createdByUserId: w.mod.id,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const probe = await pair();
    const base = await baseOf(probe);
    // The most points a ring may carry, by the module's arithmetic (its geometry and its bytes).
    const edge = largestFitting(base, (n) =>
      n < 3 ? scaled(base, 0) : rowCost('survivorSubAreas', bayDoc(probe, n), 5),
    );
    expect(edge).toBeLessThan(8_192);
    const under = await pair();
    await under.t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', bayDoc(under, edge - 10) as never),
    );
    expect(await tryMerge(under)).toEqual({ tooBig: false, wrote: 'merged' });
    const over = await pair();
    await over.t.run((ctx) => ctx.db.insert('waterBodySubAreas', bayDoc(over, edge + 10) as never));
    expect(await tryMerge(over)).toEqual({ tooBig: true, wrote: MERGE_TOO_BIG });
  }, 120_000);

  test('flags re-key into one item in linear reads, never quadratic', async () => {
    const readsFor = async (n: number) => {
      const w = await pair();
      await w.t.run(async (ctx) => {
        for (let i = 0; i < n; i++) {
          const flaggerId = await ctx.db.insert('profiles', {
            clerkUserId: `f${i}`,
            displayName: `f${i} Test-Person`,
            username: `f${i}`,
            driveTimePrefMinutes: 60,
            profileVisibility: 'public',
            notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
            dateOfBirth: Date.UTC(1990, 0, 1),
            reputationPoints: 0,
            role: 'member',
            status: 'active',
            createdAt: NOW,
          });
          await ctx.db.insert('contentFlags', {
            flaggerId,
            targetType: 'waterbody',
            targetId: w.loser,
            reason: 'no_public_access',
            status: 'open',
            createdAt: NOW,
          });
        }
      });
      return w.t.run(async (ctx) => {
        const { mergeBodyInto } = await import('./waterBodies');
        const [s, l] = [await ctx.db.get(w.survivor), await ctx.db.get(w.loser)];
        await mergeBodyInto(ctx, { survivor: s as never, loser: l as never, reason: 'x' });
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used;
      });
    };
    const [none, some, more] = [await readsFor(0), await readsFor(40), await readsFor(80)];
    // Twice the flags, about twice the extra reads — a square would be four times.
    expect((more - none) / (some - none)).toBeLessThan(2.5);
  }, 60_000);
});

describe('the time ceilings, pinned (R12)', () => {
  /**
   * The rows of each kind one merge of two small bodies admits, from the arithmetic alone — pinned, so
   * a change to a time constant or a kind's calls shows here, and S4b's real-backend table can be
   * re-run against exactly these. Time binds every kind (the index-range ceilings are higher).
   */
  test('each kind’s ceiling, from the module’s own arithmetic', () => {
    const square = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    const body = {
      _id: 'x'.repeat(32),
      _creationTime: 1,
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: square,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      surfaceAreaSqM: 1e6,
      createdAt: 1,
    } as unknown as Doc<'waterBodies'>;
    const base = baseCost(body, body);
    const id = 'y'.repeat(32);
    const row = { _id: id, _creationTime: 1, waterBodyId: id, createdAt: 1 };
    const ask = { ...row, status: 'open', requesterId: id, coord: { lat: 0, lng: 0 } };
    const edge = (more: MergeCost, one: MergeCost) => largestFitting(more, (n) => scaled(one, n));
    const report = {
      ...row,
      authorId: id,
      subAreaIds: [id, id],
      point: { lat: 0, lng: 0 },
      skateEndTime: 1,
      reportTime: 1,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      updatedAt: 1,
    };
    const twoBays = plus(
      base,
      scaled(rowCost('subAreas', { ...row, name: 'Bay', polygon: square }, 5), 2),
    );
    expect(Math.round(base.timeMs)).toBe(114);
    expect({
      launches: edge(base, rowCost('putIns', { ...row, source: 'osm', status: 'visible' }, 5)),
      favorites: edge(base, rowCost('favorites', { ...row, userId: id }, 5)),
      asks: edge(base, rowCost('requests', { ...ask, kind: 'activate' }, 5)),
      landmarkAsks: edge(
        base,
        rowCost('requests', { ...ask, kind: 'name_landmark', name: 'Rock 1' }, 5),
      ),
      flags: edge(
        base,
        rowCost('flags', { ...row, flaggerId: id, reason: 'no_public_access', status: 'open' }, 5),
      ),
      reportsInTwoBays: edge(twoBays, rowCost('reports', report, 5)),
    }).toEqual({
      launches: 994,
      favorites: 511,
      asks: 104,
      landmarkAsks: 35,
      flags: 95,
      reportsInTwoBays: 311,
    });
  });
});

describe('a busy survivor: the reads beside the merge stay bounded (Greptile on #173)', () => {
  test('90 loser flags over 400 unrelated survivor flags: the preview reads a point a flag, and agrees', async () => {
    const w = await pair();
    await busy(w.t, w.survivor, w.loser, 400);
    const flaggers = await crowd(w.t, 90, 'loser-flagger');
    await w.t.run(async (ctx) => {
      for (const flaggerId of flaggers) {
        await ctx.db.insert('contentFlags', {
          flaggerId,
          targetType: 'waterbody',
          targetId: w.loser,
          reason: 'no_public_access',
          status: 'open',
          createdAt: NOW,
        });
      }
    });
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    if (!preview.ok) throw new Error(preview.refusal);
    expect(preview.tooBig).toBe(false);
    expect(preview.moves.flags).toEqual({ count: 90, capped: false });
    const { actionId } = await w.merge();
    const cs = await changeSetOf(w.t, actionId);
    expect(cs.moved.filter((m) => m.table === 'contentFlags')).toHaveLength(90);
  }, 600_000);

  test('from the Inbox: the Drawn item reads and mergeDrawn merges over a busy survivor', async () => {
    const w = await pair();
    await busy(w.t, w.survivor, w.loser, 400);
    const { item } = await itemOf(w);
    if (item?.kind !== 'drawn') throw new Error('no drawn item');
    expect(item.overlap?.body.waterBodyId).toBe(w.survivor);
    await w.mod.as.mutation(api.inboxWrites.mergeDrawn, {
      itemId: item.itemId,
      survivorId: w.survivor,
      reason: 'The same east bay',
    });
    expect(await w.t.run((ctx) => ctx.db.get(w.loser))).toMatchObject({
      reviewStatus: 'merged',
      mergedIntoId: w.survivor,
    });
  }, 600_000);

  test('a survivor with more bays than any merge reads: too big, and the preview reads no more than the load', async () => {
    // 400 bays of 2,000 points each — some 20 MB, past one read's 16 MiB: the load stops at its
    // threshold and says too big, and the clash check (the survivor's bays whole) is not read.
    const w = await pair();
    const ring = (cx: number, cy: number) => {
      const pts = Array.from({ length: 2_000 }, (_, k) => {
        const a = (2 * Math.PI * k) / 2_000;
        return [cx + 0.00004 * Math.cos(a), cy + 0.00004 * Math.sin(a)];
      });
      return { type: 'Polygon' as const, coordinates: [[...pts, pts[0] as number[]]] };
    };
    const SIDE = 20;
    await inChunks(w.t, 400, (ctx, i) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: w.survivor,
        name: `Survivor Bay ${i}`,
        searchText: `Survivor Bay ${i}`,
        polygon: ring(LNG + 0.0001 * (i % SIDE), LAT + 0.0001 * Math.floor(i / SIDE)),
        bbox: boxOf(LNG + 0.0001 * (i % SIDE), LAT + 0.0001 * Math.floor(i / SIDE), 0.00004),
        centroid: { lat: LAT, lng: LNG },
        surfaceAreaSqM: 100,
        displayScore: 0,
        minVisibleZoom: 10,
        createdByUserId: w.mod.id,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await bay(w.t, w.loser, 'Survivor Bay 3', 0.001, w.mod.id);
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    if (!preview.ok) throw new Error(preview.refusal);
    expect(preview).toMatchObject({ tooBig: true, refusal: MERGE_TOO_BIG, code: 'tooBig' });
    expect(preview.baysClashing).toEqual({ names: [], capped: true });
    await expect(w.merge()).rejects.toThrow(MERGE_TOO_BIG);
  }, 600_000);

  test('the ETL’s absorb retires into a busy survivor', async () => {
    const t = harness();
    const ids: Record<string, Id<'waterBodies'>> = {};
    for (const key of ['busy-s', 'busy-a']) {
      ids[key] = await body(t, `Lake ${key}`, 0.01, {
        externalId: key,
        osmId: key,
      } as Partial<Doc<'waterBodies'>>);
    }
    await busy(t, ids['busy-s'] as Id<'waterBodies'>, ids['busy-a'] as Id<'waterBodies'>, 400);
    const out = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [
        {
          survivor: { source: 'osm', externalId: 'busy-s' },
          absorbed: { source: 'osm', externalId: 'busy-a' },
        },
      ],
      apply: true,
    });
    expect(out.retired).toBe(1);
    expect(
      (await t.run((ctx) => ctx.db.get(ids['busy-a'] as Id<'waterBodies'>)))?.mergedIntoId,
    ).toBe(ids['busy-s']);
  }, 600_000);
});
