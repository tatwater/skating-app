/**
 * **B — our own track store** (Phase 8, D44/D58/D59): the invariant hub of the A→B→C pipeline.
 *
 * Every recorded skate lands here, whatever captured it (today: the native recorder; later: the
 * deferred watch adapters) and whatever it's pushed to afterwards (today: Strava). The store is the
 * part we always own, and owning it is the whole point of the phase — a track that entered through
 * *our* recorder is first-party Developer Application Data, so we may aggregate it, draw it on a
 * public report, and (later) derive from it, with **none** of the restrictions that apply to data
 * pulled from Strava's API (L7). A track pulled from Strava could do none of that.
 *
 * Three responsibilities:
 *
 * 1. **Ingest** — normalize a track into `gpsActivities`, idempotent on `(provider,
 *    providerActivityId)` so a lost-ack replay of a three-hour skate returns the original row rather
 *    than a duplicate. The recorder's client-generated key *is* the `providerActivityId` for `native`.
 * 2. **Resolve to a lake (D44)** — which water body was this skate on? A track that matches nothing
 *    is not an error: that's the D14 "new water" case, and the row stays unresolved for the
 *    create-or-attach flow to pick up.
 * 3. **Link to a report** — `reports.activityId ↔ gpsActivities.linkedReportId`, the join that makes
 *    the path renderable on the report and (D58) eligible for the aggregate layer.
 *
 * **Reads are owner-scoped except through a report.** A raw activity is personal data — a minor may
 * record for themselves and never publish anything (D41/D58). The only way someone else's track
 * becomes visible is via a *public report* they chose to file, which is exactly the publish-is-consent
 * predicate D58 rests on.
 */

import {
  clipPathEnds,
  nearestBodyForPoint,
  PUT_IN_CLIP_M,
  pathOpacity,
  pointInPolygon,
  reportFreshness,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import { getCurrentProfile, requireContributor, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { ACTIVITY_PROMPT_STATES } from './lib/enums';
import { isListed } from './lib/listing';
import { geoJson, literals } from './lib/validators';
import { listedBodiesNearCoord } from './waterBodies';

/**
 * How far off a known body's polygon a track may still resolve to it — the same parking/approach
 * reasoning as `waterBodies.resolveBodyForCoord`, but tighter: a *skate* starts on the ice, and a
 * generous buffer here would snap a new pond onto the big lake next door and silently defeat D14.
 */
const TRACK_RESOLVE_BUFFER_M = 120;

/**
 * How many points along a track we test when looking for the bodies it spans. A skate can cross from
 * a lake into its channel and back; sampling a bounded number of points catches that without walking
 * a 3,000-point path against every candidate polygon (which is the read/CPU trap).
 */
const SPAN_SAMPLE_POINTS = 24;

/** Evenly-spaced sample of a path's positions, always including both endpoints. */
function samplePath(path: LineString, count: number): { lat: number; lng: number }[] {
  const coords = path.coordinates;
  if (coords.length <= count) {
    return coords.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number }));
  }
  const step = (coords.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const [lng, lat] = coords[Math.round(i * step)] as number[];
    return { lat: lat as number, lng: lng as number };
  });
}

/**
 * Resolve a track to the water body (or bodies) it was skated on — **D44**.
 *
 * Returns the primary body (where most of the skate happened) plus every body the track touches, for
 * a skate that spans a lake and its channel. `null` primary means the track matched nothing known,
 * which is the D14 signal that this may be new water — never an error.
 */
export async function resolveTrackToBodies(
  ctx: QueryCtx | MutationCtx,
  path: LineString,
): Promise<{ primary: Id<'waterBodies'> | null; all: Id<'waterBodies'>[] }> {
  const samples = samplePath(path, SPAN_SAMPLE_POINTS);
  const candidates = await candidateBodiesForSamples(ctx, samples);
  if (candidates.length === 0) return { primary: null, all: [] };

  const shaped = candidates.map((b) => ({
    ref: b._id,
    polygon: b.polygon as unknown as Polygon | MultiPolygon,
    surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
  }));

  // Count how many sampled points fall on each body — "where was most of this skate" is a far better
  // primary than "where did it start", which would pick the channel you left from.
  const hits = new Map<Id<'waterBodies'>, number>();
  for (const sample of samples) {
    let matched = false;
    for (const candidate of shaped) {
      if (pointInPolygon(sample, candidate.polygon)) {
        hits.set(candidate.ref, (hits.get(candidate.ref) ?? 0) + 1);
        matched = true;
      }
    }
    // A point just off the polygon edge (GPS noise near shore, or a simplified boundary) still counts
    // toward the nearest body within the buffer, so shoreline jitter doesn't read as "new water".
    if (!matched) {
      const near = nearestBodyForPoint(sample, shaped, TRACK_RESOLVE_BUFFER_M);
      if (near) hits.set(near, (hits.get(near) ?? 0) + 1);
    }
  }
  if (hits.size === 0) return { primary: null, all: [] };

  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const primary = ranked[0]?.[0] ?? null;
  return { primary, all: ranked.map(([id]) => id) };
}

