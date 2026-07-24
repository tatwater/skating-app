/**
 * Bounties (D10/D17/D44) — "someone wants fresh eyes on this lake." A request, not safety content, so
 * reputation never gates who may post; the only junk controls are a **freshness gate** (no bounty on a
 * body that already has fresh eyes, decision 8) and a **rolling per-requester cap** (decision 7). Both
 * gates are pure `@skating/core` functions, re-enforced here at the trust boundary.
 *
 * Lifecycle: `open` → `fulfilled` (the requester thumbs a fulfilling report helpful), `cancelled` (the
 * requester cancels), or `expired` (the sweep, past `expiresAt`). The reward is a **separate currency**
 * (`bountyPoints`, decision 11): fulfilling awards `bounties.rewardPoints` to the *report author*, never
 * touching `reputationPoints`, so trust stays purely about report/hazard accuracy.
 *
 * The GPS-skate half of eligibility (D44) is dark until Phase 8; Phase 6 fans out to authors who
 * *reported* on the body recently.
 */

import {
  BOUNTY_DAILY_WINDOW_MS,
  BOUNTY_ELIGIBILITY_WINDOW_HOURS,
  BOUNTY_FRESH_MAX_MULTIPLIER,
  BOUNTY_FRESH_MAX_REPORTS,
  BOUNTY_REOPEN_FREEZING_DEGREE_HOURS,
  BOUNTY_REOPEN_THAW_DEGREE_HOURS,
  bboxIntersects,
  bountyFreshWindowHours,
  DEFAULT_BOUNTY_LIFETIME_MS,
  DEFAULT_BOUNTY_REWARD_POINTS,
  FRESH_REPORT_HOURS,
  haversineMeters,
  isMinor,
  MAX_OPEN_BOUNTIES_PER_DAY,
  reportSuppressesBounty,
  weatherExplainsIceChange,
  withinDailyBountyLimit,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { isListed } from './lib/listing';
import { awardPointEvent, checkAndAwardBadges, tallyThumbs, trustClassFor } from './lib/reputation';
import { nearestSamplePoint } from './lib/sampling';
import { bbox, latLng } from './lib/validators';
import { resolveWeatherSince } from './weather';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on the `listOpen` index scan (decision 13 browse surface). The open-bounty set is small
 * and bounded by design (≤3 open per requester in a rolling 24h × a ~30-day lifetime), so a plain
 * `by_status_expires` scan is read-cap-safe — unlike the water-body geospatial viewport path, whose
 * reads scale with search *area* (see roadmap → Later/deferred: `listInViewport` hardening). If the
 * live open set ever approaches this cap we log the truncation (never silent, D5) and would then add a
 * dedicated bounties geospatial instance; at alpha scale it never bites.
 */
const OPEN_BOUNTY_SCAN_CAP = 200;

/** Visible reports on a body with a skate-end at or after `cutoff` — the input to both create gates. */
async function recentReports(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cutoff: number,
): Promise<Doc<'reports'>[]> {
  return ctx.db
    .query('reports')
    .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
      q
        .eq('waterBodyId', waterBodyId)
        .eq('moderationStatus', 'visible')
        .gte('skateEndTime', cutoff),
    )
    .collect();
}

/**
 * One recent report weighed by the **base (weather-free)** freshness gate. Both the freshness query
 * (which fetches each suppressor's weather) and the transactional create-check (which re-decides at
 * commit) work from these. Carries `reportId` so a weather verdict can be tied back to its report, and
 * `windowH` so the analytics log can record the window the gate *actually applied* rather than the
 * base constant (Phase 7b — that pair is one dot on the suppression scatter).
 */
interface EvaluatedReport {
  reportId: Id<'reports'>;
  skateEndTime: number;
  netThumbs: number;
  trustClass: ReturnType<typeof trustClassFor>;
  /** The trust/thumbs-weighted freshness window applied to this report, in hours. */
  windowH: number;
}

