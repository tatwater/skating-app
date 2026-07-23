/**
 * Corroboration **contradiction signal** (Phase 10 / D56 §7b) — the inverse seam of `runCorroboration`.
 * When recent reports on the same body strongly disagree AND the weather-since between them doesn't explain
 * the change, it's a contradiction. This does **three** things, none of which subtracts trust (D50 stays
 * boost-only; honest "the ice changed" reports are never punished — D3):
 *   1. **Withhold** the corroboration boost — already the default (only agreement awards).
 *   2. **Disclose** the conflict — every disagreeing report gets a soft, **symmetric** `conflicting` flag
 *      skaters can see, so the human judges the disagreement rather than us secretly deciding who's wrong.
 *   3. **Escalate on pattern — the un-corroborated minority, not the later poster.** This is consensus-based
 *      and **order-independent** (D56 §7b, decided in the 2026-07-23 review): a report is a *contradiction*
 *      only when a report it disagrees with (weather-unexplained) has **strictly more corroboration** while
 *      it itself has **none**. So a lone false read — whether it was posted first or last — accrues the
 *      author's private, non-scoring `contradictionCount`, while the corroborated majority never does. It's
 *      recomputed from the current corroboration state on every settle, so a report that *later* earns
 *      corroboration **clears** its flag and decrements its author (self-correcting). Once an author's count
 *      crosses `CONTRADICTION_FLAG_THRESHOLD`, a moderator flag is filed — the D57 posting-permission lever
 *      is the human's response, never a point penalty.
 *
 * A mutation can't fetch, so `reports.create` schedules `settleContradictions` post-insert (after
 * `runCorroboration` has run, so the new report's agreements are already in the ledger). Fail-open: no
 * weather data ⇒ we can't confirm a disagreement, so we don't record it.
 */

import {
  CONTRADICTION_FLAG_THRESHOLD,
  CORROBORATION_WINDOW_MS,
  reportsContradict,
  weatherExplainsIceChange,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import { nearestSamplePoint } from './lib/sampling';
import { resolveWeatherSince } from './weather';

/**
 * The shortest inter-report gap over which weather could plausibly change the ice. Below it, a disagreement
 * is a real contradiction (weather can't explain it) rather than a "can't tell" — and the window is too
 * short to even summarize. One hour, matching the `weatherCache` bucket granularity.
 */
const WEATHER_MIN_EXPLAIN_WINDOW_MS = 3_600_000;

/** One report in the settle cluster, with its current corroboration tally + stored flags. */
interface ClusterReport {
  id: Id<'reports'>;
  authorId: Id<'profiles'>;
  skateEndTime: number;
  skateQuality: Doc<'reports'>['skateQuality'];
  iceTypes: Doc<'reports'>['iceTypes'];
  /** `report_corroborated` ledger rows keyed to this report — its community backing (D50). */
  corroborations: number;
  conflicting: boolean;
  contradiction: boolean;
}

/**
 * Load the settle cluster around a report: the quality-bearing visible reports within **twice** the
 * `CORROBORATION_WINDOW` of it, each with its live corroboration count, plus the body's sample point (the
 * same point the decay uses, §5). Only quality-bearing reports can contradict (`reportsContradict` needs a
 * quality on both sides). Null when the report/body is gone.
 *
 * **Why 2×window.** `settleContradictions` only *reconciles* reports within ±`CORROBORATION_WINDOW` of the
 * anchor (the set whose status this new report can change), but to judge each of those correctly it needs
 * that report's OWN ±window neighborhood — which reaches up to 2×window from the anchor. Loading the wider
 * band makes each reconciled report's verdict a pure function of its true neighborhood, so escalation is
 * order-independent and a valid contradiction can't be spuriously cleared by an unrelated later report
 * whose narrow window happens to exclude the corroborated opponent (the §7b consensus guarantee).
 */
export const contradictionCluster = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const anchor = await ctx.db.get(reportId);
    if (!anchor) return null;

    const lower = anchor.skateEndTime - 2 * CORROBORATION_WINDOW_MS;
    const upper = anchor.skateEndTime + 2 * CORROBORATION_WINDOW_MS;
    const inWindow = await ctx.db
      .query('reports')
      .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
        q
          .eq('waterBodyId', anchor.waterBodyId)
          .eq('moderationStatus', 'visible')
          .gte('skateEndTime', lower)
          .lte('skateEndTime', upper),
      )
      .collect();

    const reports: ClusterReport[] = [];
    for (const r of inWindow) {
      if (r.skateQuality === undefined) continue;
      const events = await ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', r._id))
        .collect();
      reports.push({
        id: r._id,
        authorId: r.authorId,
        skateEndTime: r.skateEndTime,
        skateQuality: r.skateQuality,
        iceTypes: r.iceTypes,
        corroborations: events.filter((e) => e.reason === 'report_corroborated').length,
        conflicting: r.conflicting ?? false,
        contradiction: r.contradiction ?? false,
      });
    }

    const body = await ctx.db.get(anchor.waterBodyId);
    if (!body) return null;
    const point = nearestSamplePoint(body, anchor.point);
    return { lat: point.lat, lng: point.lng, anchorSkateEndTime: anchor.skateEndTime, reports };
  },
});

