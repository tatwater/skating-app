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
  for (const row of await landmarksForBody(ctx, waterBodyId)) {
    if (row.removedAt !== undefined) continue;
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
 * Moved, then reconciled against the survivor's own rows by the rule every other writer uses (shared
 * upstream id, else core's `landmarksAreSamePlace`), since two duplicate bodies usually carry the same
 * catalog landmarks twice:
 *
 * - **A live twin** takes the moved row in: its ids, spellings and the larger corpus count; the sum
 *   of the report counts; and, where only the moved row was a moderator's, the moderator's name,
 *   kind and point. The moved row is retired beside it, so ids that point at it (a report's `where`,
 *   an audit row) still resolve.
 * - **A twin a moderator removed** holds: the moved row is retired too, as a re-run of the ETL would
 *   hold it. (A twin the catalogs dropped does not — that was no one's judgment of the place.)
 * - **No twin**: the row moves as it is, up to `MAX_LANDMARKS_PER_BODY`; past the cap it is retired
 *   and counted, so the per-body read can still trust the cap.
 *
 * Then every live bay on the survivor retires the landmarks it now names (`retireNamedAsBays`) —
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
  const now = Date.now();
  let live = staying.filter((row) => row.removedAt === undefined).length;
  let folded = 0;
  let overCap = 0;
  for (const row of moving) {
    const retire = { waterBodyId: survivorId, removedAt: now, updatedAt: now };
    if (row.removedAt !== undefined) {
      await ctx.db.patch(row._id, { waterBodyId: survivorId, updatedAt: now });
      continue;
    }
    const sameAs = (other: Doc<'bodyLandmarks'>) =>
      other.externalIds.some((id) => row.externalIds.includes(id)) ||
      landmarksAreSamePlace(identityOf(other), identityOf(row));
    const twin =
      staying.find((other) => other.removedAt === undefined && sameAs(other)) ??
      staying.find((other) => other.catalogDroppedAt === undefined && sameAs(other));
    if (twin && twin.removedAt !== undefined) {
      await ctx.db.patch(row._id, retire);
      await auditLandmark(
        ctx,
        actorId,
        'remove',
        row._id,
        `"${row.name}" was removed here already`,
        {
          mergedIntoId: twin._id,
        },
      );
      folded++;
      continue;
    }
    if (twin) {
      const takeRow = twin.moderatorEditedAt === undefined && row.moderatorEditedAt !== undefined;
      const keeper = takeRow ? row : twin;
      const reportCount = (twin.reportCount ?? 0) + (row.reportCount ?? 0);
      const corpusMessages = Math.max(twin.corpusMessages ?? 0, row.corpusMessages ?? 0);
      const patch = {
        name: keeper.name,
        kind: keeper.kind,
        point: keeper.point,
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
      await ctx.db.patch(row._id, retire);
      await auditLandmark(
        ctx,
        actorId,
        'remove',
        row._id,
        `Folded into "${twin.name}" by a merge`,
        {
          mergedIntoId: twin._id,
        },
      );
      folded++;
      continue;
    }
    if (live >= MAX_LANDMARKS_PER_BODY) {
      await ctx.db.patch(row._id, retire);
      await auditLandmark(
        ctx,
        actorId,
        'remove',
        row._id,
        `Over the lake's landmark cap after a merge`,
      );
      overCap++;
      continue;
    }
    await ctx.db.patch(row._id, { waterBodyId: survivorId, updatedAt: now });
    staying.push({ ...row, waterBodyId: survivorId });
    live++;
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