/**
 * The body's baseline (weather-free) freshness verdict: recent visible reports, newest-first, each
 * weighted by author trust + net thumbs.
 *
 * `suppressors` are the ones that suppress **without** weather, capped at `BOUNTY_FRESH_MAX_REPORTS`.
 * Weather only ever *shrinks* a report's freshness window (a big freeze/thaw **reopens** a bounty,
 * D56), so a report that doesn't suppress even weather-free can never suppress with it — dropping it
 * is safe and bounds both the action's weather fetch and this scan. Reads only, so it's shared by the
 * `bountyFreshnessInputs` query and the `createChecked` mutation (§7c).
 *
 * `newest` is the freshest recent report **whether or not it suppresses** — carried purely for the
 * gate log (Phase 7b). Without it the suppression scatter would only ever plot blocked attempts, and
 * "dots below the line = allowed" would be empty by construction: an allowed attempt usually has no
 * suppressors at all, so the closest call is the only honest reference point it has.
 *
 * Newest-first matters twice: the freshest suppressor has the shortest weather window (most robust to
 * a reopen), and capping on *suppressors* rather than raw recency stops a strong OLDER read from being
 * crowded out of the cap by fresher-but-expired reads (the newest-N-of-all bug).
 */
async function evaluateFreshness(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
  now: number,
): Promise<{ suppressors: EvaluatedReport[]; newest: EvaluatedReport | null }> {
  const maxWindowMs = FRESH_REPORT_HOURS * BOUNTY_FRESH_MAX_MULTIPLIER * HOUR_MS;
  const recent = await recentReports(ctx, body._id, now - maxWindowMs);
  const newestFirst = [...recent].sort((a, b) => b.skateEndTime - a.skateEndTime);

  const suppressors: EvaluatedReport[] = [];
  let newest: EvaluatedReport | null = null;
  for (const r of newestFirst) {
    if (suppressors.length >= BOUNTY_FRESH_MAX_REPORTS) break;
    const author = await ctx.db.get(r.authorId);
    const { helpful, unhelpful } = await tallyThumbs(ctx, 'report', r._id);
    const netThumbs = helpful - unhelpful;
    const trustClass = author ? trustClassFor(author, now) : null;
    const evaluated: EvaluatedReport = {
      reportId: r._id,
      skateEndTime: r.skateEndTime,
      netThumbs,
      trustClass,
      windowH: bountyFreshWindowHours(FRESH_REPORT_HOURS, { netThumbs, trustClass }),
    };
    // The list is newest-first, so the first report we weigh is the freshest one on the body.
    newest ??= evaluated;
    if (
      !reportSuppressesBounty(r.skateEndTime, now, FRESH_REPORT_HOURS, { netThumbs, trustClass })
    ) {
      continue;
    }
    suppressors.push(evaluated);
  }
  return { suppressors, newest };
}

/**
 * Is this requester under the rolling per-requester open-bounty cap (decision 7)? Returns a boolean
 * rather than throwing so the **caller** decides what a rejection means: the pre-weather gate
 * (`bountyFreshnessInputs`) uses it to skip the Open-Meteo round-trip for a caller who'd be rejected
 * anyway, and `createChecked` — the transactional authority, since a concurrent create could fill the
 * cap after the pre-check — uses it to record a `capped` gate event before returning the rejection.
 * (A thrown mutation rolls its writes back, so the log has to happen on a path that commits.)
 */
async function underOpenBountyCap(
  ctx: QueryCtx,
  requesterId: Id<'profiles'>,
  now: number,
): Promise<boolean> {
  const open = await ctx.db
    .query('bounties')
    .withIndex('by_requester_status', (q) => q.eq('requesterId', requesterId).eq('status', 'open'))
    .collect();
  return withinDailyBountyLimit(
    open.map((b) => b.createdAt),
    now,
    MAX_OPEN_BOUNTIES_PER_DAY,
    BOUNTY_DAILY_WINDOW_MS,
  );
}

/** The user-facing rejection copy for each gate verdict — one place, so the action and tests agree. */
const GATE_MESSAGES = {
  suppressed: 'This lake already has fresh eyes — no bounty needed',
  capped: 'You already have the maximum number of open bounties',
} as const;

/**
 * Append the gate's verdict to `bountyGateEvents` (Phase 7b). Called on **every** attempt, including
 * both rejections — that's the entire point of the table: the suppression window and the daily cap are
 * invisible constants until you can see the attempts they blocked. `decidingReport` is the blocker
 * when suppressed and the closest call when allowed, so each row is one (age, window) dot on the
 * scatter the roadmap asks for.
 */
