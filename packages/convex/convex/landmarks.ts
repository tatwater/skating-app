/**
 * Named landmarks (D202) — the islands, points, reference bays, narrows, river mouths, bridges,
 * marinas, lighthouses, dams, shore towns and shore establishments a body is steered by.
 *
 * Three writers, one table:
 *
 * - **The ETL** (`scripts/etl load-landmarks`) — OSM + GNIS, matched to a body *offline* against a
 *   geometry export (`listBodyGeometry`), then written one body per call (`importForBody`). Matching
 *   here, per point, would read the candidate body's polygon once per landmark — Champlain's ~300 KB
 *   for each of its several hundred — which is the A06d parking pass's 105 GB mistake again.
 * - **A moderator** on the lake editor: drop a point, name it, pick a kind; rename, move, re-kind,
 *   remove, restore. An edit sets `moderatorEditedAt`, and a re-run of the ETL then leaves the name,
 *   kind and point alone.
 * - **The chord tool**, when a landmark is promoted to a bay (`retireAsPromoted`).
 *
 * One reader shape: `listForBody`, bounded per body and never viewport-wide, carrying the prominence
 * and label zoom both maps sort and filter by. A landmark is a label, never a place: nothing here
 * links to a page, and nothing here says anything about the ice (D3).
 */

