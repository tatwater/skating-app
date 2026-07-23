/**
 * Corroboration **contradiction signal** (Phase 10 / D56 §7b) — the inverse seam of `runCorroboration`.
 * When a later report strongly disagrees with a prior one on the same body AND the weather-since between
 * them doesn't explain the change, it's a contradiction. This does **three** things, none of which
 * subtracts trust (D50 stays boost-only; honest "the ice changed" reports are never punished — D3):
 *   1. **Withhold** the corroboration boost — already the default (only agreement awards).
 *   2. **Disclose** the conflict — both reports get a soft `conflicting` flag skaters can see.
 *   3. **Escalate on pattern** — bump the author's private, non-scoring `contradictionCount`; once it
 *      crosses `CONTRADICTION_FLAG_THRESHOLD`, auto-file a moderator flag (the D57 posting-permission
 *      lever is the human's response, not a point penalty).
 *
 * A mutation can't fetch, so `reports.create` schedules `evaluateContradictions` post-insert (the
 * isochrones/conditions pattern). Fail-open: no weather data ⇒ we can't confirm the contradiction, so we
 * don't record one.
 */

import {
  CONTRADICTION_FLAG_THRESHOLD,
  CORROBORATION_WINDOW_MS,
  reportsContradict,
  weatherExplainsIceChange,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import { nearestSamplePoint } from './hazardWeather';
import { resolveWeatherSince } from './weather';

/**
 * Prior reports on the same body that **strongly disagree** with the new one (candidates only — the caller
 * still confirms the weather doesn't explain the change). Null when the report is gone, carries no
 * `skateQuality`, or has no contradicting priors. Resolves the body's nearest sample point for the fetch.
 */
export const findContradictingPriors = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId);
    if (!report || report.skateQuality === undefined) return null; // no quality ⇒ nothing to contradict

    const lower = report.skateEndTime - CORROBORATION_WINDOW_MS;
    const candidates = await ctx.db
      .query('reports')
      .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
        q
          .eq('waterBodyId', report.waterBodyId)
          .eq('moderationStatus', 'visible')
          .gte('skateEndTime', lower)
          .lte('skateEndTime', report.skateEndTime),
      )
      .collect();

    const priors: { id: Id<'reports'>; skateEndTime: number; authorId: Id<'profiles'> }[] = [];
    for (const prior of candidates) {
      if (prior._id === report._id) continue;
      if (prior.authorId === report.authorId) continue; // a reporter can't contradict themselves
      if (prior.skateEndTime >= report.skateEndTime) continue; // priors are strictly earlier
      if (!reportsContradict(report, prior)) continue;
      priors.push({ id: prior._id, skateEndTime: prior.skateEndTime, authorId: prior.authorId });
    }
    if (priors.length === 0) return null;

    const body = await ctx.db.get(report.waterBodyId);
    if (!body) return null;
    const point = nearestSamplePoint(body, report.point);
    return {
      skateEndTime: report.skateEndTime,
      authorId: report.authorId,
      lat: point.lat,
      lng: point.lng,
      priors,
    };
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
    flaggerId, // a contradicted reporter, the action that crossed the line; `note` marks it system-generated
    targetType: 'user',
    targetId: authorId,
    reason: 'unsafe_false_report',
    note: 'Auto: repeated weather-unexplained contradictions (D56 §7). Review the good-vs-bad trend.',
    status: 'open',
    createdAt: Date.now(),
  });
}

/**
 * Record confirmed (weather-unexplained) contradictions: flag both sides `conflicting`, bump the author's
 * non-scoring `contradictionCount`, and escalate on pattern. Never touches reputation points (D50).
 */
export const recordContradictions = internalMutation({
  args: {
    newReportId: v.id('reports'),
    priorReportIds: v.array(v.id('reports')),
    authorId: v.id('profiles'),
    triggerFlaggerId: v.id('profiles'),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.newReportId, { conflicting: true });
    for (const pid of a.priorReportIds) {
      const prior = await ctx.db.get(pid);
      if (prior) await ctx.db.patch(pid, { conflicting: true });
    }

    const author = await ctx.db.get(a.authorId);
    if (!author) return;
    const count = (author.contradictionCount ?? 0) + 1; // one event per report, not per contradicted prior
    await ctx.db.patch(a.authorId, { contradictionCount: count });
    if (count >= CONTRADICTION_FLAG_THRESHOLD) {
      await flagContradictionPattern(ctx, a.authorId, a.triggerFlaggerId);
    }
  },
});

/** Evaluate a new report against its disagreeing priors, keeping only weather-unexplained contradictions. */
export const evaluateContradictions = internalAction({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const info = await ctx.runQuery(internal.contradictions.findContradictingPriors, { reportId });
    if (!info) return;

    const unexplained: Id<'reports'>[] = [];
    let triggerFlaggerId: Id<'profiles'> | null = null;
    for (const prior of info.priors) {
      const summary = await resolveWeatherSince(
        ctx,
        info.lat,
        info.lng,
        prior.skateEndTime,
        info.skateEndTime,
      );
      if (summary.hours === 0) continue; // no data ⇒ can't confirm ⇒ fail open (no contradiction)
      if (weatherExplainsIceChange(summary)) continue; // honest "the ice changed" — not a contradiction
      unexplained.push(prior.id);
      if (triggerFlaggerId === null) triggerFlaggerId = prior.authorId;
    }
    if (unexplained.length === 0 || triggerFlaggerId === null) return;

    await ctx.runMutation(internal.contradictions.recordContradictions, {
      newReportId: reportId,
      priorReportIds: unexplained,
      authorId: info.authorId,
      triggerFlaggerId,
    });
  },
});
