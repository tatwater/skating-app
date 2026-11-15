/**
 * **The Body console's reads** (B01-3) — what the console's frame and tabs need beyond the reads the
 * old body editor already makes. Each is gated on the capability map and bounded by rows and weight;
 * `null` is "not recorded", never a zero or "none".
 *
 * - {@link consoleExtras} — the towns, whether contours were drawn, when the outline was trusted, and
 *   the bodies that touch it (the identity list, completeness's bathymetry, neighbors on the map).
 * - {@link bayProvenance} — when and how each bay was made (Shape's bays).
 * - {@link history} — every audit row that concerns the body or a body merged into it
 *   (`auditBodyLinks`), newest first, optionally one verb or only the body's own rows (the console's
 *   History, Access's rulings, a tab's receipts).
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
  hoursToMs,
  isPassageMarker,
  libraryStandingOf,
  PASSAGE_EXPIRY_H,
  resolveSeason,
  type Season,
  seasonEndMs,
  seasonStartMs,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import type { ModerationAction } from './lib/audit';
import { auditLinksOnBody } from './lib/auditReads';
import { requireCapability } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { geoFactsOf, townRowsOf, townsWithStateOf } from './lib/bodyGeo';
import { hasContoursFor } from './lib/bodyLibrary';
import { MODERATION_ACTIONS } from './lib/enums';
import { landmarksForBody } from './lib/landmarkRows';
import { QUEUE_CAP } from './lib/requestDecisions';
import { undoState } from './lib/undo';
import type { UndoViewer } from './lib/undoTypes';
import { literals } from './lib/validators';
import { subAreasForBody } from './subAreas';
import { depthChoicesOf } from './waterBodies';

/** A person as the console names them; `null` for the machine or an erased account. */
type PersonView = { userId: Id<'profiles'>; username: string; displayName: string } | null;

async function personOf(ctx: QueryCtx, id: Id<'profiles'> | undefined): Promise<PersonView> {
  if (id === undefined) return null;
  const p = await ctx.db.get(id);
  return p ? { userId: p._id, username: p.username, displayName: p.displayName } : null;
}

/** The body an id names now — a merged one's survivor, as `waterBodies.get` follows it — or throw. */
async function bodyOrThrow(ctx: QueryCtx, id: Id<'waterBodies'>): Promise<Doc<'waterBodies'>> {
  const body = await resolveSurvivor(ctx, id);
  if (!body) throw new ConvexError('Water body not found');
  return body;
}

/** The id a body is known by now (a merged one's survivor's), or `null` when the chain dead-ends. */
async function currentId(ctx: QueryCtx, id: Id<'waterBodies'>): Promise<Id<'waterBodies'> | null> {
  return (await resolveSurvivor(ctx, id))?._id ?? null;
}

// ── The frame's extras ───────────────────────────────────────────────────────────────────────

/**
 * **The frame's extras.** `towns` — the places stored for the body (sampled at its interior point and
 * along its shore by the `bodyGeo` jobs), `null` when not computed yet, empty when none contains it;
 * `hasBathymetry` — contours were drawn for it; `outlineTrustedSince` — when a person last vouched for
 * the outline (a drawn body's approval), else when the import campaign that last re-affirmed it ran,
 * else `null`; `touchingBodyIds` and `touching` — listed bodies whose outline comes within 30 m,
 * tested among the 12 most prominent whose box meets this one, each with its name and a simplified
 * ring (`null` while not computed; `touchingCapped` when there were more, or the box ran past its
 * tile bound); `geoComputedAt` — when those were computed. **No geometry here**: the answers are
 * stored at the write (`lib/bodyGeo.ts`).
 */
