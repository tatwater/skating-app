/**
 * Named sub-areas (N2 / D60) — "Malletts Bay" as a region *of* Lake Champlain rather than a lake
 * beside it.
 *
 * Reports, hazards and bounties keep belonging to the parent body; the sub-area is the finer name
 * they carry, denormalized onto each row at create. This is the **D4 model**, deferred since Phase 1
 * for rivers-as-named-reaches and instantiated here for lakes, where the corpus evidence is
 * overwhelming: every name the community seed failed to match — Malletts, Northwest, Dillenbeck,
 * Burlington, Shelburne, Outer, Appletree, South, Arnold, Carry, Little Eagle, Half Moon, Broad, and
 * the Inland Sea — is a region inside one existing polygon.
 *
 * **Drawing does not breach the path-only doctrine** (Decision 2). `waterBodies.create` refuses a
 * client-supplied shape because a body drawn from nothing has no proof of presence and no frame of
 * reference, and would then collect other people's reports. A sub-area has neither problem: its
 * geometry is **clipped to an already-trusted official polygon** (Decision 10), its author is a
 * role-gated human, and every write lands a `moderationActions` row. No water body is ever minted
 * from a drawn shape, and `waterBodies.create` is untouched.
 */

import {
  bboxIntersects,
  clipSubAreaToParent,
  displayScore,
  minVisibleZoom,
  polygonBBox,
  representativePoint,
  SUB_AREA_CLIP_MESSAGES,
  SUB_AREA_MIN_RENDER_ZOOM,
  smallestContainingSubArea,
  surfaceAreaSqM,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { requireContributorRole } from './lib/auth';
import { syncSubAreaCells, WATER_BODY_LADDER } from './lib/cellIndex';
import { rankCandidates, scanCells } from './lib/cellScan';
import { isListed } from './lib/listing';
import { hazardCenter } from './lib/sampling';
import { bbox, geoJson } from './lib/validators';

/**
 * Rows re-stamped per scheduled batch. Small on purpose: each row costs a read, a point-in-polygon
 * test against every sub-area on the body, and possibly a patch, and the job **runs to completion**
 * — a batch that's slow is a job that takes another tick, not a job that drops rows.
 */
const RESTAMP_BATCH = 200;

/** See `importSeed.minRetainedFraction` — a box is a coarser input than a traced outline. */
const SEED_MIN_RETAINED_FRACTION = 0.35;

/** The tables carrying a denormalized sub-area stamp, re-stamped in this order. */
const RESTAMP_TABLES = ['reports', 'hazards'] as const;
type RestampTable = (typeof RESTAMP_TABLES)[number];

/** `[name, ...aliases]` as the one searchable string — Convex search indexes a single field. */
export function subAreaSearchText(name: string, aliases: readonly string[] | undefined): string {
  return [name, ...(aliases ?? [])]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

/** Trim, drop blanks, dedupe case-insensitively, and keep the operator's casing for the survivor. */
function normalizeAliases(aliases: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases ?? []) {
    const alias = raw.trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/** D49's prominence pair for a sub-area — its own area and its own boost, the same curve as a body. */
function scoreFields(input: { surfaceAreaSqM: number; curatedBoost?: number }) {
  const score = displayScore(input);
  return { displayScore: score, minVisibleZoom: minVisibleZoom(score) };
}

/** A sub-area is reachable only while it is un-delisted **and** its parent is listed (Decision 11). */
export function subAreaListed(
  subArea: { removedAt?: number },
  parent: Parameters<typeof isListed>[0],
): boolean {
  return subArea.removedAt === undefined && isListed(parent);
}

/** Every sub-area on a body, delisted ones included — the read behind both the stamp and the editor. */
export async function subAreasForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodySubAreas'>[]> {
  // Bounded by construction: this is a handful of hand-drawn bays on one lake, not a corpus scan.
  // Champlain — the most sub-divided body there will ever be — carries fourteen.
  return ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
}

/**
 * The sub-area a point on this body belongs to, or `null` — the stamp, resolved through
 * `@skating/core`'s **smallest-containing** rule (Decision 9).
 *
 * Delisted sub-areas are excluded: a bay the operator retired must stop naming new reports, even
 * though the reports it already named keep their stamp until the re-stamp job reaches them.
 *
 * Called from `reports.create` and `hazards.create`, so it is on the hot write path — it costs one
 * `by_parent` read on a body the caller already has, and returns immediately for the 116,068 bodies
 * with no sub-areas at all.
 */
export async function resolveSubAreaForPoint(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  point: { lat: number; lng: number },
): Promise<{ subAreaId: Id<'waterBodySubAreas'>; subAreaName: string } | null> {
  const subAreas = (await subAreasForBody(ctx, waterBodyId)).filter(
    (row) => row.removedAt === undefined,
  );
  if (subAreas.length === 0) return null;
  const match = smallestContainingSubArea(
    point,
    subAreas.map((row) => ({
      ref: row,
      polygon: row.polygon as unknown as Polygon | MultiPolygon,
      surfaceAreaSqM: row.surfaceAreaSqM,
    })),
  );
  return match ? { subAreaId: match._id, subAreaName: match.name } : null;
}

/**
 * Re-index every sub-area on a body against the parent's **current** listing (Decision 11).
 *
 * Called from every water-body mutation that can change `isListed` — `approve`, `remove`, `restore`,
 * `reject`, `merge`, `importCanonical`. Bounded by `by_parent`, and a no-op for the overwhelming
 * majority of bodies, which have no sub-areas at all.
 */
export async function syncCellsForParent(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  parent: Parameters<typeof isListed>[0],
): Promise<void> {
  for (const subArea of await subAreasForBody(ctx, waterBodyId)) {
    await syncSubAreaCells(ctx, subArea._id, {
      bbox: subArea.bbox,
      minVisibleZoom: subArea.minVisibleZoom,
      listed: subAreaListed(subArea, parent),
    });
  }
}

/**
 * Re-clip a body's sub-areas against a **new parent outline**, then re-index them.
 *
 * Called when the parent's *geometry* changes under them — a canonical re-import that refines a
 * shoreline (`importCanonical`), or a merge that hands the bays to a different polygon. Decision 10
 * says a stored sub-area is inside its parent *by construction*, and that has to survive the parent
 * changing shape, or the invariant degrades into "was true when it was drawn."
 *
 * **A bay that no longer fits is delisted, never dropped and never thrown.** These callers are batch
 * paths: an ETL chunk covering thousands of bodies must not abort because one hand-drawn bay stopped
 * fitting a refined outline, and a hard delete would destroy work the operator can otherwise fix with
 * one redraw. It's logged, so the curation pass can find it (D5 — never silent).
 *
 * Returns what changed, so the caller's audit row can say so.
 */
export async function reclipSubAreasToParent(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  parent: Doc<'waterBodies'>,
  /** The human whose action triggered this, when there was one (a merge). Absent for the ETL. */
  actorId?: Id<'profiles'>,
): Promise<{ reclipped: number; delisted: number }> {
  const parentPolygon = parent.polygon as unknown as Polygon | MultiPolygon;
  const parentListed = isListed(parent);
  let reclipped = 0;
  let delisted = 0;

  for (const subArea of await subAreasForBody(ctx, waterBodyId)) {
    // An already-delisted bay is left as it is: re-clipping it would silently resurrect geometry the
    // operator retired, and it has no cell rows to be wrong in the meantime. (`restore` re-clips
    // before bringing one back, which is what keeps this skip from being a hole in Decision 10.)
    if (subArea.removedAt !== undefined) continue;
    const result = clipSubAreaToParent(
      subArea.polygon as unknown as Polygon | MultiPolygon,
      parentPolygon,
    );
    if (!result.ok) {
      const why = `No longer fits ${parent.name} after its outline changed (${result.reason}). Redraw it.`;
      console.warn(`subAreas: "${subArea.name}" (${subArea._id}) — ${why} (N2/D60)`);
      await systemDelist(ctx, subArea, why, actorId);
      delisted++;
      continue;
    }
    if (result.clipped) {
      const bbox = polygonBBox(result.polygon);
      const area = surfaceAreaSqM(result.polygon);
      const scores = scoreFields({
        surfaceAreaSqM: area,
        ...(subArea.curatedBoost !== undefined ? { curatedBoost: subArea.curatedBoost } : {}),
      });
      await ctx.db.patch(subArea._id, {
        polygon: result.polygon,
        bbox,
        centroid: representativePoint(result.polygon),
        representativePoint: representativePoint(result.polygon),
        surfaceAreaSqM: area,
        ...scores,
        updatedAt: Date.now(),
      });
      await syncSubAreaCells(ctx, subArea._id, {
        bbox,
        minVisibleZoom: scores.minVisibleZoom,
        listed: parentListed,
      });
      reclipped++;
      continue;
    }
    await syncSubAreaCells(ctx, subArea._id, {
      bbox: subArea.bbox,
      minVisibleZoom: subArea.minVisibleZoom,
      listed: parentListed,
    });
  }
  return { reclipped, delisted };
}

/**
 * Delist a sub-area the *system* retired — a bay that no longer fits its parent, or one whose name
 * the merge survivor already uses.
 *
 * Two things beyond flipping `removedAt`, both about the operator ever finding out. The reason lands
 * **on the row**, so `listForBody` carries it into the editor where the redraw happens rather than
 * into a server log nobody reads; and when a human's action triggered it (a merge is somebody's
 * click), the audit row names them, because Decision 2 says every write to this table lands one.
 * The ETL path genuinely has no actor, which is exactly what the on-row reason is for.
 */
async function systemDelist(
  ctx: MutationCtx,
  subArea: Doc<'waterBodySubAreas'>,
  reason: string,
  actorId?: Id<'profiles'>,
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(subArea._id, {
    removedAt: now,
    ...(actorId ? { removedByUserId: actorId } : {}),
    systemDelistReason: reason,
    updatedAt: now,
  });
  await syncSubAreaCells(ctx, subArea._id, {
    bbox: subArea.bbox,
    minVisibleZoom: subArea.minVisibleZoom,
    listed: false,
  });
  if (actorId) {
    await audit(ctx, actorId, 'remove', subArea._id, `Auto-delisted "${subArea.name}": ${reason}`, {
      waterBodyId: subArea.waterBodyId,
      automatic: true,
    });
  }
}

/**
 * Move a merge loser's sub-areas onto the survivor (Decision 11).
 *
 * A dedup loser is by definition the *same water* as the survivor, and `merge` already repoints every
 * other body-keyed child — reports, hazards, bounties, features, put-ins, favorites. Leaving the bays
 * behind would strand hand-drawn curation on a tombstone and, worse, leave rows whose parent is
 * permanently unlisted: reachable by neither the map nor the editor, but still named on every report
 * the merge just moved.
 *
 * Geometry is re-clipped against the survivor because the two outlines are *near*-identical, not
 * identical — that's what made them a duplicate pair rather than one row. A bay that doesn't survive
 * the survivor's outline is delisted with a log, per `reclipSubAreasToParent`.
 *
 * A name collision with a sub-area the survivor already has is resolved by delisting the loser's
 * copy: two identically-named overlapping bays would then compete for the stamp under Decision 9's
 * area rule, which resolves deterministically and therefore *silently* wrongly.
 */
export async function repointSubAreasOnMerge(
  ctx: MutationCtx,
  loserId: Id<'waterBodies'>,
  survivor: Doc<'waterBodies'>,
  /** The moderator who ran the merge — a merge is somebody's click, so the audit row names them. */
  actorId?: Id<'profiles'>,
): Promise<{ repointed: number; delisted: number }> {
  const existingNames = new Set(
    (await subAreasForBody(ctx, survivor._id))
      .filter((row) => row.removedAt === undefined)
      .map((row) => row.name.toLowerCase()),
  );
  let repointed = 0;
  let delisted = 0;

  for (const subArea of await subAreasForBody(ctx, loserId)) {
    await ctx.db.patch(subArea._id, { waterBodyId: survivor._id, updatedAt: Date.now() });
    repointed++;
    if (subArea.removedAt !== undefined) continue;
    if (existingNames.has(subArea.name.toLowerCase())) {
      const why = `${survivor.name} already has a bay called "${subArea.name}". The merged copy was delisted rather than left to compete for the stamp.`;
      console.warn(`subAreas: ${why} (N2/D60)`);
      await systemDelist(ctx, subArea, why, actorId);
      delisted++;
      continue;
    }
    existingNames.add(subArea.name.toLowerCase());
  }
  // Now that they belong to the survivor, hold them to the survivor's outline and listing.
  const { delisted: reclipDelisted } = await reclipSubAreasToParent(
    ctx,
    survivor._id,
    survivor,
    actorId,
  );
  return { repointed, delisted: delisted + reclipDelisted };
}

/**
 * Clip a drawn shape to its parent and derive everything stored with it, or throw the operator a
 * message saying what went wrong. The one place a sub-area's geometry is computed, so `create` and
 * `redraw` cannot disagree about what "inside the parent" means.
 */
function deriveGeometry(drawn: Polygon | MultiPolygon, parent: Doc<'waterBodies'>) {
  const result = clipSubAreaToParent(drawn, parent.polygon as unknown as Polygon | MultiPolygon);
  if (!result.ok) {
    throw new ConvexError({
      code: `sub_area_${result.reason}`,
      message: SUB_AREA_CLIP_MESSAGES[result.reason],
      retainedFraction: result.retainedFraction,
    });
  }
  const area = surfaceAreaSqM(result.polygon);
  return {
    polygon: result.polygon,
    bbox: polygonBBox(result.polygon),
    centroid: representativePoint(result.polygon),
    representativePoint: representativePoint(result.polygon),
    surfaceAreaSqM: area,
    clipped: result.clipped,
    retainedFraction: result.retainedFraction,
  };
}

/** Load a parent body for a write, or say why it can't take a sub-area. */
async function requireParent(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'>> {
  const parent = await ctx.db.get(waterBodyId);
  if (!parent) throw new ConvexError('Water body not found');
  // Drawing a bay on a body that isn't on the map produces a row nothing can reach — the cascade
  // would give it no cell rows anyway. Say so rather than accepting the work silently.
  if (!isListed(parent)) throw new ConvexError('That water body is not on the map');
  return parent;
}

/**
 * Refuse a second sub-area with the same name on one lake. Not a database constraint — Convex has
 * none — but a live one on a bounded read, and the mistake it catches is real: the operator draws
 * "Malletts Bay" twice across two sessions and two overlapping rows then compete for the stamp under
 * Decision 9's area rule, which resolves *deterministically* and therefore silently wrongly.
 */
async function assertNameFree(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  name: string,
  exceptId?: Id<'waterBodySubAreas'>,
): Promise<void> {
  const key = name.trim().toLowerCase();
  const siblings = await subAreasForBody(ctx, waterBodyId);
  const clash = siblings.find(
    (row) => row._id !== exceptId && row.removedAt === undefined && row.name.toLowerCase() === key,
  );
  if (clash) throw new ConvexError(`This lake already has a sub-area called "${clash.name}"`);
}

/** Write the audit row for a sub-area mutation. Every write lands one (Decision 2). */
async function audit(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  action: 'create_sub_area' | 'redraw_sub_area' | 'rename_sub_area' | 'remove' | 'restore',
  subAreaId: Id<'waterBodySubAreas'>,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
    action,
    targetType: 'waterBodySubArea',
    targetId: subAreaId,
    reason,
    ...(metadata ? { metadata } : {}),
    createdAt: Date.now(),
  });
}