async function logGateEvent(
  ctx: MutationCtx,
  args: {
    waterBodyId: Id<'waterBodies'>;
    requesterId: Id<'profiles'>;
    decision: 'allowed' | 'suppressed' | 'capped';
    decidingReport: EvaluatedReport | null;
    weatherReopened: boolean;
    now: number;
  },
): Promise<void> {
  const r = args.decidingReport;
  await ctx.db.insert('bountyGateEvents', {
    waterBodyId: args.waterBodyId,
    requesterId: args.requesterId,
    decision: args.decision,
    weatherReopened: args.weatherReopened,
    ...(r
      ? {
          decidingReportId: r.reportId,
          reportAgeH: Math.max(0, (args.now - r.skateEndTime) / HOUR_MS),
          appliedWindowH: r.windowH,
          netThumbs: r.netThumbs,
          ...(r.trustClass !== null ? { trustClass: r.trustClass } : {}),
        }
      : {}),
    createdAt: args.now,
  });
}

/**
 * The decay-freshness gate's DB inputs (Phase 10 / §7c): the body's weather sample point + its baseline
 * suppressors (newest-first, read-bounded), each carrying its `reportId`. The action fetches each
 * candidate's **weather-since** to decide which weather has likely reopened; the final fresh-eyes verdict
 * is re-made transactionally in `createChecked`, so a suppressor that lands mid-fetch can't slip through.
 *
 * Returns a **verdict, not a throw**, for the two outcomes the analytics log cares about (Phase 7b):
 * `unavailable` (body missing/unlisted — `createChecked` raises the proper error) and `capped`. The cap
 * used to throw right here; it now short-circuits instead, so the attempt still reaches a mutation that
 * can record it. The resource guard the throw provided is preserved exactly — a capped caller skips the
 * per-report Open-Meteo fetch loop, it just gets counted on the way out. Genuine *auth* failures (no
 * profile, suspended/banned, minor) still throw: they aren't gate tuning signals, they're rejections.
 */
export const bountyFreshnessInputs = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const now = Date.now();
    // Authorize BEFORE any weather I/O (§7c security). This query is the action's first step, so gating
    // it here means an authenticated-but-ineligible caller — no profile, suspended/banned (`requireProfile`),
    // or a minor — is rejected before we drive any per-report Open-Meteo fetch + cache write on the app's
    // shared free-tier quota. `createChecked` re-asserts the same gate at write time as the transactional
    // authority (defense in depth); this pre-gate just stops rejected callers from burning external I/O.
    const profile = await requireProfile(ctx);
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post bounties');
    }
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body || !isListed(body)) return { status: 'unavailable' as const };
    // The rolling open-bounty cap, BEFORE the action's weather loop: a capped requester would be
    // rejected by `createChecked` regardless, so don't let repeated capped requests drive per-report
    // Open-Meteo fetches + cache writes first (§7c resource guard).
    if (!(await underOpenBountyCap(ctx, profile._id, now))) return { status: 'capped' as const };
    const point = nearestSamplePoint(body, body.centroid);
    const { suppressors } = await evaluateFreshness(ctx, body, now);
    return {
      status: 'ok' as const,
      lat: point.lat,
      lng: point.lng,
      reports: suppressors.map((s) => ({ reportId: s.reportId, skateEndTime: s.skateEndTime })),
    };
  },
});

/**
 * Post a bounty on a body (decision 7). An **action** (Phase 10 / §7c) so the freshness gate can consult
 * the weather: for each recent report it fetches the weather-since and asks whether that plausibly changed
 * the ice — a big freeze/thaw **reopens** bounties sooner (D56). The weather-aware verdict is then handed to
 * `createChecked`, which does the auth/minor/cap checks + insert (a mutation can't fetch, so the two split).
 */
