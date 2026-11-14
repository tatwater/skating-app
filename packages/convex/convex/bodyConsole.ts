/**
 * **The Body console's reads** (B01-3) — what the console's frame and tabs need beyond the reads the
 * old body editor already makes. Each is gated on the capability map and bounded by rows and weight;
 * `null` is "not recorded", never a zero or "none".
 *
 * - {@link consoleExtras} — the towns, whether contours were drawn, when the outline was trusted, and
 *   the bodies that touch it (the identity list, completeness's bathymetry, neighbors on the map).
 * - {@link bayProvenance} — when and how each bay was made (Shape's bays).
 * - {@link history} — the body's history with its whole family's (`historyTargets`), newest first,
 *   optionally one verb (the console's History, Access's rulings, a tab's receipts).
 * - {@link places} — the towns, counties and states the body lies in (Places, Names).
 * - {@link landmarkProvenance} — who made each landmark and when; {@link landmarkProposers} — who
 *   asked for each open landmark (Places).
 * - {@link dailyHazards} — how many hazards were on the lake each day of a winter, and when the
 *   season's watch opened (Hazards' winters).
 */

import {
  archiveSeasonLabel,
  callerNow,
  currentSeason,
  distanceToPolygonMeters,
  MAX_LANDMARKS_PER_BODY,
  polygonBBox,
  resolveSeason,
  type Season,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { townsForBody } from './adminAreas';
import { requireCapability } from './lib/auth';
import { hasContoursFor } from './lib/bodyLibrary';
import { MODERATION_ACTIONS } from './lib/enums';
import { landmarksForBody } from './lib/landmarkRows';
import { undoState } from './lib/undo';
import { literals } from './lib/validators';
import { bodiesCoveringBox } from './waterBodies';

/** A person as the console names them; `null` for the machine or an erased account. */
type PersonView = { userId: Id<'profiles'>; username: string; displayName: string } | null;

async function personOf(ctx: QueryCtx, id: Id<'profiles'> | undefined): Promise<PersonView> {
  if (id === undefined) return null;
  const p = await ctx.db.get(id);
  return p ? { userId: p._id, username: p.username, displayName: p.displayName } : null;
}

async function bodyOrThrow(ctx: QueryCtx, id: Id<'waterBodies'>): Promise<Doc<'waterBodies'>> {
  const body = await ctx.db.get(id);
  if (!body) throw new ConvexError('Water body not found');
  return body;
}

// ── The frame's extras ───────────────────────────────────────────────────────────────────────

/** Bodies the touching read considers: the most prominent whose box meets this body's. */
const TOUCH_CANDIDATES = 12;
/** Two outlines this close count as touching (the stored outlines are simplified to ~5 m). */
export const TOUCH_METERS = 30;
/** Outline points of a candidate tested against this body. */
const TOUCH_SAMPLES = 48;
/** Above this many vertices, the touching test would cost too much: the read says it didn't run. */
const TOUCH_MAX_VERTICES = 20_000;

function ringsOf(geom: Polygon | MultiPolygon): number[][][] {
  return geom.type === 'Polygon'
    ? [geom.coordinates[0] ?? []]
    : geom.coordinates.map((p) => p[0] ?? []);
}

function vertexCount(geom: Polygon | MultiPolygon): number {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
}

/** Whether `from`'s outer rings come within {@link TOUCH_METERS} of `to`, by sampled vertices. */
function samplesNear(from: Polygon | MultiPolygon, to: Polygon | MultiPolygon): boolean {
  // {@link TOUCH_SAMPLES} across the whole outline, every ring's vertices in one sequence: a
  // multipolygon of hundreds of parts costs the same as one ring, never a sample budget per part.
  const points = ringsOf(from).flat();
  const step = Math.max(1, Math.floor(points.length / TOUCH_SAMPLES));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    if (p === undefined || p.length < 2) continue;
    const point = { lng: p[0] as number, lat: p[1] as number };
    if (distanceToPolygonMeters(point, to) <= TOUCH_METERS) return true;
  }
  return false;
}

/**
 * Whether two outlines come within {@link TOUCH_METERS}, sampled **both ways**: a large lake's ring
 * sampled {@link TOUCH_SAMPLES} times is kilometers between samples, so a pond beside it is found
 * only by sampling the pond's ring against the lake. The other's outline is tested whole only below
 * {@link TOUCH_MAX_VERTICES}, the bound the body itself is held to.
 */