/**
 * Schedule the re-stamp of a parent's reports and hazards.
 *
 * **It pages to completion; it is never a capped scan.** N1's round-2 correction is the reason: the
 * hazard-weather sweep capped an index whose order never changes, so every tick re-read the same
 * prefix and everything behind it starved forever. A re-stamp capped at N over
 * `by_water_body_skate_end_time` would permanently strand the oldest reports on a busy body — and
 * unlike a stale decay multiplier, a wrong label is *visible*, on the feed card, next to a skater's
 * name. A cursor that self-reschedules until the body is exhausted has no such failure mode.
 */
export async function scheduleRestamp(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.subAreas.restampParent, {
    waterBodyId,
    table: RESTAMP_TABLES[0],
  });
}

/** Moderator: draw a new named sub-area inside a body (D60). */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    name: v.string(),
    aliases: v.optional(v.array(v.string())),
    /** The drawn outline. Clipped to the parent before storage — never stored as supplied. */
    polygon: geoJson,
    curatedBoost: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const name = args.name.trim();
    if (!name) throw new ConvexError('A sub-area needs a name');
    const parent = await requireParent(ctx, args.waterBodyId);
    await assertNameFree(ctx, args.waterBodyId, name);

    const geometry = deriveGeometry(args.polygon as unknown as Polygon | MultiPolygon, parent);
    const aliases = normalizeAliases(args.aliases);
    const scores = scoreFields({
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...(args.curatedBoost !== undefined ? { curatedBoost: args.curatedBoost } : {}),
    });
    const now = Date.now();

    const subAreaId = await ctx.db.insert('waterBodySubAreas', {
      waterBodyId: args.waterBodyId,
      name,
      ...(aliases.length > 0 ? { aliases } : {}),
      searchText: subAreaSearchText(name, aliases),
      polygon: geometry.polygon,
      bbox: geometry.bbox,
      centroid: geometry.centroid,
      representativePoint: geometry.centroid,
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...scores,
      ...(args.curatedBoost !== undefined ? { curatedBoost: args.curatedBoost } : {}),
      createdByUserId: actor._id,
      createdAt: now,
      updatedAt: now,
    });
    await syncSubAreaCells(ctx, subAreaId, {
      bbox: geometry.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      listed: true, // freshly drawn on a parent `requireParent` just proved is listed
    });
    await audit(ctx, actor._id, 'create_sub_area', subAreaId, `Drew "${name}" on ${parent.name}`, {
      waterBodyId: args.waterBodyId,
      clipped: geometry.clipped,
      retainedFraction: geometry.retainedFraction,
    });
    // A new bay claims reports and hazards that already sit inside it, so the label appears on the
    // history too rather than only on what's filed from now on.
    await scheduleRestamp(ctx, args.waterBodyId);
    return subAreaId;
  },
});