export const create = action({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<Id<'bounties'>> => {
    // Cheap anonymous-caller reject BEFORE the runQuery round-trip — a fully unauthenticated request never
    // even hits the DB. The full posting eligibility (profile exists, active, adult) is then enforced inside
    // `bountyFreshnessInputs` below, which runs before any Open-Meteo fetch, so an authenticated-but-
    // ineligible caller can't drive external weather I/O either. `createChecked` re-asserts at write time.
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError('Not signed in');
    const now = Date.now();
    const inputs = await ctx.runQuery(internal.bounties.bountyFreshnessInputs, { waterBodyId });

    // Weather only ever REOPENS a bounty (it shrinks a suppressor's freshness window, D56) — it never
    // *creates* suppression. So the action's only job is to find which baseline suppressors the weather
    // has likely cleared; the actual fresh-eyes decision is re-made transactionally in `createChecked`
    // against the reports as they exist at commit. That closes the read-in-action / write-in-mutation
    // TOCTOU (§7c): a suppressing report that lands mid-fetch is seen by the mutation, not the action,
    // and — absent from this reopened set — correctly blocks the bounty instead of slipping through.
    //
    // Each exemption carries the `skateEndTime` the verdict was computed against: a report edited to a
    // LATER skate time between here and the commit has a *shorter* weather window that may no longer
    // justify the reopen, so `createChecked` only honors the exemption when the timestamp still matches.
    const weatherReopenedReports: { reportId: Id<'reports'>; skateEndTime: number }[] = [];
    if (inputs.status === 'ok') {
      for (const r of inputs.reports) {
        const summary = await resolveWeatherSince(ctx, inputs.lat, inputs.lng, r.skateEndTime, now);
        // Only trust the weather signal when we actually have data; a failed fetch (`null`) or empty
        // window ⇒ no reopen (fail-open — a fetch miss never opens a bounty, it just leaves the report
        // suppressing via recency × thumbs × trust in the mutation).
        const reopened =
          summary && summary.hours > 0
            ? weatherExplainsIceChange(summary, {
                // A HIGHER bar than the contradiction check's default — one ordinary freezing night must
                // not reopen a well-corroborated report's bounty (§7c). Admin-tunable in Phase 7.
                freezingDegreeHours: BOUNTY_REOPEN_FREEZING_DEGREE_HOURS,
                thawDegreeHours: BOUNTY_REOPEN_THAW_DEGREE_HOURS,
              })
            : false;
        if (reopened) {
          weatherReopenedReports.push({ reportId: r.reportId, skateEndTime: r.skateEndTime });
        }
      }
    }
    // `createChecked` **returns** its gate verdict rather than throwing it, so the rejection commits
    // alongside the `bountyGateEvents` row that records it (a thrown mutation rolls its writes back —
    // which would have made the two most interesting decisions, `suppressed` and `capped`, the two the
    // analytics could never see). The action turns a rejection back into the user-facing error here,
    // after the log has landed.
    const result = await ctx.runMutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports,
    });
    if (!result.ok) throw new ConvexError(result.message);
    return result.bountyId;
  },
});

/** What the gate decided — `ok` carries the new bounty, a rejection carries its user-facing copy. */
type CreateOutcome =
  | { ok: true; bountyId: Id<'bounties'> }
  | { ok: false; decision: 'suppressed' | 'capped'; message: string };

/**
 * Finish a bounty create once the action has fetched weather: `requireProfile`, **reject minors**, honor
 * the rolling open-bounty cap + freshness gate (decision 7/8), insert, and fan out `bounty_request`
 * notices. Internal — only `create` (the action) calls it, passing the reports weather has likely reopened.
 *
 * **The two gate rejections return instead of throwing** (Phase 7b). Every attempt appends a
 * `bountyGateEvents` row, and a thrown mutation rolls its writes back — so a throwing gate could only
 * ever log the attempts it *allowed*, which is precisely the half that can't tell you whether
 * `FRESH_REPORT_HOURS` or `MAX_OPEN_BOUNTIES_PER_DAY` is set right. The caller re-raises. Auth failures
 * (no profile, minor, missing body) still throw — those are errors, not tuning signals.
 *
 * The cap is now checked **before** freshness (it used to be after). Two reasons: the cap is the
 * unambiguous reason when both apply, so it's the more actionable message; and the weather pass is
 * skipped for a capped caller, which would leave the freshness verdict computed without its exemptions
 * and mislabel the event as `suppressed`.
 */
