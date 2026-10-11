/**
 * The landmark rows' shared plumbing (D202) — its own module so that `subAreas.ts` (which re-stamps
 * landmarks and retires one promoted to a bay) and `landmarks.ts` (which reads bay candidates from
 * `subAreas.ts`) never import each other. Nothing here reads a sub-area itself: the caller passes the
 * candidates in, which is also what lets `restampParent` compute them once for every table.
 */

import {
  distanceToShorelineMeters,
  filledPolygon,
  haversineMeters,
  type LandmarkKind,
  landmarkNameKey,
  landmarksAreSamePlace,
  MAX_LANDMARKS_PER_BODY,
  normalizeLandmarkNames,
  pointInPolygon,
  type SubAreaCandidate,
  subAreaForLandmark,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type BayCandidates = readonly (SubAreaCandidate<Doc<'waterBodySubAreas'>> & {
  bbox?: Doc<'waterBodySubAreas'>['bbox'];
})[];

/**
 * The rows of one body, removed ones included — the one bounded read every path here shares. Live
 * and removed are read apart: the writers cap *live* rows, so the live read is always all of them,
 * while removals (a moderator's takedowns, promoted bays, the catalogs' drops, merges' folds) have
 * no cap and grow — the newest `MAX_LANDMARKS_PER_BODY` of them are what a writer still needs.
 */
export async function landmarksForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'bodyLandmarks'>[]> {
  return [
    ...(await liveLandmarksForBody(ctx, waterBodyId)),
    ...(await removedLandmarksForBody(ctx, waterBodyId)),
  ];
}

/**
 * The live rows alone — what the map, a moderator's write checks and the bay retirement read, so a
 * removal never costs them a read (or wakes a subscribed label layer).
 */
export async function liveLandmarksForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'bodyLandmarks'>[]> {
  return ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined),
    )
    .take(MAX_LANDMARKS_PER_BODY);
}

/**
 * The newest removals, up to the cap. An older one past that falls out of the writers' sight — a
 * takedown 1,500 removals back could then be re-created by the import — which needs a lake to shed
 * ~3× Champlain's whole landmark list after the takedown: not a case the writers produce.
 */
export async function removedLandmarksForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'bodyLandmarks'>[]> {
  return ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) => q.eq('waterBodyId', waterBodyId).gt('removedAt', 0))
    .order('desc')
    .take(MAX_LANDMARKS_PER_BODY);
}

/** A live row the catalogs own outright — the only kind a run that stops placing it may retire. */
export function isCatalogsLive(row: Doc<'bodyLandmarks'>): boolean {
  return (
    row.removedAt === undefined &&
    row.moderatorEditedAt === undefined &&
    (row.source === 'osm' || row.source === 'gnis')
  );
}

/** What resolving a landmark needs: what it is, where, its names, and the upstream ids it carries. */
export interface LandmarkProbe {
  kind: LandmarkKind;
  point: { lat: number; lng: number };
  name: string;
  aliases: readonly string[];
  externalIds: readonly string[];
}

/**
 * **The one rule every writer finds a landmark's row by** (D202) — the import, a merge, and nothing
 * else, so the two cannot drift. A row answers by a shared upstream id, else by core's
 * `landmarksAreSamePlace`; and rows are tried in tiers, id before place within each:
 *
 * 1. **Live** — a live row is the place, whatever a removed one says.
 * 2. **Removed by a person** — a takedown or a promotion holds against the catalogs.
 * 3. **Dropped by the catalogs** (`catalogDroppedAt`) — no one's judgment; placing it again returns it.
 *
 * A row a merge folded into its twin (`mergedIntoId`) is never an answer: the twin is the place.
 * Indexed once by id and name key, so a giant's several hundred candidates are not each a scan.
 */
export class LandmarkRowIndex {
  private readonly byId = new Map<string, Doc<'bodyLandmarks'>[]>();
  private readonly byName = new Map<string, Doc<'bodyLandmarks'>[]>();

  constructor(rows: readonly Doc<'bodyLandmarks'>[] = []) {
    for (const row of rows) this.add(row);
  }

