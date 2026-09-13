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
  ACTIVITY_DEDUP_START_WINDOW_MS,
  clipPathEnds,
  type DedupActivity,
  dedupActivities,
  isMinor,
  nearestBodyForPoint,
  PUT_IN_CLIP_M,
  pathOpacity,
  pointInPolygon,
  reportFreshness,
  resolveSeason,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { getCurrentProfile, requireContributor, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { ACTIVITY_PROMPT_STATES } from './lib/enums';
import { isListed } from './lib/listing';
import { enqueueActorNotification } from './lib/notificationQueue';
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
 * How long a recorded skate sits `pending` before the sweep asks about it (N8/B4). Long enough that
 * the recorder's own stop-prompt and a same-day flush from the offline queue get first go, and that
 * a second source of the same skate (a watch syncing when it feels like it) has usually arrived —
 * the dedup below needs both copies in the table before it can pick one. Same idea as the D169 settle
 * window, at a longer timescale.
 */
export const ACTIVITY_PROMPT_DELAY_MS = 3 * 60 * 60 * 1000;
/**
 * Due activities examined per sweep tick; the rest wait for the next hour. Small on purpose: every
 * due row costs a `CANDIDATE_WINDOW_CAP` read of its start-time window, so the tick's worst case is
 * `PROMPT_SWEEP_CAP × CANDIDATE_WINDOW_CAP` documents, which has to stay inside one transaction's
 * read limit — a tick that blows it throws, delivers nothing, and re-reads the same rows next hour
 * for ever.
 */
const PROMPT_SWEEP_CAP = 50;
/**
 * Rows read per due row's start-time window. A window is ±`ACTIVITY_DEDUP_START_WINDOW_MS` — twenty
 * minutes of one person's skating — so this is a safety bound, not a working size: a window that
 * fills it holds fifty copies of the same skate.
 */
const CANDIDATE_WINDOW_CAP = 50;

/**
 * The `activity_detected` producer (N8/B4): find skates still `pending` after the delay, dedup each
 * user's batch first (B4a), and file one notification per winner — "You skated on Lake Morey on
 * Tuesday. Add a report?" — flipping the row to `prompted` so it fires once.
 *
 * **Why this exists.** `ingestTrack` inserts every recorded track as `pending`, and the recorder
 * prompts on stop. When the app dies before prompting, or the track flushes from the offline queue
 * hours later on a different screen, that prompt never happens — a completed skate sits in the table
 * that nobody was ever asked about. N6f's `UnreportedSkates` list on the You tab is where the skate
 * *lives*; this is the nudge that says it's there.
 *
 * **Our recorder only.** D24's "detected on any linked provider" premise was retired with Phase 8's
 * pivot to push, and the watch adapters sit behind approval queues (L8). The dedup ladder runs anyway
 * — on one provider it has nothing to choose between, and that is the point of settling it now.
 *
 * Runs hourly from `crons.ts`. The notification rides the settle queue like every other producer, with
 * no extra debounce: it has already waited hours, and the flush re-checks the activity is still
 * un-linked and un-dismissed before delivering.
 */
export const sweepUnpromptedActivities = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // A plain `take`, not `takeCapped`: a full batch is the design here (the rest wait for the next
    // tick, the same shape as the storage sweeps), not a truncated answer, so the D5 "results are
    // truncated" warning would fire on every busy tick for a set that is meant to fill.
    const due = await ctx.db
      .query('gpsActivities')
      .withIndex('by_prompt_state_detected', (q) =>
        q.eq('promptState', 'pending').lte('detectedAt', now - ACTIVITY_PROMPT_DELAY_MS),
      )
      .take(PROMPT_SWEEP_CAP);

    // Every due row must leave the `pending` range on the tick that reads it, or the sweep re-reads
    // it every hour for ever — and it holds one of the batch's slots while it does. Two shapes can't
    // be settled by the dedup below because it never sees them: a row that is already superseded (a
    // client handed a loser back to `pending` — `setPromptState` accepts any state) and a row that
    // already carries a link (reported, so there is nothing to ask). Settle those here.
    //
    // The rest are deduped per user, against everything of theirs that could be the same skate — not
    // only the due rows. A copy that arrived an hour ago is still `pending` and not yet due, but it
    // is the copy the ladder may prefer, and picking a winner without it would supersede the better
    // recording later.
    const byUser = new Map<Id<'profiles'>, Doc<'gpsActivities'>[]>();
    let settled = 0;
    for (const row of due) {
      // Link first: a linked row is `converted` whether or not it was also superseded (the loser
      // loop below leaves a loser its link when the winner has a report of its own).
      if (row.linkedReportId !== undefined) {
        await ctx.db.patch(row._id, { promptState: 'converted' });
        settled++;
        continue;
      }
      if (row.supersededByActivityId !== undefined) {
        await ctx.db.patch(row._id, { promptState: 'dismissed' });
        settled++;
        continue;
      }
      const rows = byUser.get(row.userId);
      if (rows) rows.push(row);
      else byUser.set(row.userId, [row]);
    }

    let prompted = 0;
    let superseded = 0;
    for (const [userId, dueRows] of byUser) {
      const candidates = await sameSkateCandidates(ctx, userId, dueRows);
      const candidateById = new Map(candidates.map((c) => [c._id, c]));
      const result = dedupActivities(candidates.map(toDedupActivity));
      // A loser the user had already been asked about (`prompted`) or had waved off (`dismissed`)
      // settles the *skate*, not the row: the winner inherits that answer, so a phone copy that
      // flushes a day after the watch copy was prompted doesn't ask a second time about the same
      // afternoon — the double prompt B4a exists to prevent.
      const inherited = new Map<Id<'gpsActivities'>, 'prompted' | 'dismissed'>();
      for (const { loser, winner } of result.superseded) {
        const loserId = loser.id as Id<'gpsActivities'>;
        const winnerId = winner.id as Id<'gpsActivities'>;
        const loserRow = candidateById.get(loserId);
        if (!loserRow) continue;
        if (loserRow.promptState === 'dismissed') inherited.set(winnerId, 'dismissed');
        else if (loserRow.promptState === 'prompted' && !inherited.has(winnerId)) {
          inherited.set(winnerId, 'prompted');
        }
        // The link moves rather than breaks: a report must never lose its path to a dedup. Moved,
        // not copied — a loser that kept `linkedReportId` would survive account deletion as a
        // "published" track, and the winner's report would render the loser's path. Only an intact
        // pair moves: the report must point back at this loser, the winner must be free, and the
        // winner must be able to *carry* what the report renders — a stub with no path (a watch
        // that reported "started 14:02" and nothing else) would leave the report's map empty, which
        // is the loss this move exists to prevent. When it can't move — both copies were reported
        // from, or the winner is a stub — the loser keeps its link and stays `converted` (below);
        // `listTracksForBody` skips superseded rows, so the skate still draws once on the aggregate
        // layer. The winner is re-read rather than taken from the pre-loop snapshot, because two
        // losers of one winner would otherwise both see it unlinked and the second would overwrite
        // the first's link.
        let moved = false;
        if (loserRow.linkedReportId !== undefined) {
          const winnerRow = await ctx.db.get(winnerId);
          const report = await ctx.db.get(loserRow.linkedReportId);
          if (
            winnerRow &&
            winnerRow.linkedReportId === undefined &&
            (winnerRow.path !== undefined || loserRow.path === undefined) &&
            report &&
            report.activityId === loserId
          ) {
            await ctx.db.patch(winnerId, {
              linkedReportId: loserRow.linkedReportId,
              promptState: 'converted',
              // The aggregate layer reaches a track through its body (`by_water_body_start_time`),
              // so a winner the resolver couldn't place would take the link and vanish from the
              // lake. It inherits the loser's lake instead — the match rule already vouched for it
              // (equal, or one side unresolved).
              ...(winnerRow.waterBodyId === undefined && loserRow.waterBodyId !== undefined
                ? {
                    waterBodyId: loserRow.waterBodyId,
                    ...(loserRow.waterBodyIds !== undefined
                      ? { waterBodyIds: loserRow.waterBodyIds }
                      : {}),
                  }
                : {}),
            });
            await ctx.db.patch(report._id, { activityId: winnerId });
            moved = true;
          }
        }
        await ctx.db.patch(loserId, {
          supersededByActivityId: winnerId,
          // `dismissed` takes it off every list and out of the sweep's range. A loser whose link
          // could *not* move (the winner has a report of its own) is still a reported skate and stays
          // `converted` — a linked row reading `dismissed` would contradict the lifecycle
          // `linkActivityToReport` writes, and `dismissed` is not what the person said about it.
          promptState: !moved && loserRow.linkedReportId !== undefined ? 'converted' : 'dismissed',
          ...(moved ? { linkedReportId: undefined } : {}),
        });
        superseded++;
      }

      // Who the nudge would go to — and whether they could act on it. A minor can record for
      // themselves but can never file a report (D41), and a restricted poster (D57) can't either, so
      // "Add a report?" would be a call to action the app then refuses. The row is still flipped to
      // `prompted` below ("considered"), for the same reason a switched-off toggle flips it.
      const recipient = await ctx.db.get(userId);
      const canReport =
        recipient !== null &&
        !isMinor(recipient.dateOfBirth, now) &&
        recipient.canPostReports !== false;

      const dueIds = new Set(dueRows.map((r) => r._id));
      for (const winner of result.winners) {
        const id = winner.id as Id<'gpsActivities'>;
        const answered = inherited.get(id);
        // A winner that isn't due yet waits for a later tick — unless a loser handed it an answer,
        // which has to land *now*: that loser was superseded above and is out of the candidate set
        // from here on, so an answer not applied on this tick is gone, and the winner would be asked
        // about a skate the person already answered for (the very double prompt B4a exists to stop).
        if (answered === undefined && !dueIds.has(id)) continue;
        const row = await ctx.db.get(id);
        // Re-read: a link or a dismissal may have landed above, or between the scan and here.
        if (row?.promptState !== 'pending' || row.linkedReportId !== undefined) continue;
        if (answered !== undefined) {
          await ctx.db.patch(id, { promptState: answered });
          continue;
        }
        await ctx.db.patch(id, { promptState: 'prompted' });
        prompted++;
        if (!canReport) continue;
        await enqueueActorNotification(ctx, {
          recipientId: userId,
          targetId: id,
          trigger: { kind: 'activity', activityId: id },
          now,
          flushAfter: now, // already waited hours; the next flush tick delivers
        });
      }
    }
    return { scanned: due.length, prompted, superseded, settled };
  },
});