export const createChecked = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    /**
     * Reports the action's weather pass determined are likely reopened (ice changed since), each tagged
     * with the `skateEndTime` its weather window was computed against so the exemption can be revalidated
     * against the current report at commit (§7c).
     */
    weatherReopenedReports: v.array(
      v.object({ reportId: v.id('reports'), skateEndTime: v.number() }),
    ),
  },
  handler: async (ctx, { waterBodyId, weatherReopenedReports }): Promise<CreateOutcome> => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post bounties');
    }

    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body || !isListed(body)) throw new ConvexError('Water body not found');

    // Rolling per-requester cap (decision 7), re-checked transactionally here — the pre-weather gate
    // already short-circuited obviously-capped callers, but a concurrent create could have filled the
    // cap since. Checked before freshness so the recorded decision names the unambiguous reason.
    if (!(await underOpenBountyCap(ctx, profile._id, now))) {
      await logGateEvent(ctx, {
        waterBodyId: body._id,
        requesterId: profile._id,
        decision: 'capped',
        decidingReport: null,
        weatherReopened: false,
        now,
      });
      return { ok: false, decision: 'capped', message: GATE_MESSAGES.capped };
    }

    // Freshness gate (decision 8), re-evaluated **transactionally** here (§7c) rather than trusting the
    // action's snapshot: recompute the body's baseline suppressors from the reports *as they exist now*
    // and block on any the action did NOT clear as weather-reopened. Because weather only ever reopens
    // (never creates) suppression, a suppressor absent from the reopened set is genuine fresh eyes —
    // including a report that landed during the action's Open-Meteo round-trip, whose near-zero weather
    // window means its baseline verdict already equals its weather-aware one. This closes the read-in-
    // action / write-in-mutation race that could otherwise persist an ineligible bounty (+ fan out notices).
    //
    // The exemption is keyed on `reportId:skateEndTime`, not id alone: if a report's `skateEndTime` was
    // edited later after the weather verdict was computed, its window is now shorter and may no longer
    // justify the reopen, so the stale exemption is dropped and the (now-fresher) report suppresses again.
    const reopened = new Set(weatherReopenedReports.map((r) => `${r.reportId}:${r.skateEndTime}`));
    const { suppressors, newest } = await evaluateFreshness(ctx, body, now);
    const blocking = suppressors.find((c) => !reopened.has(`${c.reportId}:${c.skateEndTime}`));
    if (blocking) {
      await logGateEvent(ctx, {
        waterBodyId: body._id,
        requesterId: profile._id,
        decision: 'suppressed',
        decidingReport: blocking,
        weatherReopened: false,
        now,
      });
      return { ok: false, decision: 'suppressed', message: GATE_MESSAGES.suppressed };
    }

    // An allow that had suppressors is exactly the weather-reopen case (D56): the base gate would have
    // blocked this, and a freeze/thaw since cleared every blocker. That share, over time, is the only
    // evidence for whether BOUNTY_REOPEN_FREEZING/THAW_DEGREE_HOURS ever fire in the real world.
    await logGateEvent(ctx, {
      waterBodyId: body._id,
      requesterId: profile._id,
      decision: 'allowed',
      // The report the verdict turned on: the newest suppressor weather cleared, or — when nothing
      // suppressed at all — the freshest report on the body, i.e. the closest this attempt came to
      // being blocked. Either way the row plots a real (age, window) pair below the line.
      decidingReport: suppressors[0] ?? newest,
      weatherReopened: suppressors.length > 0,
      now,
    });

    const bountyId = await ctx.db.insert('bounties', {
      requesterId: profile._id,
      waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      status: 'open',
      rewardPoints: DEFAULT_BOUNTY_REWARD_POINTS,
      fulfillingReportIds: [],
      createdAt: now,
      expiresAt: now + DEFAULT_BOUNTY_LIFETIME_MS,
    });

    await fanOutEligibility(ctx, {
      bountyId,
      waterBodyId: body._id,
      requesterId: profile._id,
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      now,
    });
    return { ok: true, bountyId };
  },
});

/**
 * Notify the eligible: authors who reported on this body within `windowHours` (decision 9). Per-actor
 * `bounty_request` rows inserted **directly** (the body-keyed coalescing queue doesn't fit a one-off
 * request), respecting `notificationPrefs.bountyRequest` + `status === 'active'`, never the requester.
 * The GPS-skate half of eligibility (D44) lands in Phase 8.
 */
