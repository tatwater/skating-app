/**
 * The landmark rows' shared plumbing (D202) — its own module so that `subAreas.ts` (which re-stamps
 * landmarks and retires one promoted to a bay) and `landmarks.ts` (which reads bay candidates from
 * `subAreas.ts`) never import each other. Nothing here reads a sub-area itself: the caller passes the
 * candidates in, which is also what lets `restampParent` compute them once for every table.
 */

import {
  distanceToShorelineMeters,
  filledPolygon,
  landmarkNameKey,
  MAX_LANDMARKS_PER_BODY,
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

/** The rows of one body, removed ones included — the one bounded read every path here shares. */
export async function landmarksForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'bodyLandmarks'>[]> {
  // Twice the cap: the writers cap *live* rows, and removed ones (a moderator's takedowns, promoted
  // bays) sit beside them. A body with more removals than the cap allows is not a case moderators
  // produce; the ETL never removes.
  return ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(MAX_LANDMARKS_PER_BODY * 2);
}

export function subAreaFor(
  point: { lat: number; lng: number },
  candidates: BayCandidates,
): { subAreaId: Id<'waterBodySubAreas'> } | null {
  if (candidates.length === 0) return null;
  const match = subAreaForLandmark(point, candidates);
  return match ? { subAreaId: match._id } : null;
}

export async function auditLandmark(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  action: 'create_landmark' | 'edit_landmark' | 'promote_landmark' | 'remove' | 'restore',
  landmarkId: Id<'bodyLandmarks'>,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
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
  actorId: Id<'profiles'>,
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
 * Retire every live landmark a bay now names (D202's promotion by name): the same name or alias,
 * within {@link BAY_NAME_RETIRE_RADIUS_M} of the bay's outline. A bay drawn from the `name_bay`
 * queue is usually a reference bay the ETL already labeled — Kingsland Bay was a node before it was a
 * place — and leaving the label beside the new sub-area would name the water twice. Called from the
 * one sub-area insert and from rename and restore, so no way of giving a bay a name skips it.
 */
export async function retireNamedAsBay(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  bay: { _id: Id<'waterBodySubAreas'>; polygon: Polygon | MultiPolygon; names: readonly string[] },
): Promise<number> {
  const keys = new Set(bay.names.map(landmarkNameKey));
  const water = filledPolygon(bay.polygon);
  let retired = 0;
  for (const row of await landmarksForBody(ctx, waterBodyId)) {
    if (row.removedAt !== undefined || !keys.has(landmarkNameKey(row.name))) continue;
    const near =
      pointInPolygon(row.point, water) ||
      distanceToShorelineMeters(row.point, bay.polygon) <= BAY_NAME_RETIRE_RADIUS_M;
    if (!near) continue;
    await retireAsPromoted(ctx, actorId, row._id, waterBodyId, bay._id);
    retired++;
  }
  return retired;
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

/**
 * Settle the landmarks a report's `where`s name (D202), in place, before the write — and return the
 * rows. For each point that carries a `landmarkId`:
 *
 * - a live landmark of *this* body: the point keeps the id and takes the landmark's **own name** (a
 *   client cannot pair Apple Island's id with words of its choosing);
 * - anything else — another lake's landmark, one removed or promoted to a bay since the draft was
 *   saved, a string that is not an id: the id is dropped and the author's words stay. A report must
 *   never fail because a label changed under it; an old report whose landmark became a bay still
 *   says "near Kingsland Bay", and an offline draft still posts.
 */
export async function resolveLocatedLandmarks(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  wheres: readonly ({ point?: { name?: string; landmarkId?: string } } | undefined)[],
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
    else delete point.landmarkId;
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