/**
 * Bodies worth testing a set of sampled track points against.
 *
 * Delegates each sample to `waterBodies.listedBodiesNearCoord` — the shared containment lookup, which
 * is one cell per ladder rung around the point and so bounded regardless of body size (N1).
 * Sampling caps how many of those lookups run, so the read cost is bounded by `SPAN_SAMPLE_POINTS`
 * rather than by track length; and consecutive samples on one lake are deduped to a coarse grid cell
 * so a 3,000-point path on one pond costs one lookup, not twenty-four.
 */
async function candidateBodiesForSamples(
  ctx: QueryCtx,
  samples: readonly { lat: number; lng: number }[],
): Promise<Doc<'waterBodies'>[]> {
  const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
  const seenCells = new Set<string>();
  for (const sample of samples) {
    const cell = `${sample.lat.toFixed(2)},${sample.lng.toFixed(2)}`;
    if (seenCells.has(cell)) continue;
    seenCells.add(cell);
    for (const [id, body] of await listedBodiesNearCoord(ctx, sample)) byId.set(id, body);
  }
  return [...byId.values()];
}

/**
 * Ingest a recorded track (the native recorder's flush target).
 *
 * Idempotent on `(provider, providerActivityId)` via `by_provider_activity`: the recorder mints the
 * key at session start and carries it across every retry, so a replayed flush returns the original
 * activity. Resolution to a lake happens here, at write time, so every downstream read (report link,
 * bounty eligibility, the aggregate layer) sees a resolved row without re-deriving it.
 *
 * **No `distanceMeters` argument, on purpose.** The client's distance comes from `trackStats` over the
 * same points it sends as `path`, so it is `trackStats(path).distanceMeters` exactly — accepting it
 * would let a client assert a number that contradicts the geometry we store, and accepting-then-ignoring
 * it (which is what this did before 2026-07-25) reads as though a distance is persisted when none is.
 * Derive it where it's needed; denormalize only when a read appears that can't afford to.
 */
export const ingestTrack = mutation({
  args: {
    /** The client-generated session key — becomes `providerActivityId` for the `native` provider. */
    idempotencyKey: v.string(),
    path: geoJson,
    startTime: v.number(),
    endTime: v.number(),
    /** Moving time in seconds (excludes pauses) — see the schema note on why it isn't end − start. */
    elapsedSeconds: v.optional(v.number()),
    /** Resolved on-device from the offline body cache; re-checked server-side. */
    waterBodyId: v.optional(v.id('waterBodies')),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();

    // Idempotency short-circuit, before any work: a re-flushed skate returns its original row.
    // Scoped to the owner so a key collision can never hand back someone else's track.
    const existing = await ctx.db
      .query('gpsActivities')
      .withIndex('by_provider_activity', (q) =>
        q.eq('provider', 'native').eq('providerActivityId', args.idempotencyKey),
      )
      .unique();
    if (existing) {
      if (existing.userId !== profile._id) throw new ConvexError('Idempotency key conflict');
      return existing._id;
    }

    if (args.path.type !== 'LineString') {
      throw new ConvexError('A recorded track must be a LineString');
    }
    const path = args.path as LineString;
    if (path.coordinates.length < 2) throw new ConvexError('Track has too few points');
    if (!(args.endTime > args.startTime)) throw new ConvexError('Track ends before it starts');

    // Resolve to a lake (D44). A client-supplied id is only a hint — re-resolve unless it checks out,
    // because the device's offline cache can be stale and the body may since have been merged away.
    let resolved: { primary: Id<'waterBodies'> | null; all: Id<'waterBodies'>[] };
    const hinted = args.waterBodyId ? await resolveSurvivor(ctx, args.waterBodyId) : null;
    if (hinted && isListed(hinted)) {
      resolved = { primary: hinted._id, all: [hinted._id] };
    } else {
      resolved = await resolveTrackToBodies(ctx, path);
    }

    return await ctx.db.insert('gpsActivities', {
      userId: profile._id,
      provider: 'native',
      providerActivityId: args.idempotencyKey,
      sportType: 'IceSkate',
      startTime: args.startTime,
      endTime: args.endTime,
      ...(args.elapsedSeconds !== undefined ? { elapsedSeconds: args.elapsedSeconds } : {}),
      path,
      ...(resolved.primary !== null ? { waterBodyId: resolved.primary } : {}),
      // Only stored when the skate genuinely spanned more than one body — a single-element array
      // would be noise on every ordinary row.
      ...(resolved.all.length > 1 ? { waterBodyIds: resolved.all } : {}),
      // `pending` = recorded but not yet offered as a report. The recorder prompts on stop; a skate
      // that resolves to nothing goes down the D14 create-or-attach path instead.
      promptState: 'pending',
      detectedAt: now,
    });
  },
});