/**
 * Everything of this user's that the dedup should see alongside the due rows: every activity of
 * theirs that *could* be the same skate as a due row, `pending` or not — a converted watch copy is
 * still the better copy of a skate the phone recorded, and a copy that was prompted a week ago is
 * the answer the winner inherits.
 *
 * Read as one start-time window per due row (`by_user_start_time`, ±`ACTIVITY_DEDUP_START_WINDOW_MS`
 * — the dedup's own rule for "could be the same skate"), so the set is exact whatever else the
 * person has recorded since. It used to be their fifty most recently *inserted* rows, which is a
 * different set: an already-prompted watch copy behind fifty later syncs fell out of it, the sweep
 * couldn't inherit its answer, and the skate was asked about twice (PR #53 review). The due rows are
 * always in the set regardless of the window cap: a due row the read didn't reach would never be a
 * winner or a loser, so it would never leave the `pending` range, and the sweep would re-read it
 * every hour for ever. (The superseded filter below can't strand a due row for the same reason: the
 * sweep settles superseded due rows before it gets here.)
 */
async function sameSkateCandidates(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  dueRows: Doc<'gpsActivities'>[],
): Promise<Doc<'gpsActivities'>[]> {
  const byId = new Map<Id<'gpsActivities'>, Doc<'gpsActivities'>>();
  for (const row of dueRows) byId.set(row._id, row);
  for (const due of dueRows) {
    const nearby = await ctx.db
      .query('gpsActivities')
      .withIndex('by_user_start_time', (q) =>
        q
          .eq('userId', userId)
          .gte('startTime', due.startTime - ACTIVITY_DEDUP_START_WINDOW_MS)
          .lte('startTime', due.startTime + ACTIVITY_DEDUP_START_WINDOW_MS),
      )
      .take(CANDIDATE_WINDOW_CAP);
    for (const row of nearby) byId.set(row._id, row);
  }
  return [...byId.values()].filter((r) => r.supersededByActivityId === undefined);
}