async function fanOutEligibility(
  ctx: MutationCtx,
  args: {
    bountyId: Id<'bounties'>;
    waterBodyId: Id<'waterBodies'>;
    requesterId: Id<'profiles'>;
    windowHours: number;
    now: number;
  },
): Promise<void> {
  const recent = await recentReports(ctx, args.waterBodyId, args.now - args.windowHours * HOUR_MS);
  const notified = new Set<string>([args.requesterId]); // never notify the requester; dedup authors
  for (const report of recent) {
    if (notified.has(report.authorId)) continue;
    notified.add(report.authorId);
    const author = await ctx.db.get(report.authorId);
    if (!author) continue;
    if (author.status !== 'active' || !author.notificationPrefs.bountyRequest) continue;
    await ctx.db.insert('notifications', {
      userId: report.authorId,
      type: 'bounty_request',
      payload: {
        bountyId: args.bountyId,
        waterBodyId: args.waterBodyId,
        requesterId: args.requesterId,
      },
      createdAt: args.now,
    });
  }
}

/** Cancel your own open bounty (→ `cancelled`, decision 10). Only the requester; only while open. */
export const cancel = mutation({
  args: { bountyId: v.id('bounties') },
  handler: async (ctx, { bountyId }) => {
    const profile = await requireProfile(ctx);
    const bounty = await ctx.db.get(bountyId);
    if (!bounty) throw new ConvexError('Bounty not found');
    if (bounty.requesterId !== profile._id) throw new ConvexError('Only the requester can cancel');
    if (bounty.status !== 'open') throw new ConvexError('Bounty is not open');
    await ctx.db.patch(bountyId, { status: 'cancelled' });
  },
});

/**
 * Auto-attach (decision 10) — invoked from `reports.create` for each new **visible** report. Appends the
 * report to every open bounty on its body's `fulfillingReportIds` (the minimum bar is deliberately simple:
 * any new visible report on the body). Fulfillment itself waits for the requester's helpful thumb.
 */
export async function attachReportToOpenBounties(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<void> {
  const open = await ctx.db
    .query('bounties')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', report.waterBodyId).eq('status', 'open'),
    )
    .collect();
  for (const bounty of open) {
    if (bounty.fulfillingReportIds.includes(report._id)) continue;
    await ctx.db.patch(bounty._id, {
      fulfillingReportIds: [...bounty.fulfillingReportIds, report._id],
    });
  }
}

/**
 * Fulfillment-on-helpful (decisions 10–11) — invoked from `ratings.rate` when the **requester** thumbs a
 * fulfilling report helpful. Flips the bounty to `fulfilled` and awards `rewardPoints` (as
 * `bounty_fulfilled` → `bountyPoints`) to the **report author**, then notifies them. Guarded so a bounty
 * fulfills once: no-op unless still `open`, the rater is the requester, and the report is in its
 * fulfilling set. (The rater can't be the report author — self-rating is already blocked upstream — so
 * nobody rewards themselves.)
 *
 * **Fulfillment is terminal — a later retracted thumb does NOT un-fulfill (deliberate).** If the requester
 * later flips their vote to `unhelpful`, the `helpful_thumb` *reputation* boost reverses honestly (a
 * compensating ledger row), but the bounty stays `fulfilled` and the author keeps their `bountyPoints`: a
 * report that satisfied the request WAS provided, and clawing back an earned achievement currency on a
 * requester's later whim is worse than a cosmetic status/vote mismatch (which is split across two surfaces
 * anyway — the bounty hides its thumbs once fulfilled). Reversal would also need to record *which* report
 * fulfilled the bounty; if we ever want it, add `fulfilledByReportId` and reverse only on that report.
 */
export async function fulfillBountyOnHelpful(
  ctx: MutationCtx,
  args: { bountyId: Id<'bounties'>; reportId: Id<'reports'>; raterId: Id<'profiles'> },
): Promise<void> {
  const bounty = await ctx.db.get(args.bountyId);
  if (!bounty) return;
  if (bounty.status !== 'open') return;
  if (bounty.requesterId !== args.raterId) return;
  if (!bounty.fulfillingReportIds.includes(args.reportId)) return;
  const report = await ctx.db.get(args.reportId);
  if (!report) return;

  // `fulfilledAt` is stamped alongside the status so the time-to-fulfillment histogram has an end
  // point (Phase 7b) — `status` alone only records *that* it happened, never how long people waited,
  // which is the half that says whether DEFAULT_BOUNTY_LIFETIME_MS is anywhere near the real answer time.
  await ctx.db.patch(args.bountyId, { status: 'fulfilled', fulfilledAt: Date.now() });
  await awardPointEvent(ctx, {
    userId: report.authorId,
    reason: 'bounty_fulfilled',
    refId: args.bountyId,
    delta: bounty.rewardPoints,
  });
  await checkAndAwardBadges(ctx, report.authorId);

  const author = await ctx.db.get(report.authorId);
  if (!author) return;
  if (author.status !== 'active' || !author.notificationPrefs.bountyFulfilled) return;
  await ctx.db.insert('notifications', {
    userId: report.authorId,
    type: 'bounty_fulfilled',
    payload: { bountyId: args.bountyId, reportId: args.reportId, requesterId: bounty.requesterId },
    createdAt: Date.now(),
  });
}