  /** Index a row — again after a patch, so its new ids and names find it too. */
  add(row: Doc<'bodyLandmarks'>): void {
    if (row.mergedIntoId !== undefined) return;
    const push = (map: Map<string, Doc<'bodyLandmarks'>[]>, key: string) => {
      const list = map.get(key);
      if (!list) map.set(key, [row]);
      else if (!list.includes(row)) list.push(row);
    };
    for (const id of row.externalIds) push(this.byId, id);
    for (const n of [row.name, ...row.aliases]) push(this.byName, landmarkNameKey(n));
  }

  /**
   * The rows a set of probes are — every candidate of one body's line, or every live row a merge
   * moves — decided together, so no probe takes a row that is another's nearer match:
   *
   * 1. A probe whose upstream id names a **live** row is that row — the feature itself.
   * 2. The rest take same-place rows **closest pair first** across all of them, live before removed
   *    (a person's removal before the catalogs' drop), each row to one probe — two mouths of one
   *    river near one row both lose nothing, and neither takes the other's.
   * 3. A probe still without a row falls back to a removed row its id names.
   */
  assign<P extends LandmarkProbe>(probes: readonly P[]): Map<P, Doc<'bodyLandmarks'>> {
    const tier = (row: Doc<'bodyLandmarks'>) =>
      row.removedAt === undefined ? 0 : row.catalogDroppedAt === undefined ? 1 : 2;
    const idRows = new Map(
      probes.map((probe) => [
        probe,
        [...new Set(probe.externalIds.flatMap((id) => this.byId.get(id) ?? []))].sort(
          (a, b) => tier(a) - tier(b),
        ),
      ]),
    );
    // A row some probe's id names is that feature's: never another probe's by place, or two
    // probes would land on it — the id's in step 3, the place match's in step 2.
    const idNamed = new Set([...idRows.values()].flat().map((row) => row._id));
    const out = new Map<P, Doc<'bodyLandmarks'>>();
    const taken = new Set<Id<'bodyLandmarks'>>();
    for (const probe of probes) {
      const live = idRows.get(probe)?.find((row) => tier(row) === 0);
      if (live) {
        out.set(probe, live);
        taken.add(live._id);
      }
    }
    const pairs: { probe: P; row: Doc<'bodyLandmarks'>; tier: number; meters: number }[] = [];
    for (const probe of probes) {
      if (out.has(probe)) continue;
      const identity = identityOf(probe);
      const byId = idRows.get(probe)?.[0];
      const rows = new Set(
        identity.names.flatMap((n) => this.byName.get(landmarkNameKey(n)) ?? []),
      );
      for (const row of rows) {
        if (taken.has(row._id) || idNamed.has(row._id)) continue;
        if (!landmarksAreSamePlace(identityOf(row), identity)) continue;
        // A removed row the probe's own id names outranks a same-tier place match (step 3 takes it).
        if (byId && tier(row) >= tier(byId)) continue;
        pairs.push({
          probe,
          row,
          tier: tier(row),
          meters: haversineMeters(row.point, probe.point),
        });
      }
    }
    pairs.sort((a, b) => a.tier - b.tier || a.meters - b.meters);
    for (const { probe, row } of pairs) {
      if (out.has(probe) || taken.has(row._id)) continue;
      out.set(probe, row);
      taken.add(row._id);
    }
    for (const probe of probes) {
      if (out.has(probe)) continue;
      const byId = idRows.get(probe)?.[0];
      if (byId) out.set(probe, byId);
    }
    return out;
  }
}

/** A row or candidate as core's same-place rule sees it: what it is, where, and every name. */
export function identityOf(row: {
  kind: LandmarkKind;
  point: { lat: number; lng: number };
  name: string;
  aliases: readonly string[];
}) {
  return { kind: row.kind, point: row.point, names: [row.name, ...row.aliases] };
}

export function subAreaFor(
  point: { lat: number; lng: number },
  candidates: BayCandidates,
): { subAreaId: Id<'waterBodySubAreas'> } | null {
  if (candidates.length === 0) return null;
  const match = subAreaForLandmark(point, candidates);
  return match ? { subAreaId: match._id } : null;
}