function toDedupActivity(row: Doc<'gpsActivities'>): DedupActivity {
  return {
    id: row._id,
    userId: row.userId,
    provider: row.provider,
    startTime: row.startTime,
    ...(row.endTime !== undefined ? { endTime: row.endTime } : {}),
    ...(row.waterBodyId !== undefined ? { waterBodyId: row.waterBodyId } : {}),
    ...(row.waterBodyIds !== undefined ? { waterBodyIds: row.waterBodyIds } : {}),
  };
}

/**
 * How far `linkActivityToReport` follows `supersededByActivityId` before giving up. A chain is a
 * winner that was itself out-ranked on a later tick — two or three rows in the worst plausible case —
 * and the bound is only so a cycle written by some future bug can't spin a mutation.
 */
const MAX_SUPERSESSION_HOPS = 8;

/**
 * Wire an activity to the report it backs — the join `reports.create` calls after inserting a report
 * with an `activityId`. Kept as a helper (not a public mutation) so the two sides can only ever be
 * written together, inside one transaction: a half-linked pair would render a path on a report the
 * activity doesn't point back to, and the aggregate layer's privacy predicate reads the *activity*
 * side (`linkedReportId`), so a missing back-link would silently drop a track from the map.
 *
 * **A superseded copy hands the link to its winner** (N8/B4a), the same move `sweepUnpromptedActivities`
 * makes when it finds a linked loser — only here the order is reversed: the sweep ran first and the
 * link arrives after. The report form can hold an activity id for hours (drive home, fill it in), and
 * the hourly sweep may have picked a better copy of that skate in between. Linking the loser would
 * leave the winner un-linked and `pending`, to be prompted later about a skate already reported — the
 * double prompt B4a exists to stop — and the skate off the aggregate layer, which skips superseded
 * rows. Redirecting keeps `reports.activityId` and `linkedReportId` pointing at each other, which is
 * the invariant this helper exists for.
 */