/**
 * Expiry sweep (decision 12) — flip every `open` bounty past `expiresAt` to `expired`. Reads the
 * dedicated `by_status_expires` index so a global sweep never full-scans. Run by the `crons.ts` interval.
 */
export const expireBounties = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('bounties')
      .withIndex('by_status_expires', (q) => q.eq('status', 'open').lte('expiresAt', now))
      .collect();
    for (const bounty of due) await ctx.db.patch(bounty._id, { status: 'expired' });
    return { expired: due.length };
  },
});

/** One bounty for its detail view. Public — bounties aren't gated by trust or blocks. */
export const get = query({
  args: { bountyId: v.id('bounties') },
  handler: (ctx, { bountyId }) => ctx.db.get(bountyId),
});

/**
 * The enriched `/bounty/$id` detail payload (D47) in one round-trip: the requester (ringed by trust), the
 * survivor water body, and the **visible** candidate reports that have auto-attached — each with its author
 * and an `isOwn` flag so the client knows whether the requester may thumb it (self-rating can't fulfill).
 * `isRequester` gates the cancel + fulfillment affordances. Returns `null` if the bounty is gone.
 */
export const getDetail = query({
  args: { bountyId: v.id('bounties') },
  handler: async (ctx, { bountyId }) => {
    const bounty = await ctx.db.get(bountyId);
    if (!bounty) return null;
    const now = Date.now();
    const viewer = await getCurrentProfile(ctx);
    const requester = await ctx.db.get(bounty.requesterId);
    const body = await resolveSurvivor(ctx, bounty.waterBodyId);

    const fulfillingReports = [];
    for (const reportId of bounty.fulfillingReportIds) {
      const report = await ctx.db.get(reportId);
      if (report?.moderationStatus !== 'visible') continue;
      const author = await ctx.db.get(report.authorId);
      fulfillingReports.push({
        _id: report._id,
        skateEndTime: report.skateEndTime,
        ...(report.skateQuality !== undefined ? { skateQuality: report.skateQuality } : {}),
        authorName: author?.displayName ?? 'Unknown',
        authorTrustClass: author ? trustClassFor(author, now) : null,
        isOwn: viewer?._id === report.authorId,
      });
    }

    return {
      _id: bounty._id,
      status: bounty.status,
      rewardPoints: bounty.rewardPoints,
      createdAt: bounty.createdAt,
      expiresAt: bounty.expiresAt,
      waterBody: body && isListed(body) ? { _id: body._id, name: body.name } : null,
      requester: requester
        ? {
            userId: requester._id,
            displayName: requester.displayName,
            username: requester.username,
            trustClass: trustClassFor(requester, now),
          }
        : { userId: bounty.requesterId, displayName: 'Unknown', username: '', trustClass: null },
      isRequester: !!viewer && viewer._id === bounty.requesterId,
      fulfillingReports,
    };
  },
});