/** Moderator: replace a sub-area's outline (D60). Re-clips, re-scores, re-cells, re-stamps. */
export const redraw = mutation({
  args: { subAreaId: v.id('waterBodySubAreas'), polygon: geoJson },
  handler: async (ctx, { subAreaId, polygon }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const subArea = await ctx.db.get(subAreaId);
    if (!subArea) throw new ConvexError('Sub-area not found');
    const parent = await requireParent(ctx, subArea.waterBodyId);

    const geometry = deriveGeometry(polygon as unknown as Polygon | MultiPolygon, parent);
    const scores = scoreFields({
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...(subArea.curatedBoost !== undefined ? { curatedBoost: subArea.curatedBoost } : {}),
    });
    await ctx.db.patch(subAreaId, {
      polygon: geometry.polygon,
      bbox: geometry.bbox,
      centroid: geometry.centroid,
      representativePoint: geometry.centroid,
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...scores,
      // A redraw is the fix for an auto-delist, so it clears the note asking for one. (The row stays
      // delisted — `restore` is the separate, deliberate act of putting it back on the map.)
      systemDelistReason: undefined,
      updatedAt: Date.now(),
    });
    await syncSubAreaCells(ctx, subAreaId, {
      bbox: geometry.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      listed: subAreaListed(subArea, parent),
    });
    await audit(ctx, actor._id, 'redraw_sub_area', subAreaId, `Redrew "${subArea.name}"`, {
      waterBodyId: subArea.waterBodyId,
      clipped: geometry.clipped,
      retainedFraction: geometry.retainedFraction,
    });
    // Membership changed, so the stamps did too — in *both* directions. A shrunk bay releases reports
    // it no longer contains, which is why the job recomputes from the whole sub-area set rather than
    // testing only against the edited row.
    await scheduleRestamp(ctx, subArea.waterBodyId);
    return subAreaId;
  },
});