/** Dedup: one open contradiction flag per author at a time (mirrors ratings.ts `maybeAutoFlag`). */
async function flagContradictionPattern(
  ctx: MutationCtx,
  authorId: Id<'profiles'>,
  flaggerId: Id<'profiles'>,
): Promise<void> {
  const existing = await ctx.db
    .query('contentFlags')
    .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', authorId))
    .filter((q) => q.eq(q.field('reason'), 'unsafe_false_report'))
    .filter((q) => q.eq(q.field('status'), 'open'))
    .first();
  if (existing) return;
  await ctx.db.insert('contentFlags', {
    flaggerId, // a corroborated opponent — the action that crossed the line; `note` marks it system-generated
    targetType: 'user',
    targetId: authorId,
    reason: 'unsafe_false_report',
    note: 'Auto: repeated weather-unexplained contradictions against corroborated reports (D56 §7). Review the good-vs-bad trend.',
    status: 'open',
    createdAt: Date.now(),
  });
}

/** The settled per-report verdict the action hands the mutation to apply. */
const settledReport = v.object({
  id: v.id('reports'),
  conflicting: v.boolean(),
  contradiction: v.boolean(),
  /** A corroborated opponent, for the flag's `flaggerId` — present only when `contradiction` is true. */
  flaggerId: v.optional(v.id('profiles')),
});

/**
 * Apply a settled cluster: reconcile each report's `conflicting` (symmetric disclosure) + `contradiction`
 * (private escalation) to the freshly computed values, moving the author's non-scoring `contradictionCount`
 * as the escalation flag flips (self-correcting — a cleared flag decrements). Files a moderator flag when an
 * author's count crosses the threshold. **Never touches reputation points** (D50 boost-only).
 */
export const applyContradictionSettlement = internalMutation({
  args: { reports: v.array(settledReport) },
  handler: async (ctx, { reports }) => {
    for (const entry of reports) {
      const report = await ctx.db.get(entry.id);
      if (!report) continue;

      if ((report.conflicting ?? false) !== entry.conflicting) {
        await ctx.db.patch(entry.id, { conflicting: entry.conflicting });
      }

      const was = report.contradiction ?? false;
      if (was === entry.contradiction) continue;
      await ctx.db.patch(entry.id, { contradiction: entry.contradiction });

      const author = await ctx.db.get(report.authorId);
      if (!author) continue;
      const delta = entry.contradiction ? 1 : -1;
      const count = Math.max(0, (author.contradictionCount ?? 0) + delta);
      await ctx.db.patch(report.authorId, { contradictionCount: count });

      if (entry.contradiction && entry.flaggerId && count >= CONTRADICTION_FLAG_THRESHOLD) {
        await flagContradictionPattern(ctx, report.authorId, entry.flaggerId);
      }
    }
  },
});