/** The open bounties on a body (for the map/detail surfaces), newest first, with the requester's name. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const now = Date.now();
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_water_body_status', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('status', 'open'),
      )
      .collect();
    open.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(
      open.map(async (b) => {
        const requester = await ctx.db.get(b.requesterId);
        return {
          _id: b._id,
          requester: requester
            ? {
                displayName: requester.displayName,
                username: requester.username,
                trustClass: trustClassFor(requester, now),
              }
            : { displayName: 'Unknown', username: '', trustClass: null },
          rewardPoints: b.rewardPoints,
          fulfillingCount: b.fulfillingReportIds.length,
          createdAt: b.createdAt,
          expiresAt: b.expiresAt,
        };
      }),
    );
  },
});

/**
 * The **global / near-me / in-viewport open-bounty browse** (decision 3 clarification, 2026-07-22). This
 * deliberately sidesteps the read-cap-fragile water-body geospatial viewport path: the open-bounty set is
 * small and bounded, so we scan the dedicated `by_status_expires` index (open, not-yet-expired), hydrate
 * each body + requester, then filter/sort **in JS** — no S2 read-ahead, no 4,096-reads crash surface.
 *
 * - `viewport` (web map markers / in-view list): keep only bounties whose body's bbox intersects the rect.
 * - `near` (client-supplied coord, e.g. live GPS): attach `distanceMeters` and sort ascending — safe to
 *   return the distance because the caller already knows its own location.
 * - `sortByHome` (mobile "bounties near me" tab): sort by distance to the **viewer's private home coord**,
 *   read server-side. The home coord never leaves the server (D11), and we deliberately **do not** return
 *   `distanceMeters` in this mode — exact distances to several public lakes could trilaterate the home.
 *   Falls back to newest-first when the viewer has no home set.
 * - none of the above: newest-first (`createdAt` desc).
 *
 * Bounties are not gated by trust or blocks (see `get`), so no viewer-scoped hiding. Bodies since removed
 * (unlisted) are dropped. `limit` caps the returned rows; the scan itself is capped at `OPEN_BOUNTY_SCAN_CAP`.
 */
export const listOpen = query({
  args: {
    viewport: v.optional(bbox),
    near: v.optional(latLng),
    sortByHome: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { viewport, near, sortByHome, limit }) => {
    const now = Date.now();
    // The coord we sort by: an explicit client coord wins; otherwise the viewer's private home (D11) when
    // they asked to sort near home. Distances are only *returned* for a client-supplied `near` (above).
    const viewer = sortByHome && !near ? await getCurrentProfile(ctx) : null;
    const sortCoord = near ?? viewer?.homeCoord;
    // Still-valid open bounties, soonest-expiring first, bounded read. `.gt('expiresAt', now)` drops any
    // past `expiresAt` the sweep hasn't flipped yet — a browse should never surface a dead bounty.
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_status_expires', (q) => q.eq('status', 'open').gt('expiresAt', now))
      .take(OPEN_BOUNTY_SCAN_CAP);
    if (open.length === OPEN_BOUNTY_SCAN_CAP) {
      console.warn(
        `bounties.listOpen hit the ${OPEN_BOUNTY_SCAN_CAP}-row scan cap; some open bounties may be omitted.`,
      );
    }

    const rows = [];
    for (const b of open) {
      const body = await resolveSurvivor(ctx, b.waterBodyId);
      if (!body || !isListed(body)) continue; // bounty on a since-removed body — skip
      if (viewport && !bboxIntersects(body.bbox, viewport)) continue;
      const requester = await ctx.db.get(b.requesterId);
      rows.push({
        _id: b._id,
        waterBodyId: body._id,
        waterBodyName: body.name,
        centroid: body.centroid,
        requester: requester
          ? {
              displayName: requester.displayName,
              username: requester.username,
              trustClass: trustClassFor(requester, now),
            }
          : { displayName: 'Unknown', username: '', trustClass: null },
        rewardPoints: b.rewardPoints,
        fulfillingCount: b.fulfillingReportIds.length,
        createdAt: b.createdAt,
        expiresAt: b.expiresAt,
        ...(near ? { distanceMeters: haversineMeters(near, body.centroid) } : {}),
      });
    }

    if (sortCoord) {
      // Precompute each row's distance once (n calls), not per comparison (≈ n·log n calls), then sort on
      // the cached numbers — the comparator stays a pure subtraction.
      const distance = new Map(rows.map((r) => [r._id, haversineMeters(sortCoord, r.centroid)]));
      rows.sort((a, b) => (distance.get(a._id) ?? 0) - (distance.get(b._id) ?? 0));
    } else {
      rows.sort((a, b) => b.createdAt - a.createdAt);
    }
    const cap =
      limit !== undefined && limit > 0 ? Math.min(limit, OPEN_BOUNTY_SCAN_CAP) : rows.length;
    return rows.slice(0, cap);
  },
});

/** The caller's own bounties across all statuses, newest first (the "my bounties" surface). */
export const myBounties = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getCurrentProfile(ctx);
    if (!viewer) return [];
    const mine = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) => q.eq('requesterId', viewer._id))
      .collect();
    return mine.sort((a, b) => b.createdAt - a.createdAt);
  },
});