/**
 * Moderator: rename a sub-area or edit its aliases (D60).
 *
 * A rename re-stamps for the same reason a redraw does, even though membership didn't move: the
 * **name is denormalized** onto every report and hazard it labels, so leaving them alone would mean
 * the feed still says "Mallets Bay" long after the operator fixed the spelling.
 */
export const rename = mutation({
  args: {
    subAreaId: v.id('waterBodySubAreas'),
    name: v.optional(v.string()),
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { subAreaId, name, aliases }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const subArea = await ctx.db.get(subAreaId);
    if (!subArea) throw new ConvexError('Sub-area not found');
    if (name === undefined && aliases === undefined) {
      throw new ConvexError('Nothing to change');
    }

    const nextName = name === undefined ? subArea.name : name.trim();
    if (!nextName) throw new ConvexError('A sub-area needs a name');
    if (nextName.toLowerCase() !== subArea.name.toLowerCase()) {
      await assertNameFree(ctx, subArea.waterBodyId, nextName, subAreaId);
    }
    const nextAliases = aliases === undefined ? (subArea.aliases ?? []) : normalizeAliases(aliases);

    await ctx.db.patch(subAreaId, {
      name: nextName,
      aliases: nextAliases.length > 0 ? nextAliases : undefined,
      searchText: subAreaSearchText(nextName, nextAliases),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      actor._id,
      'rename_sub_area',
      subAreaId,
      name !== undefined && nextName !== subArea.name
        ? `Renamed "${subArea.name}" to "${nextName}"`
        : `Updated aliases for "${nextName}"`,
      { waterBodyId: subArea.waterBodyId, aliases: nextAliases },
    );
    // Only the name is denormalized, so an alias-only edit changes nothing downstream — skip the job.
    if (nextName !== subArea.name) await scheduleRestamp(ctx, subArea.waterBodyId);
    return subAreaId;
  },
});

/**
 * Moderator: soft-delist a sub-area (D60) — reversible, never a hard delete, same ethos as D48.
 *
 * It re-stamps too, which the plan didn't say and which matters: reports keep a delisted bay's name
 * on the feed card otherwise, pointing at a row nothing can navigate to.
 */
export const remove = mutation({
  args: { subAreaId: v.id('waterBodySubAreas'), reason: v.optional(v.string()) },
  handler: async (ctx, { subAreaId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const subArea = await ctx.db.get(subAreaId);
    if (!subArea) throw new ConvexError('Sub-area not found');
    if (subArea.removedAt !== undefined) throw new ConvexError('Sub-area is already removed');

    const now = Date.now();
    await ctx.db.patch(subAreaId, {
      removedAt: now,
      removedByUserId: actor._id,
      updatedAt: now,
    });
    await syncSubAreaCells(ctx, subAreaId, {
      bbox: subArea.bbox,
      minVisibleZoom: subArea.minVisibleZoom,
      listed: false,
    });
    await audit(
      ctx,
      actor._id,
      'remove',
      subAreaId,
      reason?.trim() || `Delisted "${subArea.name}"`,
      { waterBodyId: subArea.waterBodyId },
    );
    await scheduleRestamp(ctx, subArea.waterBodyId);
    return subAreaId;
  },
});

/**
 * Moderator: reverse a delist (D60). The parent still has to be listed for it to reach the map.
 *
 * **It re-clips on the way back in, and that's what closes Decision 10's one loophole.**
 * `reclipSubAreasToParent` deliberately skips delisted rows — re-clipping a retired bay would
 * resurrect geometry the operator put away — so a bay delisted *before* a shoreline refinement never
 * got held to the new outline. Restoring it without re-clipping would put a shape back on the map
 * that is no longer inside its parent, which is "inside by construction" decaying into "was true when
 * it was drawn": exactly the failure this phase spent its geometry rules avoiding. So restore is a
 * write like any other, and it establishes the invariant rather than assuming it survived.
 */
export const restore = mutation({
  args: { subAreaId: v.id('waterBodySubAreas') },
  handler: async (ctx, { subAreaId }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const subArea = await ctx.db.get(subAreaId);
    if (!subArea) throw new ConvexError('Sub-area not found');
    if (subArea.removedAt === undefined) throw new ConvexError('Sub-area is not removed');
    const parent = await ctx.db.get(subArea.waterBodyId);
    if (!parent) throw new ConvexError('Water body not found');

    // Held to the parent's *current* outline. A refusal here is informative rather than obstructive:
    // it means the lake moved under this bay while it was retired, and the answer is a redraw — which
    // is the paste-GeoJSON / draw path, not a flag someone flips.
    const geometry = deriveGeometry(subArea.polygon as unknown as Polygon | MultiPolygon, parent);
    const scores = scoreFields({
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...(subArea.curatedBoost !== undefined ? { curatedBoost: subArea.curatedBoost } : {}),
    });

    await ctx.db.patch(subAreaId, {
      removedAt: undefined,
      removedByUserId: undefined,
      systemDelistReason: undefined,
      polygon: geometry.polygon,
      bbox: geometry.bbox,
      centroid: geometry.centroid,
      representativePoint: geometry.centroid,
      surfaceAreaSqM: geometry.surfaceAreaSqM,
      ...scores,
      updatedAt: Date.now(),
    });
    await syncSubAreaCells(ctx, subAreaId, {
      bbox: geometry.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      // Restoring a bay on a delisted lake leaves it off the map, correctly — Decision 11 is a
      // conjunction, and this mutation isn't a way around it.
      listed: subAreaListed({ removedAt: undefined }, parent),
    });
    await audit(ctx, actor._id, 'restore', subAreaId, `Restored "${subArea.name}"`, {
      waterBodyId: subArea.waterBodyId,
    });
    await scheduleRestamp(ctx, subArea.waterBodyId);
    return subAreaId;
  },
});

/** Moderator: set a sub-area's `curatedBoost` (D49), so a bay can label wider than its area earns. */
export const setCuratedBoost = mutation({
  args: { subAreaId: v.id('waterBodySubAreas'), curatedBoost: v.number() },
  handler: async (ctx, { subAreaId, curatedBoost }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const subArea = await ctx.db.get(subAreaId);
    if (!subArea) throw new ConvexError('Sub-area not found');
    const parent = await ctx.db.get(subArea.waterBodyId);
    if (!parent) throw new ConvexError('Water body not found');

    const scores = scoreFields({ surfaceAreaSqM: subArea.surfaceAreaSqM, curatedBoost });
    await ctx.db.patch(subAreaId, { curatedBoost, ...scores, updatedAt: Date.now() });
    // The zoom is part of `by_cell`'s range, so the rows have to be restamped even though the shape
    // didn't move — the same trap `setCuratedBoost` on a body already documents.
    await syncSubAreaCells(ctx, subAreaId, {
      bbox: subArea.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      listed: subAreaListed(subArea, parent),
    });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_curated_boost',
      targetType: 'waterBodySubArea',
      targetId: subAreaId,
      reason: `Set curatedBoost to ${curatedBoost} on "${subArea.name}"`,
      metadata: { curatedBoost, minVisibleZoom: scores.minVisibleZoom },
      createdAt: Date.now(),
    });
    return subAreaId;
  },
});