/** Audit a landmark write. No `actorId` means the system acted — a merge the ETL ran (A05c / D80). */
export async function auditLandmark(
  ctx: MutationCtx,
  actorId: Id<'profiles'> | undefined,
  action: 'create_landmark' | 'edit_landmark' | 'promote_landmark' | 'remove' | 'restore',
  landmarkId: Id<'bodyLandmarks'>,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    ...(actorId !== undefined ? { actorId } : {}),
    action,
    targetType: 'bodyLandmark',
    targetId: landmarkId,
    reason,
    ...(metadata ? { metadata } : {}),
    createdAt: Date.now(),
  });
}

/**
 * Retire a landmark because it was drawn as a bay (D202's promotion). Called from inside the
 * sub-area write, so the bay and the retirement land together or not at all: a bay called "Kingsland
 * Bay" beside a live label saying the same thing is the double-naming D202 exists to prevent.
 */
export async function retireAsPromoted(
  ctx: MutationCtx,
  actorId: Id<'profiles'> | undefined,
  landmarkId: Id<'bodyLandmarks'>,
  waterBodyId: Id<'waterBodies'>,
  subAreaId: Id<'waterBodySubAreas'>,
): Promise<void> {
  const row = await ctx.db.get(landmarkId);
  if (!row || row.waterBodyId !== waterBodyId) {
    throw new ConvexError('That landmark is not on this lake');
  }
  if (row.removedAt !== undefined) return;
  await ctx.db.patch(landmarkId, { removedAt: Date.now(), updatedAt: Date.now() });
  await auditLandmark(
    ctx,
    actorId,
    'promote_landmark',
    landmarkId,
    `"${row.name}" drawn as a bay`,
    {
      subAreaId,
    },
  );
}

/**
 * How far from a bay a landmark of the same name may sit and still be *that bay's* name: a GNIS bay
 * point sits at the bay's head, sometimes on the shore; a same-named place further off is another
 * place (Champlain has two Mud Bays).
 */
export const BAY_NAME_RETIRE_RADIUS_M = 1_000;

/**
 * Retire every live landmark a bay now names (D202's promotion by name): any of the landmark's names
 * — its name or an alias — matching any of the bay's, within {@link BAY_NAME_RETIRE_RADIUS_M} of the
 * bay's outline. Every name on both sides, because that is what `assertNotABayName` refuses: a
 * landmark answering to "Kingsland Bay" under an alias names the bay as surely as one called it. A
 * bay drawn from the `name_bay` queue is usually a reference bay the ETL already labeled — Kingsland
 * Bay was a node before it was a place — and leaving the label beside the new sub-area would name the
 * water twice. Called from the one sub-area insert, from rename and restore, and from a merge, so no
 * way of giving a lake a bay skips it.
 */
export async function retireNamedAsBay(
  ctx: MutationCtx,
  actorId: Id<'profiles'> | undefined,
  waterBodyId: Id<'waterBodies'>,
  bay: BayNaming,
): Promise<number> {
  return retireNamedAsBays(ctx, actorId, waterBodyId, [bay]);
}

export type BayNaming = {
  _id: Id<'waterBodySubAreas'>;
  polygon: Polygon | MultiPolygon;
  names: readonly string[];
};

/**
 * **The one rule for "this bay names that landmark"** (D202): any of the landmark's names matching any
 * of the bay's, and the landmark on the bay's water or within {@link BAY_NAME_RETIRE_RADIUS_M} of its
 * outline. Every writer asks it — the retirement when a bay is drawn, renamed, redrawn or restored;
 * the import's `alreadyBay` skip; a moderator's create, edit and restore — so a same-named place
 * across the lake (Champlain's other Mud Bay) is a landmark to all of them, never to some.
 */
export function bayNaming<B extends BayNaming>(
  landmark: { point: { lat: number; lng: number }; names: readonly string[] },
  bays: readonly B[],
): B | undefined {
  const keys = landmark.names.map(landmarkNameKey);
  return bays.find(
    (bay) =>
      bay.names.some((n) => keys.includes(landmarkNameKey(n))) &&
      (pointInPolygon(landmark.point, filledPolygon(bay.polygon)) ||
        distanceToShorelineMeters(landmark.point, bay.polygon) <= BAY_NAME_RETIRE_RADIUS_M),
  );
}