import {
  haversineMeters,
  LANDMARK_KINDS,
  type LandmarkKind,
  landmarkLabelMinZoom,
  landmarkNameKey,
  landmarkProminence,
  MAX_LANDMARKS_PER_BODY,
  normalizeLandmarkNames,
} from '@skating/core';
import { ConvexError, type Infer, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
import { auditLandmark, landmarksForBody, subAreaFor } from './lib/landmarkRows';
import { isListed } from './lib/listing';
import { latLng, literals } from './lib/validators';
import { stampCandidates } from './subAreas';

/** The label-ready view of a row: what both maps and the sheet read. */
function toView(row: Doc<'bodyLandmarks'>) {
  const input = {
    kind: row.kind,
    areaSqM: row.areaSqM,
    corpusMessages: row.corpusMessages,
    reportCount: row.reportCount,
  };
  return {
    _id: row._id,
    name: row.name,
    kind: row.kind,
    point: row.point,
    aliases: row.aliases,
    ...(row.subAreaId !== undefined ? { subAreaId: row.subAreaId } : {}),
    ...(row.areaSqM !== undefined ? { areaSqM: row.areaSqM } : {}),
    prominence: landmarkProminence(input),
    minZoom: landmarkLabelMinZoom({ ...input, lat: row.point.lat }),
  };
}

export type LandmarkView = ReturnType<typeof toView>;

/**
 * The live landmarks on one body, most prominent first — the map's label layer, the sheet's list.
 * Public, like the body's hazards and put-ins: a name on a map is not personal data.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const rows = await landmarksForBody(ctx, waterBodyId);
    return rows
      .filter((row) => row.removedAt === undefined)
      .map(toView)
      .sort((a, b) => b.prominence - a.prominence || a.name.localeCompare(b.name));
  },
});

/**
 * Moderator: every landmark on a body, removed ones flagged — the lake editor's list, which offers a
 * restore. Carries the provenance a moderator needs to judge a row (where it came from, whether a
 * person already vouched for it).
 */
export const listForEditor = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireRole(ctx, 'moderator');
    const rows = await landmarksForBody(ctx, waterBodyId);
    return rows
      .map((row) => ({
        ...toView(row),
        source: row.source,
        externalIds: row.externalIds,
        ...(row.corpusMessages !== undefined ? { corpusMessages: row.corpusMessages } : {}),
        ...(row.moderatorEditedAt !== undefined
          ? { moderatorEditedAt: row.moderatorEditedAt }
          : {}),
        ...(row.removedAt !== undefined ? { removedAt: row.removedAt } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The ETL's two ends
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Listed bodies with their geometry, paged — the one read of the corpus the landmark ETL makes, so
 * that every point is matched offline rather than by a per-point lookup here.
 *
 * **A byte budget, not a row budget** (`sweepBodySummaries`): `paginate` reads whole documents, and a
 * page of Champlains is 300 KB each. 50 a page keeps an all-giants page an order of magnitude under
 * Convex's 16 MB read cap. The whole walk reads each body once — ~45 MB over ~25,000 bodies — which is
 * less than a single one of the per-point lookups it replaces would have cost at Champlain's shore.
 */
export const listBodyGeometry = internalQuery({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(200, Math.max(1, batchSize ?? 50));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const bodies = page.page.filter(isListed).map((body) => ({
      _id: body._id,
      name: body.name,
      states: body.states,
      polygon: body.polygon,
      bbox: body.bbox,
      surfaceAreaSqM: body.surfaceAreaSqM,
    }));
    return { bodies, cursor: page.continueCursor, isDone: page.isDone };
  },
});

const importedLandmark = v.object({
  name: v.string(),
  kind: literals(LANDMARK_KINDS),
  point: latLng,
  areaSqM: v.optional(v.number()),
  /** `osm` or `gnis` — which catalog the row's name and point came from. */
  source: v.union(v.literal('osm'), v.literal('gnis')),
  externalIds: v.array(v.string()),
  aliases: v.array(v.string()),
  corpusMessages: v.optional(v.number()),
});

/**
 * How far apart one landmark's two sightings may be and still be one landmark, when they share a
 * name but no id — a moderator's dropped pin that the ETL later finds in GNIS, or an island OSM draws
 * as a polygon and GNIS as a point on its far end.
 */
const SAME_NAME_RADIUS_M = 1_000;

/** Which kinds may be the same place under two names in two catalogs — GNIS's "Bay" is OSM's bay. */
function kindsMeet(a: LandmarkKind, b: LandmarkKind): boolean {
  return a === b || a === 'other' || b === 'other';
}

/**
 * Load landmarks for a batch of bodies — **dry unless `dryRun: false`**, as every loader in
 * `scripts/etl` is. Batched across bodies because ten thousand bodies carry one or two landmarks
 * each, and one `convex run` per body would be hours of process spawns for seconds of writes. The
 * loader packs batches by landmark count; a giant's list may span several calls, each re-reading the
 * body's rows so the cap and the merge stay exact.
 *
 *
 * Idempotent: a candidate finds its row by any shared upstream id, else by name within
 * {@link SAME_NAME_RADIUS_M}; found rows are updated in place and nothing is ever duplicated. A
 * candidate named for one of the body's live bays is skipped (`alreadyBay`). Three kinds of row are
 * **held**: a removed one stays removed (a re-run must not resurrect what a
 * moderator took down), a moderator-edited one keeps its name, kind and point (it gains ids, aliases
 * and the corpus count), and a new row past `MAX_LANDMARKS_PER_BODY` is refused and counted — the
 * cap is enforced here so the read can trust it.
 *
 * For each body: a body that is no longer listed is skipped whole: the export it was matched against is older than
 * this call, and a lake removed in between should not gain labels.
 */
type ImportCounts = {
  created: number;
  updated: number;
  unchanged: number;
  removedHeld: number;
  moderatorHeld: number;
  overCap: number;
  bodyNotListed: number;
  alreadyBay: number;
};

export const importBatch = internalMutation({
  args: {
    bodies: v.array(
      v.object({ waterBodyId: v.id('waterBodies'), landmarks: v.array(importedLandmark) }),
    ),
    campaignId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { bodies, campaignId, dryRun }) => {
    const total: ImportCounts = {
      created: 0,
      updated: 0,
      unchanged: 0,
      removedHeld: 0,
      moderatorHeld: 0,
      overCap: 0,
      bodyNotListed: 0,
      alreadyBay: 0,
    };
    for (const { waterBodyId, landmarks } of bodies) {
      const counts = await importOneBody(ctx, waterBodyId, landmarks, campaignId, dryRun === false);
      for (const key of Object.keys(total) as (keyof ImportCounts)[]) total[key] += counts[key];
    }
    return total;
  },
});

async function importOneBody(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  landmarks: Infer<typeof importedLandmark>[],
  campaignId: string | undefined,
  write: boolean,
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    removedHeld: 0,
    moderatorHeld: 0,
    overCap: 0,
    bodyNotListed: 0,
    alreadyBay: 0,
  };
  const body = await ctx.db.get(waterBodyId);
  if (!body || !isListed(body)) {
    counts.bodyNotListed = landmarks.length;
    return counts;
  }

  const rows = await landmarksForBody(ctx, waterBodyId);
  let live = rows.filter((row) => row.removedAt === undefined).length;
  const candidates = await stampCandidates(ctx, waterBodyId);
  // A name a live bay already answers to is the bay's (D202): "Malletts Bay" the village and
  // "Malletts Bay" the sub-area would be two labels saying one thing, and the bay is the place.
  const bayKeys = new Set(
    candidates.flatMap(({ ref }) => [ref.name, ...(ref.aliases ?? [])].map(landmarkNameKey)),
  );
  const now = Date.now();
  const claimed = new Set<Id<'bodyLandmarks'>>();

  for (const incoming of landmarks) {
    const names = normalizeLandmarkNames(incoming.name, incoming.aliases);
    if (!names) continue;
    const keys = new Set([names.name, ...names.aliases].map(landmarkNameKey));
    if (bayKeys.has(landmarkNameKey(names.name))) {
      counts.alreadyBay++;
      continue;
    }
    const ids = new Set(incoming.externalIds);
    const existing =
      rows.find((row) => row.externalIds.some((id) => ids.has(id))) ??
      rows.find(
        (row) =>
          kindsMeet(row.kind, incoming.kind) &&
          [row.name, ...row.aliases].some((n) => keys.has(landmarkNameKey(n))) &&
          haversineMeters(row.point, incoming.point) <= SAME_NAME_RADIUS_M,
      );

    if (!existing) {
      if (live >= MAX_LANDMARKS_PER_BODY) {
        counts.overCap++;
        continue;
      }
      live++;
      counts.created++;
      const doc = {
        waterBodyId,
        name: names.name,
        kind: incoming.kind,
        point: incoming.point,
        ...(incoming.areaSqM !== undefined ? { areaSqM: incoming.areaSqM } : {}),
        ...(subAreaFor(incoming.point, candidates) ?? {}),
        source: incoming.source,
        externalIds: [...ids],
        aliases: names.aliases,
        ...(incoming.corpusMessages !== undefined
          ? { corpusMessages: incoming.corpusMessages }
          : {}),
        ...(campaignId !== undefined ? { lastCampaignId: campaignId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      // Found again by a later candidate in this same call (a GNIS twin of an OSM island), so the two
      // merge here rather than landing as two rows the next run would have to reconcile. A dry run
      // tracks its would-be rows the same way, so its counts are the counts an apply reports.
      const id = write
        ? await ctx.db.insert('bodyLandmarks', doc)
        : (`dry:${rows.length}` as Id<'bodyLandmarks'>);
      rows.push({ ...doc, _id: id, _creationTime: now });
      claimed.add(id);
      continue;
    }

    if (existing.removedAt !== undefined) {
      counts.removedHeld++;
      continue;
    }

    // A row this call already wrote keeps the first candidate's name and point: two candidates
    // resolving to one row would otherwise take turns overwriting it, run after run.
    const firstClaim = !claimed.has(existing._id);
    claimed.add(existing._id);
    const held = existing.moderatorEditedAt !== undefined || !firstClaim;

    const externalIds = [...new Set([...existing.externalIds, ...ids])];
    const merged = normalizeLandmarkNames(existing.name, [
      ...existing.aliases,
      ...(held ? [names.name] : []),
      ...names.aliases,
    ]);
    const aliases = merged?.aliases ?? existing.aliases;
    const corpusMessages =
      Math.max(existing.corpusMessages ?? 0, incoming.corpusMessages ?? 0) || undefined;

    let patch: Partial<Doc<'bodyLandmarks'>>;
    if (held) {
      if (existing.moderatorEditedAt !== undefined) counts.moderatorHeld++;
      patch = { externalIds, aliases, corpusMessages };
    } else {
      patch = {
        name: names.name,
        kind: incoming.kind,
        point: incoming.point,
        areaSqM: incoming.areaSqM,
        subAreaId: subAreaFor(incoming.point, candidates)?.subAreaId,
        externalIds,
        aliases:
          normalizeLandmarkNames(names.name, [...existing.aliases, ...names.aliases])?.aliases ??
          aliases,
        corpusMessages,
      };
    }
    // Counted once per row: a moderator's row is `moderatorHeld`, a second claim is part of the first.
    const counted = !held;
    if (unchanged(existing, patch)) {
      if (counted) counts.unchanged++;
      continue;
    }
    if (counted) counts.updated++;
    if (write) {
      await ctx.db.patch(existing._id, {
        ...patch,
        ...(campaignId !== undefined ? { lastCampaignId: campaignId } : {}),
        updatedAt: now,
      });
      Object.assign(existing, patch);
    }
  }
  return counts;
}

/** Would this patch change nothing a reader sees? Arrays compare as sets, in order-insensitive form. */
function unchanged(row: Doc<'bodyLandmarks'>, patch: Partial<Doc<'bodyLandmarks'>>): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const current = row[key as keyof Doc<'bodyLandmarks'>];
    if (Array.isArray(value) || Array.isArray(current)) {
      const a = [...((current as string[] | undefined) ?? [])].sort();
      const b = [...((value as string[] | undefined) ?? [])].sort();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
    } else if (value !== null && typeof value === 'object') {
      if (JSON.stringify(value) !== JSON.stringify(current)) return false;
    } else if (value !== current) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A moderator's hand
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function cleanNames(name: string, aliases: readonly string[] | undefined) {
  const names = normalizeLandmarkNames(name, aliases ?? []);
  if (!names) throw new ConvexError('A landmark needs a name of 80 characters or fewer');
  return names;
}

/**
 * Refuse a second live landmark that is the same place as one this lake already has — any name or
 * alias of one folding to any of the other, within {@link SAME_NAME_RADIUS_M}. Distance matters here
 * where it does not for bays: "Long Point" is on half the lakes in Vermont, and on Champlain twice.
 */
function assertNotDuplicate(
  rows: readonly Doc<'bodyLandmarks'>[],
  names: readonly string[],
  point: { lat: number; lng: number },
  exceptId?: Id<'bodyLandmarks'>,
): void {
  const keys = new Set(names.map(landmarkNameKey));
  const clash = rows.find(
    (row) =>
      row._id !== exceptId &&
      row.removedAt === undefined &&
      [row.name, ...row.aliases].some((n) => keys.has(landmarkNameKey(n))) &&
      haversineMeters(row.point, point) <= SAME_NAME_RADIUS_M,
  );
  if (clash) throw new ConvexError(`"${clash.name}" is already a landmark here`);
}

async function requireBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'>> {
  const body = await ctx.db.get(waterBodyId);
  if (!body) throw new ConvexError('That water body no longer exists');
  return body;
}

/** Moderator: drop a named point on a lake (D202). */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    name: v.string(),
    kind: literals(LANDMARK_KINDS),
    point: latLng,
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    await requireBody(ctx, args.waterBodyId);
    const names = cleanNames(args.name, args.aliases);
    const rows = await landmarksForBody(ctx, args.waterBodyId);
    assertNotDuplicate(rows, [names.name, ...names.aliases], args.point);
    if (rows.filter((row) => row.removedAt === undefined).length >= MAX_LANDMARKS_PER_BODY) {
      throw new ConvexError(`This lake already has ${MAX_LANDMARKS_PER_BODY} landmarks`);
    }
    const now = Date.now();
    const id = await ctx.db.insert('bodyLandmarks', {
      waterBodyId: args.waterBodyId,
      name: names.name,
      kind: args.kind,
      point: args.point,
      ...(subAreaFor(args.point, await stampCandidates(ctx, args.waterBodyId)) ?? {}),
      source: 'moderator',
      externalIds: [],
      aliases: names.aliases,
      moderatorEditedAt: now,
      createdByUserId: actor._id,
      createdAt: now,
      updatedAt: now,
    });
    await auditLandmark(ctx, actor._id, 'create_landmark', id, `Added "${names.name}"`, {
      kind: args.kind,
    });
    return id;
  },
});

/**
 * Moderator: rename, move or re-kind a landmark, or change its aliases. Marks the row as a
 * moderator's, so the next ETL run keeps what was set here.
 */
export const update = mutation({
  args: {
    landmarkId: v.id('bodyLandmarks'),
    name: v.optional(v.string()),
    kind: v.optional(literals(LANDMARK_KINDS)),
    point: v.optional(latLng),
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(args.landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    const names = cleanNames(args.name ?? row.name, args.aliases ?? row.aliases);
    const point = args.point ?? row.point;
    const rows = await landmarksForBody(ctx, row.waterBodyId);
    assertNotDuplicate(rows, [names.name, ...names.aliases], point, row._id);
    const now = Date.now();
    const moved = args.point !== undefined;
    await ctx.db.patch(row._id, {
      name: names.name,
      aliases: names.aliases,
      kind: args.kind ?? row.kind,
      point,
      // A moved point may have crossed into (or out of) a bay; an unmoved one keeps its stamp.
      ...(moved
        ? { subAreaId: subAreaFor(point, await stampCandidates(ctx, row.waterBodyId))?.subAreaId }
        : {}),
      moderatorEditedAt: now,
      updatedAt: now,
    });
    await auditLandmark(ctx, actor._id, 'edit_landmark', row._id, `Edited "${names.name}"`, {
      ...(names.name !== row.name ? { from: row.name } : {}),
      ...(moved ? { moved: true } : {}),
      ...(args.kind !== undefined && args.kind !== row.kind ? { kind: args.kind } : {}),
    });
  },
});

/** Moderator: take a landmark off the map. Soft, so a re-run of the ETL never brings it back. */
export const remove = mutation({
  args: { landmarkId: v.id('bodyLandmarks'), reason: v.optional(v.string()) },
  handler: async (ctx, { landmarkId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    if (row.removedAt !== undefined) return;
    await ctx.db.patch(landmarkId, { removedAt: Date.now(), updatedAt: Date.now() });
    await auditLandmark(
      ctx,
      actor._id,
      'remove',
      landmarkId,
      reason?.trim() || `Removed "${row.name}"`,
    );
  },
});

/** Moderator: bring a removed landmark back, if no live one has taken its name since. */
export const restore = mutation({
  args: { landmarkId: v.id('bodyLandmarks') },
  handler: async (ctx, { landmarkId }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    if (row.removedAt === undefined) return;
    const rows = await landmarksForBody(ctx, row.waterBodyId);
    assertNotDuplicate(rows, [row.name, ...row.aliases], row.point, row._id);
    if (rows.filter((r) => r.removedAt === undefined).length >= MAX_LANDMARKS_PER_BODY) {
      throw new ConvexError(`This lake already has ${MAX_LANDMARKS_PER_BODY} landmarks`);
    }
    await ctx.db.patch(landmarkId, { removedAt: undefined, updatedAt: Date.now() });
    await auditLandmark(ctx, actor._id, 'restore', landmarkId, `Restored "${row.name}"`);
  },
});