/**
 * Re-stamp one page of a parent's reports or hazards, then reschedule itself until both tables are
 * exhausted (see `scheduleRestamp` for why this pages rather than caps).
 *
 * The stamp is recomputed from the **whole** current sub-area set, never from the row that was just
 * edited. Decision 9 says a point takes the smallest sub-area containing it, so shrinking "Outer
 * Malletts" can hand its reports to "Inner Malletts" and drawing a new bay can take reports away
 * from an older overlapping one. Testing only against the edited row would leave those stale, and
 * the result would depend on which sub-area was edited last — which is precisely the
 * order-dependence Decision 9 exists to remove.
 */
export const restampParent = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    table: v.union(v.literal('reports'), v.literal('hazards')),
    cursor: v.optional(v.string()),
    /** Rows re-stamped so far across every page and table — carried for the completion log. */
    stamped: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, table, cursor, stamped }) => {
    const active = (await subAreasForBody(ctx, waterBodyId)).filter(
      (row) => row.removedAt === undefined,
    );
    const candidates = active.map((row) => ({
      ref: row,
      polygon: row.polygon as unknown as Polygon | MultiPolygon,
      surfaceAreaSqM: row.surfaceAreaSqM,
    }));

    const page =
      table === 'reports'
        ? await ctx.db
            .query('reports')
            .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
            .paginate({ cursor: cursor ?? null, numItems: RESTAMP_BATCH })
        : // Hazards have no skate-end index — that one is reports-only — so the hazard half pages
          // `by_water_body`. Any total order works here; the job visits every row either way.
          await ctx.db
            .query('hazards')
            .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
            .paginate({ cursor: cursor ?? null, numItems: RESTAMP_BATCH });

    let changed = stamped ?? 0;
    for (const row of page.page) {
      const point = 'point' in row ? row.point : hazardCenter(row);
      const match = smallestContainingSubArea(point, candidates);
      const nextId = match?._id;
      const nextName = match?.name;
      if (row.subAreaId === nextId && row.subAreaName === nextName) continue;
      await ctx.db.patch(row._id, { subAreaId: nextId, subAreaName: nextName });
      changed++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.subAreas.restampParent, {
        waterBodyId,
        table,
        cursor: page.continueCursor,
        stamped: changed,
      });
      return { done: false as const, stamped: changed };
    }
    const nextTable = RESTAMP_TABLES[RESTAMP_TABLES.indexOf(table) + 1] as RestampTable | undefined;
    if (nextTable) {
      await ctx.scheduler.runAfter(0, internal.subAreas.restampParent, {
        waterBodyId,
        table: nextTable,
        stamped: changed,
      });
      return { done: false as const, stamped: changed };
    }
    console.log(`subAreas.restampParent(${waterBodyId}): re-stamped ${changed} rows (N2).`);
    return { done: true as const, stamped: changed };
  },
});

