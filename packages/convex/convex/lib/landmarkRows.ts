/**
 * The landmark rows' shared plumbing (D202) — its own module so that `subAreas.ts` (which re-stamps
 * landmarks and retires one promoted to a bay) and `landmarks.ts` (which reads bay candidates from
 * `subAreas.ts`) never import each other. Nothing here reads a sub-area itself: the caller passes the
 * candidates in, which is also what lets `restampParent` compute them once for every table.
 */

import {
  distanceToShorelineMeters,
  filledPolygon,
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

  resolve(probe: LandmarkProbe): Doc<'bodyLandmarks'> | undefined {
    const identity = identityOf(probe);
    const byId = [...new Set(probe.externalIds.flatMap((id) => this.byId.get(id) ?? []))];
    const byPlace = [
      ...new Set(identity.names.flatMap((n) => this.byName.get(landmarkNameKey(n)) ?? [])),
    ].filter((row) => landmarksAreSamePlace(identityOf(row), identity));
    const tier = (row: Doc<'bodyLandmarks'>) =>
      row.removedAt === undefined ? 0 : row.catalogDroppedAt === undefined ? 1 : 2;
    for (const t of [0, 1, 2]) {
      const hit = byId.find((row) => tier(row) === t) ?? byPlace.find((row) => tier(row) === t);
      if (hit) return hit;
    }
    return undefined;
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

type BayNaming = {
  _id: Id<'waterBodySubAreas'>;
  polygon: Polygon | MultiPolygon;
  names: readonly string[];
};

/** {@link retireNamedAsBay} for several bays over one read of the body's landmarks. */
export async function retireNamedAsBays(
  ctx: MutationCtx,
  actorId: Id<'profiles'> | undefined,
  waterBodyId: Id<'waterBodies'>,
  bays: readonly BayNaming[],
): Promise<number> {
  if (bays.length === 0) return 0;
  const named = bays.map((bay) => ({
    bay,
    keys: new Set(bay.names.map(landmarkNameKey)),
    water: filledPolygon(bay.polygon),
  }));
  let retired = 0;
  for (const row of await liveLandmarksForBody(ctx, waterBodyId)) {
    const rowKeys = [row.name, ...row.aliases].map(landmarkNameKey);
    const match = named.find(
      ({ bay, keys, water }) =>
        rowKeys.some((key) => keys.has(key)) &&
        (pointInPolygon(row.point, water) ||
          distanceToShorelineMeters(row.point, bay.polygon) <= BAY_NAME_RETIRE_RADIUS_M),
    );
    if (!match) continue;
    await retireAsPromoted(ctx, actorId, row._id, waterBodyId, match.bay._id);
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
): Promise<{ repointed: number; folded: number; overCap: number; retiredAsBay: number }> {
  const moving = await landmarksForBody(ctx, loserId);
  const staying = await landmarksForBody(ctx, survivorId);
  if (moving.length === 0 && staying.length === 0) {
    return { repointed: 0, folded: 0, overCap: 0, retiredAsBay: 0 };
  }
  const index = new LandmarkRowIndex(staying);
  const now = Date.now();
  let live = staying.filter((row) => row.removedAt === undefined).length;
  let folded = 0;
  let overCap = 0;
  for (const row of moving) {
    if (row.removedAt !== undefined) continue;
    const twin = index.resolve(row);
    if (twin && twin.catalogDroppedAt === undefined) {
      if (twin.removedAt === undefined) {
        const takeRow = twin.moderatorEditedAt === undefined && row.moderatorEditedAt !== undefined;
        const keeper = takeRow ? row : twin;
        const other = takeRow ? twin : row;
        // What the keeper lacks, the other supplies — as the ETL's same-place fold does: a footprint
        // (an OSM island's area folded into a GNIS point drives its prominence and label zoom), and
        // a specific kind over `other` (a GNIS "Island" folded into an OSM rock is an island).
        const areaSqM = keeper.areaSqM ?? other.areaSqM;
        const reportCount = (twin.reportCount ?? 0) + (row.reportCount ?? 0);
        const corpusMessages = Math.max(twin.corpusMessages ?? 0, row.corpusMessages ?? 0);
        const patch = {
          name: keeper.name,
          kind: keeper.kind === 'other' ? other.kind : keeper.kind,
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
          updatedAt: now,
        };
        await ctx.db.patch(twin._id, patch);
        Object.assign(twin, patch);
        index.add(twin);
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
    index.add({ ...row, waterBodyId: survivorId });
    live++;
  }
  for (const row of moving) {
    if (row.removedAt === undefined) continue;
    await ctx.db.patch(row._id, { waterBodyId: survivorId, updatedAt: now });
  }

  const bays = (
    await ctx.db
      .query('waterBodySubAreas')
      .withIndex('by_parent', (q) => q.eq('waterBodyId', survivorId))
      .collect()
  )
    .filter((bay) => bay.removedAt === undefined)
    .map((bay) => ({
      _id: bay._id,
      polygon: bay.polygon as unknown as Polygon | MultiPolygon,
      names: [bay.name, ...(bay.aliases ?? [])],
    }));
  const retiredAsBay = await retireNamedAsBays(ctx, actorId, survivorId, bays);
  return { repointed: moving.length, folded, overCap, retiredAsBay };
}

/**
 * Refuse a landmark named for a live bay of its lake (D202): the bay is the place, and a label saying
 * the same thing would name the water twice. The ETL skips these (`alreadyBay`); a moderator is told.
 */
export async function assertNotABayName(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  names: readonly string[],
): Promise<void> {
  const keys = new Set(names.map(landmarkNameKey));
  const bays = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  const bay = bays.find(
    (b) =>
      b.removedAt === undefined &&
      [b.name, ...(b.aliases ?? [])].some((n) => keys.has(landmarkNameKey(n))),
  );
  if (bay) throw new ConvexError(`"${bay.name}" is a bay on this lake — it is already on the map`);
}
