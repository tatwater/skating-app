/**
 * The landmark rows' shared plumbing (D202) — its own module so that `subAreas.ts` (which re-stamps
 * landmarks and retires one promoted to a bay) and `landmarks.ts` (which reads bay candidates from
 * `subAreas.ts`) never import each other. Nothing here reads a sub-area itself: the caller passes the
 * candidates in, which is also what lets `restampParent` compute them once for every table.
 */

import {
  landmarkNameKey,
  MAX_LANDMARKS_PER_BODY,
  type SubAreaCandidate,
  subAreaForLandmark,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type BayCandidates = readonly SubAreaCandidate<Doc<'waterBodySubAreas'>>[];

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
 * Re-stamp one body's landmarks against its current bays — called by `subAreas.restampParent` after
 * a bay is drawn, redrawn or delisted. One bounded read, so no cursor: a body's landmarks are capped.
 */
export async function restampLandmarks(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  candidates: BayCandidates,
): Promise<number> {
  let changed = 0;
  for (const row of await landmarksForBody(ctx, waterBodyId)) {
    const next = subAreaFor(row.point, candidates)?.subAreaId;
    if (row.subAreaId === next) continue;
    await ctx.db.patch(row._id, { subAreaId: next });
    changed++;
  }
  return changed;
}

/**
 * Retire every live landmark on the body that a newly drawn bay now names (D202's promotion by
 * name). A bay drawn from the `name_bay` queue is usually a reference bay the ETL already labeled —
 * Kingsland Bay was a node before it was a place — and leaving the label beside the new sub-area
 * would name the water twice. Returns how many it retired.
 */
export async function retireNamedAsBay(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  subAreaId: Id<'waterBodySubAreas'>,
  names: readonly string[],
): Promise<number> {
  const keys = new Set(names.map(landmarkNameKey));
  let retired = 0;
  for (const row of await landmarksForBody(ctx, waterBodyId)) {
    if (row.removedAt !== undefined || !keys.has(landmarkNameKey(row.name))) continue;
    await retireAsPromoted(ctx, actorId, row._id, waterBodyId, subAreaId);
    retired++;
  }
  return retired;
}
