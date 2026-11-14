/**
 * **The Body console's reads** (B01-3) — what the console's frame and tabs need beyond the reads the
 * old body editor already makes. Each is gated on the capability map and bounded by rows and weight;
 * `null` is "not recorded", never a zero or "none".
 *
 * - {@link consoleExtras} — the towns, whether contours were drawn, when the outline was trusted, and
 *   the bodies that touch it (the identity list, completeness's bathymetry, neighbors on the map).
 * - {@link bayProvenance} — when and how each bay was made (Shape's bays).
 * - {@link history} — the body's history with its bays', landmarks' and put-ins', newest first,
 *   optionally one verb (the console's History, Access's rulings, a tab's receipts).
 * - {@link places} — the towns, counties and states the body lies in (Places, Names).
 * - {@link landmarkProvenance} — who made each landmark and when; {@link landmarkProposers} — who
 *   asked for each open landmark (Places).
 * - {@link dailyHazards} — how many hazards were on the lake each day of a winter, and when the
 *   season's watch opened (Hazards' winters).
 */

import {
  archiveSeasonLabel,
  currentSeason,
  distanceToPolygonMeters,
  polygonBBox,
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
  for (const ring of ringsOf(from)) {
    const step = Math.max(1, Math.floor(ring.length / TOUCH_SAMPLES));
    for (let i = 0; i < ring.length; i += step) {
      const p = ring[i];
      if (p === undefined || p.length < 2) continue;
      const point = { lng: p[0] as number, lat: p[1] as number };
      if (distanceToPolygonMeters(point, to) <= TOUCH_METERS) return true;
    }
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
/** Landmarks whose history is read: the ones a person touched, newest first. */
const HISTORY_LANDMARKS = 100;
/** Put-ins whose history is read. */
const HISTORY_PUT_INS = 64;

type Target = { targetType: Doc<'moderationActions'>['targetType']; targetId: string };

/** The targets a body's history covers: the body, its bays, the landmarks a person touched, its put-ins. */
async function historyTargets(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<Target[]> {
  const targets: Target[] = [{ targetType: 'waterbody', targetId: waterBodyId }];
  const bays = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .take(MAX_BAYS);
  for (const b of bays) targets.push({ targetType: 'waterBodySubArea', targetId: b._id });
  // A catalog landmark nobody touched has no audit rows; the touched ones are a person's.
  const touched = (await landmarksForBody(ctx, waterBodyId))
    .filter(
      (l) =>
        l.createdByUserId !== undefined ||
        l.moderatorEditedAt !== undefined ||
        l.movedAt !== undefined ||
        (l.removedAt !== undefined && l.mergedIntoId === undefined),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_LANDMARKS);
  for (const l of touched) targets.push({ targetType: 'bodyLandmark', targetId: l._id });
  const putIns = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(HISTORY_PUT_INS);
  for (const p of putIns) targets.push({ targetType: 'putIn', targetId: p._id });
  return targets;
}

/**
 * **A body's history, with its bays', landmarks' and put-ins'** — newest first, each row with who
 * acted (`null` for the machine) and whether the viewer can undo it. `action` narrows to one verb as
 * an index range, never a filter over a capped page. Bounded: each target's newest `limit` rows,
 * {@link HISTORY_ROW_BUDGET} rows in all — `capped` when the budget ran out before every target was
 * read, or more rows exist than returned.
 */
export const history = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    action: v.optional(literals(MODERATION_ACTIONS)),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, action, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const n = Math.min(HISTORY_MAX, Math.max(1, Math.floor(limit ?? 50)));
    const targets = await historyTargets(ctx, waterBodyId);
    let budget = HISTORY_ROW_BUDGET;
    let capped = false;
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
 * season's watch opened. A hazard is on the lake from its first report until it was voted fully
 * healed (the vote that archives it); a hazard archived with no such vote has no recorded end, so it
 * counts through its last confirmation — a floor, said in `unknownEnds`. A hazard still active counts
 * through today (or the winter's end). Hidden and merged-away hazards are not counted. Days after
 * today are absent, never zero. `watchOpensOn` is the season record's opening day, `null` while the
 * watch waits.
 */
export const dailyHazards = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    season: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    const now = Math.min(args.now ?? Date.now(), Date.now() + DAY_MS);
    const season = args.season ?? currentSeason(now);
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
    const counts = new Map<number, number>();
    let unknownEnds = 0;
    for (const h of hazards.slice(0, DAILY_HAZARD_CAP)) {
      if (h.moderationStatus !== 'visible' || h.mergedIntoHazardId !== undefined) continue;
      let end: number;
      if (h.status === 'active') {
        end = Math.min(now, window.end);
      } else {
        const healed = await ctx.db
          .query('hazardConfirmations')
          .withIndex('by_hazard_and_verdict', (q) =>
            q.eq('hazardId', h._id).eq('verdict', 'fully_healed'),
          )
          .order('desc')
          .first();
        if (healed) end = healed.createdAt;
        else {
          unknownEnds++;
          // Through the day of its last confirmation: someone said it was there then.
          end = Math.max(h.lastConfirmedAt, h.firstReportedAt) + 1;
        }
      }
      for (const day of daysCovered(h.firstReportedAt, end, window)) {
        if (day > now) continue;
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
    }
    const record = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', archiveSeasonLabel(season)))
      .first();
    const opens = record?.opensOn;
    return {
      season,
      days: [...counts.entries()].sort(([a], [b]) => a - b).map(([at, count]) => ({ at, count })),
      unknownEnds,
      capped: hazards.length > DAILY_HAZARD_CAP,
      watchOpensOn: opens === undefined ? null : Date.parse(`${opens}T00:00:00Z`),
    };
  },
});