export async function linkActivityToReport(
  ctx: MutationCtx,
  activityId: Id<'gpsActivities'>,
  reportId: Id<'reports'>,
  userId: Id<'profiles'>,
): Promise<void> {
  const requested = await ctx.db.get(activityId);
  if (!requested) throw new ConvexError('Activity not found');
  if (requested.userId !== userId) throw new ConvexError('Not your activity');
  let activity = requested;
  for (
    let hops = 0;
    activity.supersededByActivityId !== undefined && hops < MAX_SUPERSESSION_HOPS;
    hops++
  ) {
    const winner = await ctx.db.get(activity.supersededByActivityId);
    // A dangling pointer (the winner went with an account-deletion pass) leaves the link where it
    // was asked for; the ownership check is belt-and-braces, since the sweep dedups within a user.
    if (!winner || winner.userId !== userId) break;
    // The report's path must survive the redirect: a stub winner (start and end, no track) does not
    // take the link off a copy that has one — the same rule the sweep's move applies.
    if (winner.path === undefined && activity.path !== undefined) break;
    activity = winner;
  }
  // A winner already carrying another report keeps it, and this report links the copy it was filed
  // from — the state the sweep leaves when a link cannot move (both copies reported from): the
  // aggregate layer draws the winner's track, this report still shows its own. Refusing here would
  // block a report over a dedup the person never saw.
  if (
    activity._id !== requested._id &&
    activity.linkedReportId !== undefined &&
    activity.linkedReportId !== reportId
  ) {
    activity = requested;
  }
  if (activity.linkedReportId !== undefined && activity.linkedReportId !== reportId) {
    throw new ConvexError('This skate is already attached to another report');
  }
  await ctx.db.patch(activity._id, { linkedReportId: reportId, promptState: 'converted' });
  if (activity._id !== activityId) await ctx.db.patch(reportId, { activityId: activity._id });
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
      // A superseded copy is skipped — the better copy is in the list already — and skipped *before*
      // the take, so it doesn't eat a slot and hand back fewer than `limit` while older skates exist.
      .filter((q) => q.eq(q.field('supersededByActivityId'), undefined))
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
    // Sanitized, not trusted: a `NaN` off the wire is an index bound that matches nothing, which would
    // draw an empty lake rather than refusing the question.
    const season = resolveSeason(args.season, seasonOf(Date.now()));
    const activities = await ctx.db
      .query('gpsActivities')
      .withIndex('by_water_body_start_time', (q) =>
        q
          .eq('waterBodyId', body._id)
          .gte('startTime', seasonStartMs(season))
          .lt('startTime', seasonEndMs(season)),
      )
      .order('desc')
      // A superseded copy never draws, whatever it links to. The dedup (`sweepUnpromptedActivities`)
      // moves a loser's link to the winner when it can; when it can't — the winner has a report of
      // its own, so both copies of one skate were reported from — the loser keeps its link and stays
      // `converted`, and publish-is-consent alone would draw the same skate twice. Its report still
      // shows its own path (`getForReport`); this layer draws each skate once. Filtered before the
      // take, as `listMine` does, so a superseded row doesn't spend a slot.
      .filter((q) => q.eq(q.field('supersededByActivityId'), undefined))
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