/**
 * Settle the contradiction state of a report's cluster (scheduled from `reports.create`). For each
 * weather-unexplained disagreeing pair it discloses the conflict on both, and escalates the strictly-less-
 * corroborated side **only when that side has zero corroboration** — so a genuinely unsettled disagreement
 * (both un-corroborated) discloses but escalates no one, and the corroborated majority is never escalated.
 *
 * **Consensus, not order.** Only reports within ±`CORROBORATION_WINDOW` of the anchor (the *reconcile band*)
 * can have their status changed by this new report, so only they are patched; the outer band is loaded
 * purely as context (a band report's neighbors). Each pair is judged on the same-window rule
 * `|a − b| ≤ CORROBORATION_WINDOW` (what `runCorroboration` uses). Because every reconciled report's full
 * neighborhood is loaded (§ `contradictionCluster`), its verdict is identical no matter which report
 * triggered the settle — a bad actor can't post a throwaway report just outside a flagged report's window
 * to clear it.
 */
export const settleContradictions = internalAction({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const cluster = await ctx.runQuery(internal.contradictions.contradictionCluster, { reportId });
    if (!cluster || cluster.reports.length < 2) return;
    const { lat, lng, anchorSkateEndTime, reports } = cluster;

    // The reconcile band: reports whose contradiction status the anchor's creation can actually change.
    const bandLo = anchorSkateEndTime - CORROBORATION_WINDOW_MS;
    const bandHi = anchorSkateEndTime + CORROBORATION_WINDOW_MS;
    const inBand = (r: (typeof reports)[number]) =>
      r.skateEndTime >= bandLo && r.skateEndTime <= bandHi;

    const conflicting = new Set<Id<'reports'>>();
    const contradiction = new Set<Id<'reports'>>();
    const flaggerFor = new Map<Id<'reports'>, Id<'profiles'>>();

    for (let i = 0; i < reports.length; i++) {
      for (let j = i + 1; j < reports.length; j++) {
        const a = reports[i];
        const b = reports[j];
        if (!a || !b) continue;
        if (a.authorId === b.authorId) continue; // a reporter can't contradict themselves
        // Two reports only bear on each other within a corroboration window of EACH OTHER (same rule as
        // `runCorroboration`); and skip any pair with no band member — its result is never patched.
        if (Math.abs(a.skateEndTime - b.skateEndTime) > CORROBORATION_WINDOW_MS) continue;
        if (!inBand(a) && !inBand(b)) continue;
        if (!reportsContradict(a, b)) continue;

        const lo = Math.min(a.skateEndTime, b.skateEndTime);
        const hi = Math.max(a.skateEndTime, b.skateEndTime);
        // Weather can't plausibly change the ice in under an hour, so two disagreeing reports that close in
        // time are a real contradiction — NOT a "can't tell" to fail open on. Skip the fetch and treat the
        // change as weather-unexplained. (A sub-hour window also can't be summarized: `resolveWeatherSince`
        // returns the empty summary for it, which the old `hours === 0` guard silently swallowed.)
        if (hi - lo >= WEATHER_MIN_EXPLAIN_WINDOW_MS) {
          const summary = await resolveWeatherSince(ctx, lat, lng, lo, hi);
          if (summary === null) continue; // fetch FAILED ⇒ can't confirm ⇒ fail open, don't record
          if (summary.hours > 0 && weatherExplainsIceChange(summary)) continue; // honest "ice changed"
        }

        conflicting.add(a.id);
        conflicting.add(b.id);
        // Escalate the un-corroborated minority against a corroborated opponent (order-independent). A tie
        // — notably both at zero — escalates neither: the disagreement isn't settled yet.
        if (a.corroborations === 0 && b.corroborations > a.corroborations) {
          contradiction.add(a.id);
          if (!flaggerFor.has(a.id)) flaggerFor.set(a.id, b.authorId);
        }
        if (b.corroborations === 0 && a.corroborations > b.corroborations) {
          contradiction.add(b.id);
          if (!flaggerFor.has(b.id)) flaggerFor.set(b.id, a.authorId);
        }
      }
    }

    // Reconcile ONLY the reconcile-band reports (clearing stale flags on any no longer in a minority
    // contradiction, so the counter self-corrects as corroboration accrues). Context reports in the outer
    // band are owned by their own settle — patching them here from a partial neighborhood is the bug we fixed.
    await ctx.runMutation(internal.contradictions.applyContradictionSettlement, {
      reports: reports.filter(inBand).map((r) => ({
        id: r.id,
        conflicting: conflicting.has(r.id),
        contradiction: contradiction.has(r.id),
        ...(flaggerFor.has(r.id) ? { flaggerId: flaggerFor.get(r.id) } : {}),
      })),
    });
  },
});