/**
 * Move an activity through its report-prompt lifecycle (`pending → prompted → converted | dismissed`).
 * Owner-only: this is a personal record of where someone skated.
 */
export const setPromptState = mutation({
  args: {
    activityId: v.id('gpsActivities'),
    promptState: literals(ACTIVITY_PROMPT_STATES),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new ConvexError('Activity not found');
    if (activity.userId !== profile._id) throw new ConvexError('Not your activity');
    await ctx.db.patch(args.activityId, { promptState: args.promptState });
  },
});

/**
 * Wire an activity to the report it backs — the join `reports.create` calls after inserting a report
 * with an `activityId`. Kept as a helper (not a public mutation) so the two sides can only ever be
 * written together, inside one transaction: a half-linked pair would render a path on a report the
 * activity doesn't point back to, and the aggregate layer's privacy predicate reads the *activity*
 * side (`linkedReportId`), so a missing back-link would silently drop a track from the map.
 */
export async function linkActivityToReport(
  ctx: MutationCtx,
  activityId: Id<'gpsActivities'>,
  reportId: Id<'reports'>,
  userId: Id<'profiles'>,
): Promise<void> {
  const activity = await ctx.db.get(activityId);
  if (!activity) throw new ConvexError('Activity not found');
  if (activity.userId !== userId) throw new ConvexError('Not your activity');
  if (activity.linkedReportId !== undefined && activity.linkedReportId !== reportId) {
    throw new ConvexError('This skate is already attached to another report');
  }
  await ctx.db.patch(activityId, { linkedReportId: reportId, promptState: 'converted' });
}

/** The shape the map layers consume — a path plus the metadata the drawer shows. */
export interface ActivityPathView {
  activityId: Id<'gpsActivities'>;
  path: LineString;
  /**
   * Whether the ends were trimmed because this report withheld its put-in — the same flag the
   * aggregate layer returns, so a client can say "start and end hidden" rather than drawing a
   * shortened line that reads as the whole skate.
   */
  clipped: boolean;
  startTime: number;
  endTime?: number;
  elapsedSeconds?: number;
}

/**
 * The recorded path behind a report, for the report-detail map (display-only — there is no "draw"
 * action anywhere in the app; a path only ever comes from a recorded track).
 *
 * Visible to anyone who can see the report: publishing a report *is* the consent for its path (D58).
 * Returns `null` when the report has no track, which is the common case (D24 — a report never
 * requires a path).
 *
 * **Put-in clipping applies here too (N3, 2026-07-27).** It didn't, and the gap was the kind that hides
 * in plain sight: `showPutIn === false` was honored by `listTracksForBody` 60 lines below (clipping
 * `PUT_IN_CLIP_M` off both ends) and by `putIns.listForBody` (hiding the pin), while this query — the
 * simpler one, sitting right next to them — returned the raw path to *every* viewer. The doc comment on
 * the aggregate layer even claimed this view showed "its **author** their full path", but there was no
 * owner check to make that true. So a skater who withheld their put-in still had the first and last
 * 150 m of their track — the part that starts at a door — drawn on a public page.
 *
 * The author and moderators still see the whole line (the author needs their own track back; a
 * moderator judging a report needs what it actually claims). Everyone else gets what the aggregate
 * layer would have given them, so the two paths can no longer disagree about the same track.
 */
