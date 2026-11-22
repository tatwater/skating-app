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
import { BACKFILL_PHASES, reviewAuditOf } from './inboxItems';
import { readSnapshot } from './lib/audit';
import { bodySource, fileMember } from './lib/inboxItems';
import { DRAWN_SURVIVOR_READ, drawnSurvivorOf, SURVIVOR_CHANGED_REFUSAL } from './lib/inboxRules';
import { MERGE_ROWS_PER_KIND, MERGE_TOO_BIG, RETARGET_CAP } from './lib/mergeLoad';
import schema from './schema';
import type { MergeChangeSet } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

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
    expect((err as ConvexError<string>).data).toBe(MERGE_TOO_BIG);
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

  test('more rows of one kind than the cap: refused, preview and write alike, under the array limit', async () => {
    const w = await pair();
    await w.t.run(async (ctx) => {
      for (let i = 0; i <= MERGE_ROWS_PER_KIND; i++) {
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
    expect(preview.moves.putIns).toEqual({ count: MERGE_ROWS_PER_KIND + 1, capped: true });
    expect(preview).toMatchObject({ tooBig: true, code: 'tooBig' });
    await expect(w.merge()).rejects.toThrow(MERGE_TOO_BIG);
    expect(MERGE_ROWS_PER_KIND).toBeLessThan(8_192);
  });

  test('the drawer never merges their own drawing (D289); the preview says so first', async () => {
    const w = await pair();
    await w.t.run((ctx) => ctx.db.patch(w.loser, { createdByUserId: w.mod.id }));
    const preview = await w.mod.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    expect(preview).toEqual({
      ok: false,
      refusal: 'You filed this, so another staff member decides it.',
      code: 'ownDrawing',
    });
    await expect(w.merge()).rejects.toThrow(/another staff member decides it/);
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

describe('the preview says what the merge moves', () => {
  test('every kind, counted before, equals what the merge moved', async () => {
    const w = await pair();
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
    expect(preview.favoritesDeduped).toBe(cs.deletedFavorites.length);
    expect(preview.favoritesDeduped).toBe(1);
    expect(preview.baysClashing).toEqual(['North Bay']);
    expect(cs.subAreasDelisted).toHaveLength(1);
    expect(preview.staysBehind).toEqual({ accessAlerts: 1, parkingLots: 0 });
    expect(preview).toMatchObject({ tooBig: false, refusal: null, code: null });
    expect(preview.lists.caps).toEqual({ pins: 8, aliases: 20, links: 8 });
  });
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