function touches(body: Polygon | MultiPolygon, other: Polygon | MultiPolygon): boolean {
  if (samplesNear(other, body)) return true;
  return vertexCount(other) <= TOUCH_MAX_VERTICES && samplesNear(body, other);
}

/** Degrees of latitude in {@link TOUCH_METERS}, for the box the candidates are read in. */
const TOUCH_PAD_DEG = TOUCH_METERS / 111_000;

/**
 * **The frame's extras.** `towns` — sampled at the interior point and along the shore (`null` when
 * no boundary contains the body); `hasBathymetry` — contours were drawn for it; `outlineTrustedSince`
 * — when a person last vouched for the outline (a drawn body's approval), else when the import
 * campaign that last re-affirmed it ran, else `null`; `touchingBodyIds` — listed bodies whose
 * outline comes within {@link TOUCH_METERS}, among the {@link TOUCH_CANDIDATES} most prominent whose
 * box meets this one (`null` for an outline too large to test; `capped` when there were more).
 */
export const consoleExtras = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const body = await bodyOrThrow(ctx, waterBodyId);
    const places = await townsForBody(ctx, body);
    const hasBathymetry = await hasContoursFor(ctx, body);

    // A person vouching for the outline: a drawn body approved, the latest wins.
    const vouched = await ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q
          .eq('targetType', 'waterbody')
          .eq('targetId', waterBodyId)
          .eq('action', 'approve_waterbody'),
      )
      .order('desc')
      .first();
    let outlineTrustedSince: number | null = vouched?.createdAt ?? null;
    let outlineTrustedVia: 'approved' | 'campaign' | null = vouched ? 'approved' : null;
    if (outlineTrustedSince === null && body.lastCampaignId !== undefined) {
      const campaignId = body.lastCampaignId;
      const run = await ctx.db
        .query('importRuns')
        .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
        .first();
      if (run) {
        outlineTrustedSince = run.startedAt;
        outlineTrustedVia = 'campaign';
      }
    }

    const geom = body.polygon as unknown as Polygon | MultiPolygon;
    let touching: { ids: Id<'waterBodies'>[]; capped: boolean } | null = null;
    if (vertexCount(geom) <= TOUCH_MAX_VERTICES) {
      const box = polygonBBox(geom);
      const padded = {
        minLat: box.minLat - TOUCH_PAD_DEG,
        maxLat: box.maxLat + TOUCH_PAD_DEG,
        minLng: box.minLng - TOUCH_PAD_DEG * 1.5,
        maxLng: box.maxLng + TOUCH_PAD_DEG * 1.5,
      };
      // Already refined to the padded box and to listed bodies, most prominent first.
      const near = await bodiesCoveringBox(ctx, padded, { limit: TOUCH_CANDIDATES + 1 });
      const others = [...near.byId.values()].filter((b) => b._id !== waterBodyId);
      touching = {
        ids: others
          .slice(0, TOUCH_CANDIDATES)
          .filter((b) => touches(geom, b.polygon as unknown as Polygon | MultiPolygon))
          .map((b) => b._id),
        capped: near.truncated || others.length > TOUCH_CANDIDATES,
      };
    }

    return {
      towns: places === null ? null : places.towns,
      hasBathymetry,
      outlineTrustedSince,
      outlineTrustedVia,
      touchingBodyIds: touching === null ? null : touching.ids,
      touchingCapped: touching?.capped ?? false,
    };
  },
});

// ── Bays ─────────────────────────────────────────────────────────────────────────────────────

/** The most bays a body's provenance read covers. */
const MAX_BAYS = 100;

/** How a bay was made, from its creating audit row. */
export type BayVia = 'chord' | 'drawn' | 'seed' | 'catalog';

/** The way a creating row says a bay was made: its `via`, or — for rows written before — its words. */
export function bayViaOf(row: Pick<Doc<'moderationActions'>, 'metadata' | 'reason'>): BayVia {
  const via = (row.metadata as { via?: unknown } | undefined)?.via;
  if (via === 'chord' || via === 'seed' || via === 'catalog' || via === 'drawn') return via;
  if (row.reason.startsWith('Seeded ')) return 'seed';
  if (row.reason.startsWith('A07a campaign')) return 'catalog';
  return 'drawn';
}

/**
 * **When and how each bay was made**: `createdAt` (the row's), `createdVia` from its creating audit
 * row (`null` without one), and who made it. Removed bays included, as `subAreas.listForBody` lists
 * them.
 */