/**
 * Sub-area render budgets (N2). **Product numbers, chosen and then measured** — not arithmetic
 * inherited from N1's table.
 *
 * The plan sized these against the headroom N1's viewport read leaves under Convex's 4,096-read cap,
 * which assumes the two queries share a budget. They don't: the cap is per *function execution*
 * (`lib/scan.ts` opens by saying so), and `listInViewport` on each table is its own execution with
 * its own 4,096. What survives that correction is the product argument, which was always the real
 * one — two layers on one screen is latency and payload a skater feels, and 250 bay outlines is
 * already more than any real viewport will hold, since the whole corpus is expected to carry a few
 * dozen. So: a deliberately tight ceiling, logged when it binds, and re-measured against the real
 * Champlain draw via `subAreaReadStats` rather than trusted.
 */
const SUB_AREA_RENDER_LIMIT = 250;
/** Cell rows one sub-area read may scan. Also bounds hydration — one `get` per distinct candidate. */
const SUB_AREA_ROW_SCAN_BUDGET = 200;
/** The same absurdity guards as the body layer: these bound the *plan*, and cells are nearly free. */
const SUB_AREA_MAX_CELLS_PER_LEVEL = 256;
const SUB_AREA_CELL_SCAN_BUDGET = 512;
const SUB_AREA_MIN_ROWS_PER_CELL = 4;

/**
 * Total polygon vertices one sub-area read may return (N2).
 *
 * The render budget above counts *rows*, and rows are not the thing a phone downloads. A clipped bay
 * inherits its parent's shoreline detail — measured on the dev corpus, Champlain's nine bays carry
 * 60–1,108 vertices each (Broad Lake alone is 27 KB), because the clip traces OSM's own coastline.
 * 250 rows at that density would be several megabytes in one query response, which no read-count
 * measurement would ever have shown.
 *
 * So the payload gets its own ceiling, spent in prominence order like the row budget, and truncation
 * is logged rather than silent (D5). It is deliberately generous: the measured worst real viewport
 * uses ~2,300 of it.
 */
const SUB_AREA_RENDER_VERTEX_BUDGET = 40_000;

/** The shared scan behind `listInViewport` and its read-stats sibling. */
async function subAreasCoveringBox(
  ctx: QueryCtx,
  box: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  opts: { zoom: number; limit: number; maxRows?: number },
): Promise<{
  rows: Doc<'waterBodySubAreas'>[];
  truncated: boolean;
  rowsRead: number;
  cellsScanned: number;
  /** Polygon vertices in the returned set — what the client actually downloads. */
  vertices: number;
}> {
  const scan = await scanCells<Id<'waterBodySubAreas'>>(
    box,
    WATER_BODY_LADDER,
    {
      maxCellsPerLevel: SUB_AREA_MAX_CELLS_PER_LEVEL,
      cellBudget: SUB_AREA_CELL_SCAN_BUDGET,
      rowBudget: Math.min(opts.maxRows ?? SUB_AREA_ROW_SCAN_BUDGET, SUB_AREA_ROW_SCAN_BUDGET),
      minRowsPerCell: SUB_AREA_MIN_ROWS_PER_CELL,
      limit: opts.limit,
    },
    { zoom: opts.zoom, label: 'waterBodySubAreaCells' },
    async (cell, probe, atZoom) => {
      const cellRows = await ctx.db
        .query('waterBodySubAreaCells')
        .withIndex('by_cell', (q) => {
          const atCell = q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y);
          return atZoom === undefined ? atCell : atCell.lte('minVisibleZoom', atZoom);
        })
        .take(probe);
      return cellRows.map((row) => ({ ref: row.subAreaId, minVisibleZoom: row.minVisibleZoom }));
    },
  );

  // Pass 2 — hydrate in global prominence order. Same reason as the body layer: ranking a
  // spatially-selected prefix would draw Champlain's bays and none of Lake George's depending on
  // cell arithmetic, which is the round-3 bug wearing a smaller hat.
  let truncated = scan.truncated;
  let vertices = 0;
  const rows: Doc<'waterBodySubAreas'>[] = [];
  for (const subAreaId of rankCandidates(scan.candidates)) {
    if (rows.length >= opts.limit) {
      truncated = true;
      break;
    }
    const subArea = await ctx.db.get(subAreaId);
    // Defense in depth, as on the body layer: a delisted bay — or one whose lake was taken down —
    // has no cell rows to be found through in the first place (Decision 11).
    if (!subArea || subArea.removedAt !== undefined) continue;
    if (!bboxIntersects(subArea.bbox, box)) continue;
    // The payload ceiling, spent in the same prominence order as the row budget so a truncation drops
    // the least prominent bays rather than whichever the walk reached last.
    const cost = polygonVertexCount(subArea.polygon);
    if (rows.length > 0 && vertices + cost > SUB_AREA_RENDER_VERTEX_BUDGET) {
      truncated = true;
      break;
    }
    vertices += cost;
    rows.push(subArea);
  }
  return {
    rows,
    truncated,
    rowsRead: scan.rowsRead,
    cellsScanned: scan.cellsScanned,
    vertices,
  };
}