export const consoleExtras = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const body = await bodyOrThrow(ctx, waterBodyId);
    const geo = await geoFactsOf(ctx, body._id);
    const hasBathymetry = await hasContoursFor(ctx, body);
    const ownRow = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', body._id).eq('scope', '*'))
      .first();

    // A person vouching for the outline: a drawn body approved, the latest wins.
    const vouched = await ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q.eq('targetType', 'waterbody').eq('targetId', body._id).eq('action', 'approve_waterbody'),
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

    // A neighbor since gone, merged or rejected leaves the list — the unlisted bodies, which the
    // computation never takes as candidates: its library row is the cheap check (a gone or merged
    // body has none; a rejected one is filed `rejected`).
    const touching =
      geo === null
        ? null
        : await (async () => {
            const kept = [];
            for (const n of geo.neighbors ?? []) {
              const row = await ctx.db
                .query('bodyLibraryRows')
                .withIndex('by_body', (q) => q.eq('waterBodyId', n.waterBodyId).eq('scope', '*'))
                .first();
              if (row !== null && row.standing !== 'rejected')
                kept.push({ waterBodyId: n.waterBodyId, name: row.name, ring: n.ring });
            }
            return kept;
          })();

    return {
      // `null` until computed (`geoComputedAt`); computed, the towns it lies in — empty for none.
      towns: geo === null ? null : (geo.towns ?? []),
      hasBathymetry,
      outlineTrustedSince,
      outlineTrustedVia,
      touchingBodyIds: touching === null ? null : touching.map((n) => n.waterBodyId),
      touching,
      touchingCapped: geo?.neighborsCapped ?? false,
      geoComputedAt: geo?.computedAt ?? null,
      /** `towns`, each with its state (B01-3c); `null` until computed. */
      townsWithState: townsWithStateOf(geo),
      /**
       * Completeness as the body's library row stores it (core's ten) — the frame's one field, so it
       * no longer calls `bodies.preview` and its report scan for it (B01-3c). `null` with no row.
       */
      complete:
        ownRow === null
          ? null
          : { have: ownRow.completeHave, of: ownRow.completeOf, missing: ownRow.missing },
      /**
       * The newest recorded contour search covering one of the body's states — the dataset's name
       * and when (B01-3c); `null` when no recorded search covers it (*not recorded*).
       */
      bathymetrySearched: await bathymetrySearchFor(ctx, body.states ?? []),
    };
  },
});

/** The states a body's newest contour search is looked up for, at most (a body touches a few). */
const BATHYMETRY_STATES_READ = 8;

/** The newest recorded contour search of any of `states` — one indexed read each — or `null`. */
async function bathymetrySearchFor(
  ctx: QueryCtx,
  states: readonly string[],
): Promise<{ label: string; at: number } | null> {
  let newest: Doc<'bathymetrySearches'> | null = null;
  for (const state of states.slice(0, BATHYMETRY_STATES_READ)) {
    const row = await ctx.db
      .query('bathymetrySearches')
      .withIndex('by_state_searched', (q) => q.eq('state', state))
      .order('desc')
      .first();
    if (row !== null && (newest === null || row.searchedAt > newest.searchedAt)) newest = row;
  }
  return newest === null ? null : { label: newest.label, at: newest.searchedAt };
}

// ── Bays ─────────────────────────────────────────────────────────────────────────────────────

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
  handler: async (ctx, { waterBodyId: requested }) => {
    await requireCapability(ctx, 'body.read');
    // A merged-away id reads its survivor's, as `waterBodies.get` follows it.
    const waterBodyId = await currentId(ctx, requested);
    if (waterBodyId === null) return [];
    // The same bays `subAreas.listForBody` lists, so every bay the tab shows has its provenance.
    const bays = await subAreasForBody(ctx, waterBodyId);
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
/** Bodies merged into this one, directly or through another, whose own rows are read. */
const HISTORY_ABSORBED = 50;
/**
 * Bytes a history keeps in hand while it walks the absorbed bodies (each is its polygon, up to a
 * document's 1 MiB): the next one, and the audit rows and their people after it.
 */
const HISTORY_BYTES_RESERVE = 6 * 1024 * 1024;

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

/**
 * **A body's history** — every audit row that concerns it (`auditBodyLinks`: rows on the body, its
 * bays, landmarks, put-ins, known features, requests, place names and flags, and the lots that serve
 * it) and the same of every body merged into it, newest first; each row with who acted (`null` for
 * the machine), what it was made through, and whether the viewer can undo it. One indexed range per
 * body in the merge chain (up to {@link HISTORY_ABSORBED}). `action` narrows to one verb in the
 * index; `bodyOnly` to rows on the body itself. `capped` means only that more rows exist than
 * returned (or the merge chain ran past its bound). A merged-away id reads its survivor's history.
 */
export const history = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    action: v.optional(literals(MODERATION_ACTIONS)),
    bodyOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => historyPage(ctx, await requireCapability(ctx, 'audit.read'), args),
});