export const getForReport = query({
  args: { reportId: v.id('reports') },
  handler: async (ctx, args): Promise<ActivityPathView | null> => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.activityId === undefined) return null;
    // Resolved once and reused by both gates below — the moderation check and the clip ask the same
    // "is this the author or a moderator?" question, and a second `getCurrentProfile` would be a
    // second read for an answer we already have.
    const viewer = await getCurrentProfile(ctx);
    const privileged =
      (viewer !== null && viewer._id === report.authorId) ||
      viewer?.role === 'moderator' ||
      viewer?.role === 'admin';
    // Moderation-hidden reports don't leak their path either.
    if (report.moderationStatus !== 'visible' && !privileged) return null;

    const activity = await ctx.db.get(report.activityId);
    if (activity === null) return null;
    if (activity.path?.type !== 'LineString') return null;

    const path =
      report.showPutIn === false && !privileged
        ? clipPathEnds(activity.path as LineString, PUT_IN_CLIP_M)
        : (activity.path as LineString);
    // Entirely-endpoints tracks come back null — the same call `listTracksForBody` makes, for the same
    // reason: a stub that is only the clipped region points straight at what the clip protects.
    if (path === null) return null;

    return {
      activityId: activity._id,
      path,
      clipped: path !== activity.path,
      startTime: activity.startTime,
      ...(activity.endTime !== undefined ? { endTime: activity.endTime } : {}),
      ...(activity.elapsedSeconds !== undefined ? { elapsedSeconds: activity.elapsedSeconds } : {}),
    };
  },
});

/**
 * The signed-in user's own recent skates — the recorder's history and the source of the "turn this
 * into a report?" prompt. Owner-scoped by construction: there is no query anywhere that returns
 * another person's unpublished tracks.
 */
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const activities = await ctx.db
      .query('gpsActivities')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .order('desc')
      .take(limit);
    return await Promise.all(
      activities.map(async (a) => {
        const body = a.waterBodyId ? await ctx.db.get(a.waterBodyId) : null;
        return {
          activityId: a._id,
          startTime: a.startTime,
          endTime: a.endTime,
          elapsedSeconds: a.elapsedSeconds,
          promptState: a.promptState,
          linkedReportId: a.linkedReportId,
          waterBodyId: a.waterBodyId,
          waterBodyName: body?.name ?? null,
          path: a.path ?? null,
        };
      }),
    );
  },
});

/**
 * Cap on the tracks returned for one body. A giant, popular lake (Champlain) will eventually
 * accumulate more paths than are worth drawing, and past a certain density the overlay says the same
 * thing with 200 lines as with 2,000. Newest first, so the cap drops the faintest, not the freshest.
 *
 * The count of what was dropped is returned alongside — a silently truncated map reads as "this is
 * everything", which is exactly the sort of quiet lie the Phase 7 "no silent caps" rule exists to stop.
 */
const MAX_TRACKS_PER_BODY = 200;

/** One aggregated public track, with the opacity it should draw at. */
export interface AggregateTrackView {
  activityId: Id<'gpsActivities'>;
  path: LineString;
  /** From the linked report's D59 freshness — the identical number the report's own aging reads. */
  opacity: number;
  /** Whether this track was clipped at the ends because its report withheld its put-in. */
  clipped: boolean;
}

/**
 * The **aggregate tracks layer** for one water body (D58) — the decaying overlay of where people
 * actually skated.
 *
 * Privacy here is structural, not a filter someone has to remember to write. Four things gate it, and
 * every one of them is a property of data that already exists rather than a new consent surface:
 *
 * 1. **Publish-is-consent.** Only tracks linked to a **visible** report aggregate. Filing a public
 *    report *is* the act of sharing — there's no separate `sharedToAggregate` flag, because a second
 *    flag would let the two disagree and would ask people to consent twice to one thing.
 * 2. **Minors excluded by construction.** Minors can't post reports (D41), so their tracks never link
 *    to one and can never reach here. Nothing checks an age; the exclusion falls out of the model.
 * 3. **Put-in-gated clipping.** The report's existing `showPutIn` opt-out doubles as the clipping
 *    consent: shared put-in ⇒ full path (it's a declared public access point we *want* to surface);
 *    withheld ⇒ the first and last 150 m are cut, so a skate that started in a back yard can't point
 *    at the house. The report's own detail view still shows its author their full path.
 * 4. **Global opt-out.** `profiles.excludeTracksFromAggregate` drops a person's tracks retroactively.
 *
 * Deliberately **no k-anonymity threshold** (D58): a single skater's public path renders. A public
 * report is meant to be shared, the path is already on it, and a contributor-count gate would render
 * an empty map for the entire alpha while protecting nothing that publishing hadn't already decided.
 *
 * Scoped **per body**, like Phase 9 hazards — never a cross-viewport spatial scan, which is the
 * read-cap-fragile path `listInViewport` has already had to be fixed for twice.
 */