/**
 * Public: named sub-areas whose bbox intersects the viewport (N2 / D60) — the map's bay-label layer,
 * served off `waterBodySubAreaCells` on N1's shared ladder grid.
 *
 * **Why this isn't a fan-out over the bodies already on screen.** The plan's first cut called
 * `listForBodies(waterBodyIds[])` with the ids `waterBodies.listInViewport` returned — a read whose
 * input is the *render budget*, now 1,000. "Sub-areas only exist on a handful of giants" is a fact
 * about today's data, not a bound, and reasoning from today's data is exactly what N1 exists to
 * retire: `MAX_VIEWPORT_LIMIT = 256` was also fine, against a corpus 11.6× smaller than the one it
 * was still guarding.
 *
 * Returns nothing below `SUB_AREA_MIN_RENDER_ZOOM` — not a filter, a decision not to run the query.
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()), zoom: v.number() },
  handler: async (ctx, { viewport, limit, zoom }) => {
    const z = Math.floor(zoom);
    if (z < SUB_AREA_MIN_RENDER_ZOOM) return [];
    const effectiveLimit =
      limit !== undefined && Number.isInteger(limit) && limit > 0
        ? Math.min(limit, SUB_AREA_RENDER_LIMIT)
        : SUB_AREA_RENDER_LIMIT;

    const { rows, truncated, rowsRead, vertices } = await subAreasCoveringBox(ctx, viewport, {
      zoom: z,
      limit: effectiveLimit,
    });
    if (truncated) {
      console.warn(
        `subAreas.listInViewport stopped early at zoom ${z} with ${rows.length} sub-areas (render budget ${effectiveLimit}, vertex budget ${SUB_AREA_RENDER_VERTEX_BUDGET}, ${rowsRead} cell rows read, ${vertices} vertices returned); the least prominent were omitted (D5/D49/N1).`,
      );
    }
    return rows.map((row) => ({
      _id: row._id,
      waterBodyId: row.waterBodyId,
      name: row.name,
      polygon: row.polygon,
      bbox: row.bbox,
      centroid: row.centroid,
      minVisibleZoom: row.minVisibleZoom,
    }));
  },
});

/**
 * Internal: what one sub-area viewport read actually costs — the sibling of
 * `waterBodies.viewportReadStats`, and the reason the budgets above can be called *measured* rather
 * than guessed:
 * `pnpm exec convex run subAreas:subAreaReadStats '{"viewport": {...}, "zoom": 12}'`.
 *
 * Run it against the same viewport as the body version and record **both** figures. They don't share
 * a read cap (see the budget note above), but they do share a screen, and the pair is the number
 * that says whether the bay layer is worth what it costs.
 */
export const subAreaReadStats = internalQuery({
  args: {
    viewport: bbox,
    zoom: v.number(),
    limit: v.optional(v.number()),
    maxRows: v.optional(v.number()),
    names: v.optional(v.boolean()),
  },
  handler: async (ctx, { viewport, zoom, limit, maxRows, names }) => {
    const { rows, truncated, rowsRead, cellsScanned, vertices } = await subAreasCoveringBox(
      ctx,
      viewport,
      {
        zoom: Math.floor(zoom),
        limit: Math.min(limit ?? SUB_AREA_RENDER_LIMIT, SUB_AREA_RENDER_LIMIT),
        ...(maxRows !== undefined ? { maxRows } : {}),
      },
    );
    return {
      subAreas: rows.length,
      cellsScanned,
      cellRowsRead: rowsRead,
      // The read the 4,096 cap actually counts: index rows + one hydrating get per distinct row.
      approxDocumentReads: cellsScanned + rowsRead + rows.length,
      // And what the *client* pays, which the read count says nothing about: a clipped bay inherits
      // its parent's shoreline, so the payload is vertices, not rows.
      vertices,
      truncated,
      ...(names ? { names: rows.map((r) => r.name) } : {}),
    };
  },
});

/**
 * Internal seed (run via `pnpm exec convex run`, no auth) — draw a batch of named sub-areas from
 * explicit `(parentId, name, box)` rows.
 *
 * This is how the curation session runs, and how **prod** gets the same curation later without
 * anyone re-drawing fourteen bays by hand. Mirrors `waterBodies.applyCuratedBoostSeed`'s shape: an
 * internal mutation invoked from the CLI, doing exactly what the moderator mutation does minus the
 * role gate, with an explicit `actorUserId` so the `moderationActions` row still names a human.
 *
 * **The input is a bounding box, not a traced outline, and that's the point.** Decision 10 clips
 * every drawn shape to the parent anyway, so a rectangle over a bay *becomes* the bay's water: the
 * shoreline comes from OSM's own polygon rather than from anyone's tracing. What a seed row asserts
 * is only "the water inside this box is called X" — which is a claim about naming, the thing the
 * corpus actually evidences, rather than a claim about geometry it doesn't.
 *
 * Rows are independent: a box that fails the retention threshold is reported and skipped, never
 * aborting the batch, because a fourteen-bay session shouldn't lose thirteen good draws to one bad
 * rectangle.
 */