/** `history`'s body, for a viewer already let in. */
export async function historyPage(
  ctx: QueryCtx,
  viewer: UndoViewer,
  {
    waterBodyId,
    action,
    bodyOnly,
    limit,
  }: {
    waterBodyId: Id<'waterBodies'>;
    action?: ModerationAction;
    bodyOnly?: boolean;
    limit?: number;
  },
) {
  {
    // Held to one row and the most; a missing or non-finite limit is the default.
    const n = Number.isFinite(limit)
      ? Math.min(HISTORY_MAX, Math.max(1, Math.floor(limit as number)))
      : 50;
    const body = await bodyOrThrow(ctx, waterBodyId);
    const absorbed = await absorbedInto(ctx, body._id);
    let capped = absorbed.truncated;
    const links = new Map<string, { actionId: Id<'moderationActions'>; createdAt: number }>();
    // Every body in the chain at once — one round, not one per body (B01-3h).
    const reads = await Promise.all(
      [body._id, ...absorbed.ids].map((id) =>
        // The same range `moderation.listActions` reads for a body (`lib/auditReads`): one rule.
        auditLinksOnBody(
          ctx,
          {
            waterBodyId: id,
            ...(action !== undefined ? { action } : {}),
            ...(bodyOnly === true ? { bodyOnly } : {}),
          },
          n + 1,
        ),
      ),
    );
    for (const read of reads) {
      if (read.length > n) capped = true;
      for (const l of read) links.set(l.actionId, l);
    }
    const newest = [...links.values()].sort(
      (a, b) => b.createdAt - a.createdAt || (a.actionId < b.actionId ? 1 : -1),
    );
    if (newest.length > n) capped = true;
    // **The page's rows at once, never one after another** (B01-3h): every row's reads — its actor
    // (once a page per person), its undo state's few indexed reads and any refusal check — run
    // concurrently, so the page costs a few rounds whatever its length. The refusal checks share the
    // request's budget by reserving before they read (`lib/undoReads`), so running them together
    // keeps the accounting exact.
    const people = new Map<string, Promise<PersonView>>();
    const actorOf = (id: Id<'profiles'> | undefined) => {
      const key = id ?? '';
      let found = people.get(key);
      if (found === undefined) {
        found = personOf(ctx, id);
        people.set(key, found);
      }
      return found;
    };
    const rows = await Promise.all(newest.slice(0, n).map((link) => ctx.db.get(link.actionId)));
    const entries = await Promise.all(
      rows
        .filter((row): row is Doc<'moderationActions'> => row !== null)
        .map(async (row) => {
          const [actor, undo] = await Promise.all([
            actorOf(row.actorId),
            undoState(ctx, viewer, row),
          ]);
          return {
            id: row._id,
            action: row.action,
            targetType: row.targetType,
            targetId: row.targetId,
            reason: row.reason,
            ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
            createdAt: row.createdAt,
            actor,
            ...(row.undoesActionId !== undefined ? { undoesActionId: row.undoesActionId } : {}),
            // What the actor made the write through (D256), as History reads it everywhere.
            ...(row.via !== undefined ? { via: row.via } : {}),
            undo,
          };
        }),
    );
    return { entries, capped };
  }
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────

/**
 * **The places a body lies in** — towns (the interior point's first), counties and states, sampled
 * at the interior point and along the shore, stored at the write (`lib/bodyGeo.ts`). `null` until
 * they are computed; computed and in no boundary, empty lists with `computedAt`.
 */
export const places = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const geo = await geoFactsOf(ctx, (await bodyOrThrow(ctx, waterBodyId))._id);
    if (geo === null) return null;
    return {
      towns: geo.towns ?? [],
      /** `towns`, each with its state (B01-3c). */
      townsWithState: townsWithStateOf(geo) ?? [],
      counties: geo.counties ?? [],
      states: geo.states ?? [],
      computedAt: geo.computedAt as number,
    };
  },
});

/**
 * **Who made each landmark, and when** — `createdAt`, the moderator who placed it (`null` for a
 * catalog's or the corpus's), its source, and when a person last edited or moved it. Removed
 * landmarks included, newest removals capped as the editor reads them.
 */
export const landmarkProvenance = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId: requested }) => {
    await requireCapability(ctx, 'body.read');
    // A merged-away id reads its survivor's, as `waterBodies.get` follows it.
    const waterBodyId = await currentId(ctx, requested);
    if (waterBodyId === null) return [];
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

/**
 * **Who asked for each open landmark** (`name_landmark` requests on the body): the requester as the
 * Inbox names them — `null` for an account since erased. Gated on `inbox.read`, the line that sees
 * the requests themselves.
 */
export const landmarkProposers = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId: requested }) => {
    await requireCapability(ctx, 'inbox.read');
    // A merged-away id reads its survivor's, as `waterBodies.get` follows it.
    const waterBodyId = await currentId(ctx, requested);
    if (waterBodyId === null) return [];
    const open = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('kind', 'name_landmark').eq('status', 'open'),
      )
      // The requests `corpusRequests.openLandmarkRequestsForBody` lists — the same range, order and
      // cap (it reads one more only to say `more`) — so every proposal the tab shows has its proposer.
      .take(QUEUE_CAP);
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