/** A body's live bays as `bayNaming` reads them. */
export async function liveBaysForNaming(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<BayNaming[]> {
  const bays = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  return bays
    .filter((bay) => bay.removedAt === undefined)
    .map((bay) => ({
      _id: bay._id,
      polygon: bay.polygon as unknown as Polygon | MultiPolygon,
      names: [bay.name, ...(bay.aliases ?? [])],
    }));
}

/** {@link retireNamedAsBay} for several bays over one read of the body's landmarks. */
export async function retireNamedAsBays(
  ctx: MutationCtx,
  actorId: Id<'profiles'> | undefined,
  waterBodyId: Id<'waterBodies'>,
  bays: readonly BayNaming[],
): Promise<number> {
  if (bays.length === 0) return 0;
  let retired = 0;
  for (const row of await liveLandmarksForBody(ctx, waterBodyId)) {
    const bay = bayNaming({ point: row.point, names: [row.name, ...row.aliases] }, bays);
    if (!bay) continue;
    await retireAsPromoted(ctx, actorId, row._id, waterBodyId, bay._id);
    retired++;
  }
  return retired;
}

/**
 * Move a merged body's landmarks to the survivor (D36 / D202) — called from `mergeBodyInto` after the
 * bays have moved, so that a merge cannot strand a lake's labels on a tombstone nothing lists.
 *
 * Each live row is resolved against the survivor's by the rule the import uses (`LandmarkRowIndex`),
 * since two duplicate bodies usually carry the same catalog landmarks twice. **The survivor's rows
 * decide**, in both directions:
 *
 * - **A live twin** takes the moved row in: its ids, spellings and the larger corpus count; the sum
 *   of the report counts; and, where only the moved row was a moderator's, the moderator's name,
 *   kind and point. The moved row is retired as folded into it (`mergedIntoId`), so ids that point
 *   at it still resolve and no writer matches it again.
 * - **A twin a person removed** holds: the moved row is folded into that removal.
 * - **No twin, or one the catalogs dropped**: the row moves as it is, up to `MAX_LANDMARKS_PER_BODY`;
 *   past the cap it is retired and counted — returnable (`catalogDroppedAt`) if the catalogs own it,
 *   since no person judged it.
 * - **A removed row** moves as it is, after the live ones, and its removal stands — on itself, not
 *   on a live twin the survivor carries: a takedown on the duplicate is not a judgment of the
 *   survivor's label.
 *
 * Then every live bay on the survivor retires the labels it now names (`retireNamedAsBays`) —
 * each body's bays and labels were reconciled against each other, not against the other body's.
 * Bay stamps (`subAreaId`) are left to the merge's `scheduleRestamp`, like every other child's.
 */
export async function repointLandmarksOnMerge(
  ctx: MutationCtx,
  loserId: Id<'waterBodies'>,
  survivorId: Id<'waterBodies'>,
  actorId: Id<'profiles'> | undefined,
  /** Did the merge move any of the loser's bays? Then the survivor's own labels meet new bays. */
  baysMoved: boolean,
): Promise<{ repointed: number; folded: number; overCap: number; retiredAsBay: number }> {
  const moving = await landmarksForBody(ctx, loserId);
  // Nothing moved — no landmark, no bay — and nothing on the survivor can have changed: skip its
  // reads, which `retireAbsorbedBodies` would otherwise pay once per label-less loser.
  if (moving.length === 0 && !baysMoved) {
    return { repointed: 0, folded: 0, overCap: 0, retiredAsBay: 0 };
  }
  const staying = await landmarksForBody(ctx, survivorId);
  const index = new LandmarkRowIndex(staying);
  const now = Date.now();
  let live = staying.filter((row) => row.removedAt === undefined).length;
  let folded = 0;
  let overCap = 0;
  // Decided together, against the survivor's rows only: two of the loser's places near one survivor
  // row cannot both fold into it, and neither takes the other's nearer twin.
  const twins = index.assign(moving.filter((row) => row.removedAt === undefined));
  for (const row of moving) {
    if (row.removedAt !== undefined) continue;
    const twin = twins.get(row);
    if (twin && twin.catalogDroppedAt === undefined) {
      if (twin.removedAt === undefined) {
        const takeRow = twin.moderatorEditedAt === undefined && row.moderatorEditedAt !== undefined;
        const keeper = takeRow ? row : twin;
        const other = takeRow ? twin : row;
        // What the keeper lacks, the other supplies — as the ETL's same-place fold does: a footprint
        // (an OSM island's area folded into a GNIS point drives its prominence and label zoom), and,
        // for a catalog keeper only, a specific kind over `other` (a GNIS "Island" folded into an OSM
        // rock is an island). A moderator's name, kind and point are their call, `other` included.
        const areaSqM = keeper.areaSqM ?? other.areaSqM;
        const kind =
          keeper.kind === 'other' && keeper.moderatorEditedAt === undefined
            ? other.kind
            : keeper.kind;
        const reportCount = (twin.reportCount ?? 0) + (row.reportCount ?? 0);
        const corpusMessages = Math.max(twin.corpusMessages ?? 0, row.corpusMessages ?? 0);
        const patch = {
          name: keeper.name,
          kind,
          point: keeper.point,
          ...(areaSqM !== undefined ? { areaSqM } : {}),
          ...(takeRow ? { moderatorEditedAt: row.moderatorEditedAt } : {}),
          externalIds: [...new Set([...twin.externalIds, ...row.externalIds])],
          aliases:
            normalizeLandmarkNames(keeper.name, [
              twin.name,
              ...twin.aliases,
              row.name,
              ...row.aliases,
            ])?.aliases ?? keeper.aliases,
          ...(corpusMessages > 0 ? { corpusMessages } : {}),
          ...(reportCount > 0 ? { reportCount } : {}),
          // A merge changed what this row stands for: a run matched against an export older than
          // now keeps the folded footprint and kind, and does not drop the row.
          movedAt: now,
          updatedAt: now,
        };
        await ctx.db.patch(twin._id, patch);
        Object.assign(twin, patch);
      }
      await ctx.db.patch(row._id, {
        waterBodyId: survivorId,
        removedAt: now,
        mergedIntoId: twin._id,
        updatedAt: now,
      });
      await auditLandmark(
        ctx,
        actorId,
        'remove',
        row._id,
        twin.removedAt === undefined
          ? `Folded into "${twin.name}" by a merge`
          : `"${row.name}" was removed on the lake it merged into`,
        { mergedIntoId: twin._id },
      );
      folded++;
      continue;
    }
    if (live >= MAX_LANDMARKS_PER_BODY) {
      await ctx.db.patch(row._id, {
        waterBodyId: survivorId,
        removedAt: now,
        ...(isCatalogsLive(row) ? { catalogDroppedAt: now } : {}),
        updatedAt: now,
      });
      await auditLandmark(
        ctx,
        actorId,
        'remove',
        row._id,
        "Over the lake's landmark cap after a merge",
      );
      overCap++;
      continue;
    }
    await ctx.db.patch(row._id, { waterBodyId: survivorId, movedAt: now, updatedAt: now });
    live++;
  }
  for (const row of moving) {
    if (row.removedAt === undefined) continue;
    await ctx.db.patch(row._id, { waterBodyId: survivorId, updatedAt: now });
  }

  const retiredAsBay = await retireNamedAsBays(
    ctx,
    actorId,
    survivorId,
    await liveBaysForNaming(ctx, survivorId),
  );
  return { repointed: moving.length, folded, overCap, retiredAsBay };
}

/**
 * Refuse a landmark named for a live bay of its lake (D202): the bay is the place, and a label saying
 * the same thing would name the water twice. The ETL skips these (`alreadyBay`); a moderator is told.
 */
export async function assertNotABayName(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  landmark: { point: { lat: number; lng: number }; names: readonly string[] },
): Promise<void> {
  const bay = bayNaming(landmark, await liveBaysForNaming(ctx, waterBodyId));
  if (bay) {
    throw new ConvexError(`"${bay.names[0]}" is a bay on this lake — it is already on the map`);
  }
}

/**
 * Settle the landmarks a report's `where`s name (D202), in place, before the write — and return the
 * rows. For each point that carries a `landmarkId`:
 *
 * - a live landmark of *this* body: the point keeps the id and takes the landmark's **own name** (a
 *   client cannot pair Apple Island's id with words of its choosing);
 * - anything else — another lake's landmark, one removed or promoted to a bay since the draft was
 *   saved, a string that is not an id: the id is dropped (with `byName`, so the point pins as the
 *   spot it now is) and the author's words stay. A report must
 *   never fail because a label changed under it; an old report whose landmark became a bay still
 *   says "near Kingsland Bay", and an offline draft still posts.
 */
export async function resolveLocatedLandmarks(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  wheres: readonly (
    | { point?: { name?: string; landmarkId?: string; byName?: boolean } }
    | undefined
  )[],
): Promise<Doc<'bodyLandmarks'>[]> {
  const rows = new Map<string, Doc<'bodyLandmarks'> | null>();
  for (const where of wheres) {
    const point = where?.point;
    const id = point?.landmarkId;
    if (!point || id === undefined) continue;
    if (!rows.has(id)) {
      const normalized = ctx.db.normalizeId('bodyLandmarks', id);
      const row = normalized ? await ctx.db.get(normalized) : null;
      rows.set(
        id,
        row && row.waterBodyId === waterBodyId && row.removedAt === undefined ? row : null,
      );
    }
    const row = rows.get(id);
    if (row) point.name = row.name;
    else {
      // Without its landmark the point is a spot like any other, and pins its circle.
      delete point.landmarkId;
      delete point.byName;
    }
  }
  return [...rows.values()].filter((row): row is Doc<'bodyLandmarks'> => row !== null);
}

/**
 * Count a report naming these landmarks (D202's prominence evidence): +1 each, **once, when the
 * report is posted**. An edit never counts — re-adding a landmark across edits would otherwise pump
 * one lake's labels from one report — and a report hidden or deleted later keeps its tick. A tally
 * that orders labels and the sheet's list, never a word about the ice (D3).
 */
export async function noteLandmarksNamed(
  ctx: MutationCtx,
  rows: readonly Doc<'bodyLandmarks'>[],
): Promise<void> {
  for (const row of rows) {
    await ctx.db.patch(row._id, { reportCount: (row.reportCount ?? 0) + 1 });
  }
}

/**
 * Mark a corpus name placed by the landmark just dropped for it (D202's queue), and carry its count
 * to the landmark's prominence. In the same write as the landmark, so the queue never shows a name
 * the map already has. Refused for a name decided meanwhile, or one said to be on another lake.
 */
export async function placeCorpusName(
  ctx: MutationCtx,
  id: Id<'corpusPlaceNames'>,
  landmark: Pick<Doc<'bodyLandmarks'>, '_id' | 'waterBodyId'>,
  actorId: Id<'profiles'>,
): Promise<void> {
  const row = await ctx.db.get(id);
  if (row?.status !== 'open') {
    throw new ConvexError('That name has already been placed or dismissed');
  }
  if (row.waterBodyId !== undefined && row.waterBodyId !== landmark.waterBodyId) {
    throw new ConvexError(`"${row.name}" is waiting on another lake`);
  }
  const now = Date.now();
  await ctx.db.patch(landmark._id, { corpusMessages: row.messages });
  await ctx.db.patch(row._id, {
    status: 'placed',
    waterBodyId: landmark.waterBodyId,
    landmarkId: landmark._id,
    decidedByUserId: actorId,
    decidedAt: now,
    updatedAt: now,
  });
}

/**
 * Refuse a second live landmark that is the same place as one this lake already has — core's
 * `landmarksAreSamePlace`, the rule the import and the ETL use, so a moderator is refused exactly the
 * pairs the catalogs would have merged. "Long Point" is on half the lakes in Vermont and on
 * Champlain twice; two of them far apart are two places.
 */
export function assertNotDuplicate(
  rows: readonly Doc<'bodyLandmarks'>[],
  candidate: {
    kind: LandmarkKind;
    point: { lat: number; lng: number };
    name: string;
    aliases: readonly string[];
  },
  exceptId?: Id<'bodyLandmarks'>,
): void {
  const identity = identityOf(candidate);
  const clash = rows.find(
    (row) =>
      row._id !== exceptId &&
      row.removedAt === undefined &&
      landmarksAreSamePlace(identityOf(row), identity),
  );
  if (clash) throw new ConvexError(`"${clash.name}" is already a landmark here`);
}