export const bayProvenance = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const bays = await ctx.db
      .query('waterBodySubAreas')
      .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
      .take(MAX_BAYS);
    const out = [];
    for (const bay of bays) {
      const created = await ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q
            .eq('targetType', 'waterBodySubArea')
            .eq('targetId', bay._id)
            .eq('action', 'create_sub_area'),
        )
        .first();
      out.push({
        subAreaId: bay._id,
        createdAt: bay.createdAt,
        createdVia: created === null ? null : bayViaOf(created),
        createdBy: await personOf(ctx, bay.createdByUserId),
      });
    }
    return out;
  },
});

// ── History ──────────────────────────────────────────────────────────────────────────────────

/** The most rows History returns. */
const HISTORY_MAX = 100;
/** Audit rows read across every target before the read says it stopped. */
const HISTORY_ROW_BUDGET = 2_000;
/** Every target a history reads, across its whole family; past it the read says `capped`. */
const HISTORY_MAX_TARGETS = 1_200;
/** Put-ins whose history is read. */
const HISTORY_PUT_INS = 200;
/** Lots serving the body whose history is read. */
const HISTORY_LOTS = 64;
/** Bodies merged into this one, directly or through another, whose own rows are read. */
const HISTORY_ABSORBED = 50;
/** Known features on the body, live and demoted, whose history is read. */
const HISTORY_FEATURES = 64;
/** Requests on the body, open and decided, whose history is read. */
const HISTORY_REQUESTS = 200;
/** Corpus place names on the body whose history is read. */
const HISTORY_PLACE_NAMES = 100;
/** Flags on the body itself whose history is read. */
const HISTORY_FLAGS = 200;
/**
 * Bytes a history keeps in hand while it walks the absorbed bodies (each is its polygon, up to a
 * document's 1 MiB): the next one, and the audit rows and their people after it.
 */
const HISTORY_BYTES_RESERVE = 6 * 1024 * 1024;

type Target = { targetType: Doc<'moderationActions'>['targetType']; targetId: string };

/**
 * The bodies merged into this one — and into those, hop by hop, since a body that absorbed others
 * can itself be merged later while its absorbed keep pointing at it. Up to
 * {@link HISTORY_ABSORBED}, and only while the read can afford another body after the rest of the
 * history; either stop says `truncated`.
 */
async function absorbedInto(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ ids: Id<'waterBodies'>[]; truncated: boolean }> {
  const ids: Id<'waterBodies'>[] = [];
  const seen = new Set<string>([waterBodyId]);
  for (let i = -1; i < ids.length; i++) {
    const parent = i < 0 ? waterBodyId : (ids[i] as Id<'waterBodies'>);
    const children = ctx.db
      .query('waterBodies')
      .withIndex('by_merged_into', (q) => q.eq('mergedIntoId', parent));
    for await (const b of children) {
      if (seen.has(b._id)) continue;
      if (ids.length >= HISTORY_ABSORBED) return { ids, truncated: true };
      seen.add(b._id);
      ids.push(b._id);
      const m = await ctx.meta.getTransactionMetrics();
      if (m.bytesRead.remaining < HISTORY_BYTES_RESERVE) return { ids, truncated: true };
    }
  }
  return { ids, truncated: false };
}

/** One body's family: its landmarks apart from its other targets, so a history can rank them last. */
type Family = {
  targets: Target[];
  landmarks: { touched: Target[]; rest: Target[] };
  truncated: boolean;
};

/**
 * **One body's own family — every target whose audit rows concern it**, the targets
 * `bodiesOfTarget` files under the body: the body; its bays, put-ins and landmarks whatever their
 * state (removed, hidden, folded by a merge, re-parented here); the lots that serve it; its known
 * features, live or demoted; the requests, corpus place names and flags on it, open or decided.
 * Membership is the relation, never which fields a row happens to carry. The landmarks are apart
 * (`touched`, the ones a person placed, edited, moved or removed, and the `rest`, newest first), so
 * the history can rank every family's landmarks after every family's other targets. `truncated`
 * when any kind ran past its bound.
 */