/**
 * A season's span as the hazard reads cover it: 1 July to the next 1 July — the span the Hazards tab's
 * list (`hazards.listForBody`) covers, so the strip and the list count the same hazards.
 */
export function winterWindow(season: Season): { start: number; end: number } {
  return { start: seasonStartMs(season), end: seasonEndMs(season) };
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
 * **How many hazards were on the lake each day of a season**, and when the season's watch opened.
 * Each day says two things:
 *
 * - `count` — hazards **established** on the lake that day: from the first report, through today
 *   for one still active, or through the day it left the lake for one whose leaving was recorded
 *   (`leftLakeAt`: the vote that archived it, or its merge into another) — and no further;
 * - `unknown` — archived hazards with no recorded end (every pin archived before the end was
 *   recorded): each day after the first report is unknown, never counted as clear.
 *
 * Days run through the end of the caller's UTC day (never past it, never past the season). `hazards`
 * lists each counted hazard's first-report day and whether its end is recorded (with its end day),
 * so the tab can mark first reports without another read, and each one's `type` (`passage: true` for a
 * reported crossing). **A reported crossing is not counted as a hazard** (D64: it is a passage marker,
 * a report that someone crossed there): each day's `crossings` counts the crossings live that day,
 * from first report until expiry or recorded leaving. A crossing never makes a day read safer or
 * more dangerous; it is its own mark. `unknownEnds` counts the archived hazards
 * with no recorded end. Hidden and merged-away pins are not counted. Bounded at
 * {@link DAILY_HAZARD_CAP}; `capped` past it. `watchOpensOn` is the season record's opening day.
 */
export const dailyHazards = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    season: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    // A merged-away id reads its survivor's hazards, as `waterBodies.get` follows it.
    const waterBodyId = await currentId(ctx, args.waterBodyId);
    // The caller's day, held near the server's; a season outside the browsable range is this one.
    const now = callerNow(args.now, Date.now(), DAY_MS);
    const season = resolveSeason(args.season, currentSeason(now));
    const window = winterWindow(season);
    // Through the end of the caller's UTC day, never past the season.
    const lastDay = Math.min(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS, window.end);
    const hazards = await ctx.db
      .query('hazards')
      .withIndex('by_water_body_first_reported', (q) =>
        q
          .eq('waterBodyId', waterBodyId ?? args.waterBodyId)
          .gte('firstReportedAt', window.start)
          .lt('firstReportedAt', window.end),
      )
      .take(DAILY_HAZARD_CAP + 1);
    const days = new Map<number, { count: number; unknown: number; crossings: number }>();
    const bump = (day: number, field: 'count' | 'unknown' | 'crossings') => {
      const d = days.get(day) ?? { count: 0, unknown: 0, crossings: 0 };
      d[field]++;
      days.set(day, d);
    };
    let unknownEnds = 0;
    const listed: {
      hazardId: Id<'hazards'>;
      firstReportedDay: number;
      endRecorded: boolean;
      endDay: number | null;
      type: Doc<'hazards'>['type'];
      passage: boolean;
    }[] = [];
    for (const h of hazards.slice(0, DAILY_HAZARD_CAP)) {
      if (h.moderationStatus !== 'visible' || h.mergedIntoHazardId !== undefined) continue;
      const firstDay = Math.floor(h.firstReportedAt / DAY_MS) * DAY_MS;
      // **A reported crossing is not a hazard** (D64): a passage marker says someone got across a
      // ridge there. It never enters a day's hazard count or its unknowns; it is counted on its own,
      // for the days it was live — from its first report until its expiry (the last confirmation plus
      // `PASSAGE_EXPIRY_H`, applied at read for skaters) or its recorded leaving, whichever came first,
      // never past the caller's day. A count of crossings is only that: no day reads safer for one.
      if (isPassageMarker(h.type)) {
        const ends = Math.min(
          h.lastConfirmedAt + hoursToMs(PASSAGE_EXPIRY_H),
          h.leftLakeAt ?? Number.POSITIVE_INFINITY,
        );
        const ended = ends <= now;
        const endDay = ended ? Math.floor(ends / DAY_MS) * DAY_MS : null;
        listed.push({
          hazardId: h._id,
          firstReportedDay: firstDay,
          endRecorded: ended,
          endDay,
          type: h.type,
          passage: true,
        });
        const through = endDay === null ? lastDay : Math.min(endDay + DAY_MS, lastDay);
        for (const day of daysCovered(h.firstReportedAt, through, window)) bump(day, 'crossings');
        continue;
      }
      const active = h.status === 'active';
      // A recorded end counts through its day; a pin still active is on the lake today, whatever any
      // stamp says (an unmerge clears the merge's stamp, but an active pin never reads one).
      const endDay =
        !active && h.leftLakeAt !== undefined ? Math.floor(h.leftLakeAt / DAY_MS) * DAY_MS : null;
      if (!active && endDay === null) unknownEnds++;
      listed.push({
        hazardId: h._id,
        firstReportedDay: firstDay,
        endRecorded: endDay !== null,
        endDay,
        type: h.type,
        passage: false,
      });
      const through = endDay === null ? lastDay : Math.min(endDay + DAY_MS, lastDay);
      for (const day of daysCovered(h.firstReportedAt, active ? lastDay : through, window)) {
        const established = active || endDay !== null || day === firstDay;
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
        .map(([at, d]) => ({ at, count: d.count, unknown: d.unknown, crossings: d.crossings })),
      unknownEnds,
      hazards: listed,
      capped: hazards.length > DAILY_HAZARD_CAP,
      watchOpensOn: opens === undefined ? null : Date.parse(`${opens}T00:00:00Z`),
    };
  },
});