export const importSeed = internalMutation({
  args: {
    /** Whose name goes on the audit rows — the operator running the session. */
    actorUserId: v.id('profiles'),
    seed: v.array(
      v.object({
        waterBodyId: v.id('waterBodies'),
        name: v.string(),
        aliases: v.optional(v.array(v.string())),
        /** A rectangle over the bay. The clip turns it into the bay's actual water. */
        box: bbox,
        curatedBoost: v.optional(v.number()),
      }),
    ),
    /** Report what each row *would* do without writing anything — run this first. */
    dryRun: v.optional(v.boolean()),
    /**
     * The clip-retention bar for this batch, **looser than the interactive default and
     * deliberately so** (measured in the N2 curation session, 2026-07-26).
     *
     * `SUB_AREA_MIN_RETAINED_FRACTION` = 0.6 is calibrated for a *traced* outline, where most of
     * what you drew should be water. A seed row is a bounding box, which is coarse by construction:
     * a bay is enclosed by land, so a rectangle around one always swallows some. The measured
     * spread over the real Champlain bays was 0.92 / 0.82 / 0.75 / 0.71 / 0.70 / 0.69 / 0.66 / 0.61
     * for boxes on the right water, against 0.16–0.17 for two that were simply in the wrong place —
     * and the Inland Sea, a genuine archipelago arm, tops out near 0.42 because roughly half of any
     * rectangle over it is islands.
     *
     * So the bar the threshold has to clear is "is this box on the right water", not "is this box a
     * good shape", and the gap between 0.42 and 0.17 is where it belongs. What gets *stored* is the
     * clip either way, so a loose box costs nothing in the data — only the check loosens.
     */
    minRetainedFraction: v.optional(v.number()),
  },
  handler: async (ctx, { actorUserId, seed, dryRun, minRetainedFraction }) => {
    const bar = minRetainedFraction ?? SEED_MIN_RETAINED_FRACTION;
    const results: Array<Record<string, unknown>> = [];
    const restamp = new Set<Id<'waterBodies'>>();

    for (const row of seed) {
      const parent = await ctx.db.get(row.waterBodyId);
      if (!parent || !isListed(parent)) {
        results.push({ name: row.name, ok: false, reason: 'parent_unavailable' });
        continue;
      }
      const drawn = boxPolygon(row.box);
      const clip = clipSubAreaToParent(
        drawn,
        parent.polygon as unknown as Polygon | MultiPolygon,
        bar,
      );
      if (!clip.ok) {
        results.push({
          name: row.name,
          ok: false,
          reason: clip.reason,
          retained: Math.round(clip.retainedFraction * 100) / 100,
        });
        continue;
      }
      const area = surfaceAreaSqM(clip.polygon);
      const scores = scoreFields({
        surfaceAreaSqM: area,
        ...(row.curatedBoost !== undefined ? { curatedBoost: row.curatedBoost } : {}),
      });
      const summary = {
        name: row.name,
        ok: true,
        parent: parent.name,
        areaKm2: Math.round((area / 1e6) * 100) / 100,
        retained: Math.round(clip.retainedFraction * 100) / 100,
        drawsFromZoom: scores.minVisibleZoom,
      };
      if (dryRun) {
        results.push({ ...summary, dryRun: true });
        continue;
      }

      const existing = (await subAreasForBody(ctx, row.waterBodyId)).find(
        (s) => s.removedAt === undefined && s.name.toLowerCase() === row.name.trim().toLowerCase(),
      );
      if (existing) {
        results.push({ ...summary, ok: false, reason: 'name_taken' });
        continue;
      }

      const aliases = normalizeAliases(row.aliases);
      const now = Date.now();
      const subAreaId = await ctx.db.insert('waterBodySubAreas', {
        waterBodyId: row.waterBodyId,
        name: row.name.trim(),
        ...(aliases.length > 0 ? { aliases } : {}),
        searchText: subAreaSearchText(row.name.trim(), aliases),
        polygon: clip.polygon,
        bbox: polygonBBox(clip.polygon),
        centroid: representativePoint(clip.polygon),
        representativePoint: representativePoint(clip.polygon),
        surfaceAreaSqM: area,
        ...scores,
        ...(row.curatedBoost !== undefined ? { curatedBoost: row.curatedBoost } : {}),
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
      await syncSubAreaCells(ctx, subAreaId, {
        bbox: polygonBBox(clip.polygon),
        minVisibleZoom: scores.minVisibleZoom,
        listed: true,
      });
      await ctx.db.insert('moderationActions', {
        actorId: actorUserId,
        action: 'create_sub_area',
        targetType: 'waterBodySubArea',
        targetId: subAreaId,
        reason: `Seeded "${row.name.trim()}" on ${parent.name} (N2 curation session)`,
        metadata: { waterBodyId: row.waterBodyId, retainedFraction: clip.retainedFraction },
        createdAt: now,
      });
      restamp.add(row.waterBodyId);
      results.push({ ...summary, subAreaId });
    }

    // One re-stamp per touched parent, after the whole batch — fourteen bays on Champlain should
    // schedule one sweep, not fourteen.
    for (const waterBodyId of restamp) await scheduleRestamp(ctx, waterBodyId);
    return {
      drawn: results.filter((r) => r.ok === true && r.dryRun !== true).length,
      refused: results.filter((r) => r.ok === false).length,
      results,
    };
  },
});

/** Positions across every ring — the render payload's real unit. See the vertex budget above. */
function polygonVertexCount(geometry: unknown): number {
  const g = geometry as { type?: string; coordinates?: unknown[] };
  if (g?.type === 'Polygon') {
    return (g.coordinates as unknown[][]).reduce((n, ring) => n + ring.length, 0);
  }
  if (g?.type === 'MultiPolygon') {
    return (g.coordinates as unknown[][][]).reduce(
      (n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0),
      0,
    );
  }
  return 0;
}

/** A bbox as a closed GeoJSON rectangle — the seed's input shape before the clip. */
function boxPolygon(box: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [box.minLng, box.minLat],
        [box.maxLng, box.minLat],
        [box.maxLng, box.maxLat],
        [box.minLng, box.maxLat],
        [box.minLng, box.minLat],
      ],
    ],
  };
}

/**
 * The sub-areas on one body, for the lake editor and the body detail's filter. Delisted rows are
 * included with their flag so the editor can offer a restore; public callers filter them out.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const rows = await subAreasForBody(ctx, waterBodyId);
    return rows
      .sort((a, b) => b.surfaceAreaSqM - a.surfaceAreaSqM)
      .map((row) => ({
        _id: row._id,
        name: row.name,
        aliases: row.aliases ?? [],
        polygon: row.polygon,
        bbox: row.bbox,
        centroid: row.centroid,
        surfaceAreaSqM: row.surfaceAreaSqM,
        minVisibleZoom: row.minVisibleZoom,
        ...(row.curatedBoost !== undefined ? { curatedBoost: row.curatedBoost } : {}),
        removed: row.removedAt !== undefined,
        // Why the *system* retired it, if it did — the editor renders this next to the row, which is
        // the whole point of storing it rather than logging it (N2).
        ...(row.systemDelistReason !== undefined
          ? { systemDelistReason: row.systemDelistReason }
          : {}),
      }));
  },
});