async function ownFamily(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<Family> {
  let truncated = false;
  const ids = (rows: readonly { _id: string }[], bound: number) => {
    if (rows.length > bound) truncated = true;
    return rows.slice(0, bound).map((r) => r._id);
  };
  const targets: Target[] = [{ targetType: 'waterbody', targetId: waterBodyId }];
  const add = (targetType: Target['targetType'], of: readonly string[]) => {
    for (const targetId of of) targets.push({ targetType, targetId });
  };
  add(
    'waterBodySubArea',
    ids(
      await ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
        .take(MAX_BAYS + 1),
      MAX_BAYS,
    ),
  );
  add(
    'putIn',
    ids(
      await ctx.db
        .query('putIns')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .take(HISTORY_PUT_INS + 1),
      HISTORY_PUT_INS,
    ),
  );
  const lotLinks = await ctx.db
    .query('parkingAreaBodies')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(HISTORY_LOTS + 1);
  if (lotLinks.length > HISTORY_LOTS) truncated = true;
  add('parkingArea', [
    ...new Set(lotLinks.slice(0, HISTORY_LOTS).map((l) => l.parkingAreaId as string)),
  ]);
  add(
    'bodyFeature',
    ids(
      await ctx.db
        .query('bodyFeatures')
        .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', waterBodyId))
        .take(HISTORY_FEATURES + 1),
      HISTORY_FEATURES,
    ),
  );
  add(
    'waterBodyRequest',
    ids(
      await ctx.db
        .query('waterBodyRequests')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .take(HISTORY_REQUESTS + 1),
      HISTORY_REQUESTS,
    ),
  );
  add(
    'corpusPlaceName',
    ids(
      await ctx.db
        .query('corpusPlaceNames')
        .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId))
        .take(HISTORY_PLACE_NAMES + 1),
      HISTORY_PLACE_NAMES,
    ),
  );
  add(
    'contentFlag',
    ids(
      await ctx.db
        .query('contentFlags')
        .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', waterBodyId))
        .take(HISTORY_FLAGS + 1),
      HISTORY_FLAGS,
    ),
  );
  const landmarks = await landmarksForBody(ctx, waterBodyId);
  if (landmarks.filter((l) => l.removedAt !== undefined).length >= MAX_LANDMARKS_PER_BODY) {
    // The removed read stops at its cap: older removals may hold rows the read can't see.
    truncated = true;
  }
  const touched = (l: Doc<'bodyLandmarks'>) =>
    l.createdByUserId !== undefined ||
    l.moderatorEditedAt !== undefined ||
    l.movedAt !== undefined ||
    l.removedAt !== undefined;
  const newest = [...landmarks].sort((a, b) => b.updatedAt - a.updatedAt);
  const of = (rows: Doc<'bodyLandmarks'>[]): Target[] =>
    rows.map((l) => ({ targetType: 'bodyLandmark', targetId: l._id }));
  return {
    targets,
    landmarks: { touched: of(newest.filter(touched)), rest: of(newest.filter((l) => !touched(l))) },
    truncated,
  };
}

/**
 * Reads a history keeps in hand before it takes in another body's family: the family's own reads
 * (its landmarks are up to 3,000 rows), then one query per target, and the audit rows and their
 * people after it.
 */
const FAMILY_RESERVE = {
  bytesRead: HISTORY_BYTES_RESERVE,
  documentsRead: 8_000,
  databaseQueries: 2_000,
};

/**
 * **A body's history targets: the family of the body and of every body merged into it** — the
 * same {@link ownFamily}, applied identically to the survivor and to each body in its merge chain
 * (followed hop by hop, up to {@link HISTORY_ABSORBED}). The survivor's family is read first, so the
 * walk's byte check sees it; every body the walk finds is read itself (its own rows, the merge that
 * folded it in among them, cost one query), and its family only while the read can afford it. Each
 * target once — a lot can serve the survivor and a body merged into it — and every family's
 * landmarks after every family's other targets, the touched first, up to
 * {@link HISTORY_MAX_TARGETS}. Any stop — a chain, a kind, the bound or the read running out — says
 * `truncated`, so `capped: false` still means complete.
 */