// ── A body the normal reads cannot serve ─────────────────────────────────────────────────────

/** Visible reports a removed body's facts count at most (newest first); past it, `capped`. */
export const REMOVED_REPORT_CAP = 200;
/** Reports, visible or hidden, that count scans at most. */
export const REMOVED_REPORT_SCAN = 1_000;

/**
 * **A removed or rejected body's row and facts** (B01-3c) — what the list's preview and the Body
 * console's *This body has been removed* page draw, since `waterBodies.get` serves only
 * `{ available: false }` for one. The same capability as the list (`body.read`).
 *
 * - `name`, `bodyClass`, `states`, `areaSqM` — from what is stored on the body;
 * - `standing` — the library's standing (`rejected`, `removed`, or any other, for a body that is
 *   served normally: this read then still answers, and `left` is `null`);
 * - `left` — when it left, why, and who decided, from the audit row its standing names: the newest
 *   `remove` for a removed body, the newest `reject_waterbody` for a rejected one (`removalReason`
 *   from a removal's record; `reason` is the row's text);
 * - `towns` — with their states, when computed (`null` until then);
 * - `reports` — visible reports, newest first, counted to {@link REMOVED_REPORT_CAP} (`capped`).
 *
 * A merged-away id reads its survivor's, as every body read does. `null` for no body.
 */
export const removedFacts = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId: requested }) => {
    await requireCapability(ctx, 'body.read');
    const body = await resolveSurvivor(ctx, requested);
    if (!body) return null;
    const standing = libraryStandingOf(body);
    const left =
      standing === 'removed' || standing === 'rejected'
        ? await leftRow(ctx, body._id, standing)
        : null;
    // Visible reports, counted to the cap — hidden ones never use it up (Greptile on #122). The scan
    // is bounded by rows read, not matches: a body with more hidden reports than that reads `capped`.
    const visible = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', body._id))
      .order('desc')
      .filter((q) => q.eq(q.field('moderationStatus'), 'visible'))
      .paginate({
        cursor: null,
        numItems: REMOVED_REPORT_CAP + 1,
        maximumRowsRead: REMOVED_REPORT_SCAN,
      });
    const geo = await geoFactsOf(ctx, body._id);
    return {
      id: body._id,
      name: body.name,
      bodyClass: body.type,
      states: body.states ?? [],
      areaSqM: body.surfaceAreaSqM ?? null,
      standing,
      left:
        left === null
          ? null
          : {
              action: left.action as 'remove' | 'reject_waterbody',
              at: left.createdAt,
              reason: left.reason,
              removalReason:
                standing === 'removed' && body.removalReason !== undefined
                  ? body.removalReason
                  : null,
              by: await personOf(ctx, left.actorId),
            },
      towns: townsWithStateOf(geo),
      reports: {
        count: Math.min(visible.page.length, REMOVED_REPORT_CAP),
        // More visible reports than the cap, or the scan stopped before the body's last report.
        capped: visible.page.length > REMOVED_REPORT_CAP || !visible.isDone,
      },
    };
  },
});