export const listTracksForBody = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    limit: v.optional(v.number()),
    /** Which season's paths (D63) — absent ⇒ this one. See `by_water_body_start_time` for the field. */
    season: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ tracks: AggregateTrackView[]; truncated: number }> => {
    const body = await resolveSurvivor(ctx, args.waterBodyId);
    if (!body || !isListed(body)) return { tracks: [], truncated: 0 };

    const limit = Math.min(Math.max(args.limit ?? MAX_TRACKS_PER_BODY, 1), MAX_TRACKS_PER_BODY);
    const season = args.season ?? seasonOf(Date.now());
    const activities = await ctx.db
      .query('gpsActivities')
      .withIndex('by_water_body_start_time', (q) =>
        q
          .eq('waterBodyId', body._id)
          .gte('startTime', seasonStartMs(season))
          .lt('startTime', seasonEndMs(season)),
      )
      .order('desc')
      .take(limit + 1);
    const truncated = Math.max(0, activities.length - limit);

    const now = Date.now();
    const optOutCache = new Map<Id<'profiles'>, boolean>();
    const tracks: AggregateTrackView[] = [];

    for (const activity of activities.slice(0, limit)) {
      if (activity.path?.type !== 'LineString') continue;
      // (1) Publish-is-consent: no linked report ⇒ never aggregates. This is also what keeps a
      // minor's recording out, since a minor can't have filed the report it would need (D41).
      if (activity.linkedReportId === undefined) continue;
      const report = await ctx.db.get(activity.linkedReportId);
      if (report?.moderationStatus !== 'visible') continue;

      // (4) Global opt-out, cached per author across the loop.
      let optedOut = optOutCache.get(activity.userId);
      if (optedOut === undefined) {
        const author = await ctx.db.get(activity.userId);
        optedOut = author?.excludeTracksFromAggregate === true;
        optOutCache.set(activity.userId, optedOut);
      }
      if (optedOut) continue;

      // (3) Put-in-gated clipping. `showPutIn === false` is the author withholding their access
      // point; anything else (shared, or never asked) leaves the path whole.
      const clipped = report.showPutIn === false;
      const path = clipped
        ? clipPathEnds(activity.path as LineString, PUT_IN_CLIP_M)
        : (activity.path as LineString);
      // A path that is entirely endpoints comes back null — dropping it is the point (see clipPathEnds).
      if (!path) continue;

      // Opacity is the linked report's freshness (D59) — the *same* number, not a parallel decay, so
      // a path can never read as fresher or staler than the report it belongs to.
      const netThumbs = await tallyNetThumbs(ctx, activity.linkedReportId);
      const corroborationCount = await countCorroborations(ctx, activity.linkedReportId);
      const freshness = reportFreshness(
        { skateEndTime: report.skateEndTime, netThumbs, corroborationCount },
        now,
      );

      tracks.push({
        activityId: activity._id,
        path,
        opacity: pathOpacity(freshness),
        clipped,
      });
    }

    return { tracks, truncated };
  },
});

/** helpful − unhelpful on a report — the shared thumbs signal D59's freshness reads. */
async function tallyNetThumbs(ctx: QueryCtx, reportId: Id<'reports'>): Promise<number> {
  const ratings = await ctx.db
    .query('reportRatings')
    .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
    .take(200);
  let net = 0;
  for (const rating of ratings) net += rating.verdict === 'helpful' ? 1 : -1;
  return net;
}

/** Independent in-window agreeing reports (`pointEvents.by_ref`) — the other D59 freshness signal. */
async function countCorroborations(ctx: QueryCtx, reportId: Id<'reports'>): Promise<number> {
  const events = await ctx.db
    .query('pointEvents')
    .withIndex('by_ref', (q) => q.eq('refId', reportId))
    .take(50);
  return events.filter((e) => e.reason === 'report_corroborated').length;
}