export async function historyTargets(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ targets: Target[]; truncated: boolean }> {
  const targets: Target[] = [];
  const touched: Target[] = [];
  const rest: Target[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const keep = (into: Target[], of: readonly Target[]) => {
    for (const t of of) {
      const key = `${t.targetType}:${t.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      into.push(t);
    }
  };
  const take = (family: Family) => {
    if (family.truncated) truncated = true;
    keep(targets, family.targets);
    keep(touched, family.landmarks.touched);
    keep(rest, family.landmarks.rest);
  };

  take(await ownFamily(ctx, waterBodyId));
  const absorbed = await absorbedInto(ctx, waterBodyId);
  if (absorbed.truncated) truncated = true;
  keep(
    targets,
    absorbed.ids.map((id): Target => ({ targetType: 'waterbody', targetId: id })),
  );
  for (const id of absorbed.ids) {
    const m = await ctx.meta.getTransactionMetrics();
    // One audit query per target held, up to the bound the list is cut to.
    const held = Math.min(HISTORY_MAX_TARGETS, targets.length + touched.length + rest.length);
    if (
      targets.length >= HISTORY_MAX_TARGETS ||
      m.bytesRead.remaining < FAMILY_RESERVE.bytesRead ||
      m.documentsRead.remaining < FAMILY_RESERVE.documentsRead ||
      m.databaseQueries.remaining < FAMILY_RESERVE.databaseQueries + held
    ) {
      truncated = true;
      break;
    }
    take(await ownFamily(ctx, id));
  }
  const all = [...targets, ...touched, ...rest];
  if (all.length > HISTORY_MAX_TARGETS) truncated = true;
  return { targets: all.slice(0, HISTORY_MAX_TARGETS), truncated };
}

/**
 * **A body's history, with its family's** (`historyTargets`: absorbed bodies, bays, put-ins, lots,
 * features, requests, place names, flags, landmarks, whatever their state) — newest first, each
 * row with who acted (`null` for the machine) and whether the viewer can undo it. `action` narrows
 * to one verb as an index range, never a filter over a capped page. Bounded: each target's newest
 * `limit` rows, {@link HISTORY_ROW_BUDGET} rows in all — `capped` when the budget ran out before
 * every target was read, a kind of target had more than its bound, or more rows exist than returned.
 */
export const history = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    action: v.optional(literals(MODERATION_ACTIONS)),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, action, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    // Held to one row and the most; a missing or non-finite limit is the default.
    const n = Number.isFinite(limit)
      ? Math.min(HISTORY_MAX, Math.max(1, Math.floor(limit as number)))
      : 50;
    const { targets, truncated } = await historyTargets(ctx, waterBodyId);
    let budget = HISTORY_ROW_BUDGET;
    let capped = truncated;
    const rows: Doc<'moderationActions'>[] = [];
    for (const { targetType, targetId } of targets) {
      if (budget <= 0) {
        capped = true;
        break;
      }
      // One past the page, so a target with more than it returns says so.
      const take = Math.min(n + 1, budget);
      const read =
        action === undefined
          ? await ctx.db
              .query('moderationActions')
              .withIndex('by_target', (q) =>
                q.eq('targetType', targetType).eq('targetId', targetId),
              )
              .order('desc')
              .take(take)
          : await ctx.db
              .query('moderationActions')
              .withIndex('by_target_action', (q) =>
                q.eq('targetType', targetType).eq('targetId', targetId).eq('action', action),
              )
              .order('desc')
              .take(take);
      budget -= read.length;
      rows.push(...read);
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || (a._id < b._id ? 1 : -1));
    if (rows.length > n) capped = true;
    const entries = [];
    for (const row of rows.slice(0, n)) {
      entries.push({
        id: row._id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
        createdAt: row.createdAt,
        actor: await personOf(ctx, row.actorId),
        ...(row.undoesActionId !== undefined ? { undoesActionId: row.undoesActionId } : {}),
        undo: await undoState(ctx, viewer, row),
      });
    }
    return { entries, capped };
  },
});

// ── Places ───────────────────────────────────────────────────────────────────────────────────

/**
 * **The places a body lies in** — towns (the interior point's first), counties and states, sampled
 * at the interior point and along the shore. `null` when no boundary contains the body.
 */
export const places = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    return townsForBody(ctx, await bodyOrThrow(ctx, waterBodyId));
  },
});

/**
 * **Who made each landmark, and when** — `createdAt`, the moderator who placed it (`null` for a
 * catalog's or the corpus's), its source, and when a person last edited or moved it. Removed
 * landmarks included, newest removals capped as the editor reads them.
 */
export const landmarkProvenance = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const rows = await landmarksForBody(ctx, waterBodyId);
    const people = new Map<Id<'profiles'>, PersonView>();
    const out = [];
    for (const l of rows) {
      let createdBy: PersonView = null;
      if (l.createdByUserId !== undefined) {
        if (!people.has(l.createdByUserId)) {
          people.set(l.createdByUserId, await personOf(ctx, l.createdByUserId));
        }
        createdBy = people.get(l.createdByUserId) ?? null;
      }
      out.push({
        landmarkId: l._id,
        source: l.source,
        createdAt: l.createdAt,
        createdBy,
        moderatorEditedAt: l.moderatorEditedAt ?? null,
        movedAt: l.movedAt ?? null,
      });
    }
    return out;
  },
});

/** The most open landmark proposals the proposers read covers. */
const MAX_PROPOSALS = 100;

/**
 * **Who asked for each open landmark** (`name_landmark` requests on the body): the requester as the
 * Inbox names them — `null` for an account since erased. Gated on `inbox.read`, the line that sees
 * the requests themselves.
 */
export const landmarkProposers = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'inbox.read');
    const open = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('kind', 'name_landmark').eq('status', 'open'),
      )
      .take(MAX_PROPOSALS);
    const out = [];
    for (const r of open) {
      out.push({
        requestId: r._id,
        requester: await personOf(ctx, r.requesterId),
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});

// ── Hazards' winters ─────────────────────────────────────────────────────────────────────────

/** The most hazards one winter's strip reads. */
const DAILY_HAZARD_CAP = 500;
const DAY_MS = 86_400_000;

/** A winter's window as the strips draw it: 1 October to 1 April. */
export function winterWindow(season: Season): { start: number; end: number } {
  return { start: Date.UTC(season, 9, 1), end: Date.UTC(season + 1, 3, 1) };
}

/**
 * The UTC days a span covers inside a window, as their starts. A span from `from` to `to`
 * (exclusive) counts on every day it overlaps.
 */
export function daysCovered(from: number, to: number, window: { start: number; end: number }) {
  const out: number[] = [];
  const first = Math.max(from, window.start);
  const last = Math.min(to, window.end);
  if (last <= first) return out;
  for (let d = Math.floor(first / DAY_MS) * DAY_MS; d < last; d += DAY_MS) out.push(d);
  return out;
}

/**
 * **How many hazards were on the lake each day of a winter** (1 October to 1 April), and when the
 * season's watch opened. Each day says two things:
 *
 * - `count` — hazards **established** on the lake that day: one is from its first report, and one
 *   still active is through today (or the winter's end);
 * - `unknown` — archived hazards that **may** have been: an archived hazard's end is not stored, and
 *   its votes can't establish it (a vote is edited in place, and an archived hazard still takes
 *   them), so every day after its first report is unknown — never counted as clear. A vote cast
 *   today changes no day of a past winter.
 *
 * `unknownEnds` is how many archived hazards that is. Hidden and merged-away hazards are not
 * counted; days after today are absent, never zero. `watchOpensOn` is the season record's opening
 * day, `null` while the watch waits. An honest end needs the hazard writers to stamp when a hazard
 * left the lake — deferred until the author-deletion PR's files are open again.
 */
export const dailyHazards = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    season: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    // The caller's day, held near the server's; a season outside the browsable range is this one.
    const now = callerNow(args.now, Date.now(), DAY_MS);
    const season = resolveSeason(args.season, currentSeason(now));
    const window = winterWindow(season);
    const hazards = await ctx.db
      .query('hazards')
      .withIndex('by_water_body_first_reported', (q) =>
        q
          .eq('waterBodyId', args.waterBodyId)
          .gte('firstReportedAt', window.start)
          .lt('firstReportedAt', window.end),
      )
      .take(DAILY_HAZARD_CAP + 1);
    const days = new Map<number, { count: number; unknown: number }>();
    const bump = (day: number, field: 'count' | 'unknown') => {
      const d = days.get(day) ?? { count: 0, unknown: 0 };
      d[field]++;
      days.set(day, d);
    };
    // The span's end is exclusive and never past now, so no day after today is ever produced.
    const lastDay = Math.min(now, window.end);
    let unknownEnds = 0;
    for (const h of hazards.slice(0, DAILY_HAZARD_CAP)) {
      if (h.moderationStatus !== 'visible' || h.mergedIntoHazardId !== undefined) continue;
      const active = h.status === 'active';
      if (!active) unknownEnds++;
      const firstDay = Math.floor(h.firstReportedAt / DAY_MS) * DAY_MS;
      for (const day of daysCovered(h.firstReportedAt, lastDay, window)) {
        const established = active || day === firstDay;
        bump(day, established ? 'count' : 'unknown');
      }
    }
    const record = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', archiveSeasonLabel(season)))
      .first();
    const opens = record?.opensOn;
    return {
      season,
      days: [...days.entries()]
        .sort(([a], [b]) => a - b)
        .map(([at, d]) => ({ at, count: d.count, unknown: d.unknown })),
      unknownEnds,
      capped: hazards.length > DAILY_HAZARD_CAP,
      watchOpensOn: opens === undefined ? null : Date.parse(`${opens}T00:00:00Z`),
    };
  },
});