/**
 * The audit row of the leaving the body's standing says — its newest `remove` for a removed body, its
 * newest `reject_waterbody` for a rejected one — one indexed read. Chosen by the standing, never the
 * newer of the two: a rejected body removed later still reads as rejected (`standingOf` ranks the
 * rejection first), and its page must not pair that with the removal's row.
 */
async function leftRow(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  standing: 'removed' | 'rejected',
): Promise<Doc<'moderationActions'> | null> {
  const action = standing === 'removed' ? 'remove' : 'reject_waterbody';
  return ctx.db
    .query('moderationActions')
    .withIndex('by_target_action', (q) =>
      q.eq('targetType', 'waterbody').eq('targetId', waterBodyId).eq('action', action),
    )
    .order('desc')
    .first();
}

// ── Town lines ───────────────────────────────────────────────────────────────────────────────

/** Towns whose lines one read returns at most (a body lies in a few; the largest in 13 on dev). */
export const TOWN_LINES_MAX = 24;

/**
 * **The Names map's town lines** (B01-3c) — each town the body lies in, with its state and its
 * boundary's outline as stored at the boundary's import (`adminAreaOutlines`, at most 96 points), so
 * the read is one small row per town, never a boundary's polygon. `ring: null` for a town whose
 * outline isn't stored yet (`adminAreas:backfillOutlines`) or on facts computed before towns carried
 * their boundary (the drift repair recomputes those). At most {@link TOWN_LINES_MAX} towns (`capped`
 * past it). `null` until the body's places are computed.
 */
export const townLines = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const geo = await geoFactsOf(ctx, (await bodyOrThrow(ctx, waterBodyId))._id);
    if (geo === null) return null;
    // Each town beside its boundary — the same rows, in the same order, `townsWithStateOf` lists.
    const towns = townRowsOf(geo) ?? [];
    const out: { name: string; state: string | null; ring: number[][] | null }[] = [];
    for (const { name, state, id: areaId } of towns.slice(0, TOWN_LINES_MAX)) {
      const outline =
        areaId === null
          ? null
          : await ctx.db
              .query('adminAreaOutlines')
              .withIndex('by_area', (q) => q.eq('adminAreaId', areaId))
              .first();
      out.push({ name, state, ring: outline?.ring ?? null });
    }
    return {
      towns: out,
      capped: towns.length > TOWN_LINES_MAX,
      computedAt: geo.computedAt as number,
    };
  },
});

// ── Identity: what the Names tab shows beside the name ──────────────────────────────────────

/**
 * **A body's class claims and a moderator's identity facts** (B01-3d) — what the Names tab shows
 * beside the name: each catalog's class claim (`null`, *not recorded*, for a body imported before the
 * import stored them — no backfill can recover them), the moderator's class (`null` when none), and
 * the moderator's own aliases. A merged-away id reads its survivor's.
 */
export const identity = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const body = await bodyOrThrow(ctx, waterBodyId);
    return {
      bodyClass: body.type,
      classClaims: body.classClaims ?? null,
      moderatorClass: body.moderatorClass ?? null,
      moderatorAliases: body.moderatorAliases ?? [],
    };
  },
});

// ── Depth choices: what the Water tab offers ────────────────────────────────────────────────

/**
 * **A body's depth choices, per measure** (B01-3d) — every source's value the depth ladder kept
 * (best-ranked first), which one is in use, whether a moderator chose it, and an operator's typed
 * value when one holds the measure (no source can be chosen over it). The same list
 * `chooseDepthSource` accepts (`depthChoicesOf`). A merged-away id reads its survivor's.
 */
export const depthChoices = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireCapability(ctx, 'body.read');
    const body = await bodyOrThrow(ctx, waterBodyId);
    const side = (measure: 'mean' | 'max') => {
      const source = measure === 'mean' ? body.meanDepthSource : body.maxDepthSource;
      const value = measure === 'mean' ? body.meanDepthM : body.maxDepthM;
      return {
        choices: depthChoicesOf(body, measure).map((c) => ({
          ...c,
          inUse: c.source === source && c.valueM === value,
        })),
        chosen: body.depthChoice?.[measure] ?? null,
        operatorValueM: source === 'operator' ? (value ?? null) : null,
      };
    };
    return { mean: side('mean'), max: side('max'), recorded: body.depthCandidates !== undefined };
  },
});
