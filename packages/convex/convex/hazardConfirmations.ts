/**
 * Hazard confirmations — the three-tier "is it still there?" vote (D52/D54, Phase 9).
 *
 * This is where the lifecycle actually turns, and the asymmetry baked into it is the whole point:
 *
 *   still_there    → resets the decay clock, counts toward confirmation (1 → promotes to a real alert)
 *   healing_unsafe → annotates the pin and KEEPS it up, counts toward nothing
 *   fully_healed   → the only verdict that moves toward removal (2 → archives, never deletes)
 *
 * Confirming is *harder* to use destructively than constructively on purpose. A wrong "still here"
 * costs someone a detour; a wrong "all clear" can kill someone (D3). The author's own vote refreshes
 * the clock but counts toward neither threshold, so one person can't both plant a pin and promote it
 * into a warning for everyone else on that ice (D54).
 *
 * All the actual state math lives in `@skating/core`'s `deriveHazardLifecycle`, property-tested there —
 * this module upserts the skater's one vote row and asks core to recompute the hazard from the full
 * vote set. It is the persistence and gating shell around that.
 */

import {
  DEFAULT_REMOVAL_THRESHOLD,
  deriveHazardLifecycle,
  HAZARD_CORROBORATION_MIN_CONFIRMS,
  type HazardVoteRecord,
  isMinor,
  isPassageMarker,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { loadVisibleHazard } from './hazards';
import { fileOrBumpAutoFlag } from './lib/autoFlag';
import { requireContributor } from './lib/auth';
import { HAZARD_CONFIRM_VERDICTS, HAZARD_CONFIRM_VIA } from './lib/enums';
import { awardPointEvent, checkAndAwardBadges } from './lib/reputation';
import { latLng, literals } from './lib/validators';

/**
 * Re-confirming within this window refreshes the skater's existing vote in place rather than logging a
 * fresh audit row every time — a skater doing laps shouldn't spray rows. Note it is NOT a correctness
 * gate: counts are derived from *distinct users' latest votes* (`deriveHazardLifecycle`), so a stored
 * count is right regardless of the window. The window only governs row/audit granularity. Tunable in
 * Phase 7.
 */
export const CONFIRM_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Cast a confirmation. Upserts this skater's single vote for the hazard, then recomputes the hazard's
 * lifecycle from the whole vote set via `@skating/core` and patches it.
 *
 * **One vote row per user per hazard** is the invariant that makes this safe *and* idempotent: a queued
 * confirmation that replays on flush updates the same row and re-derives the same counts, so a lost ack
 * can never double-count toward archival (the offline-path twin of the same-account abuse the
 * distinct-user derivation prevents).
 */
export const confirm = mutation({
  args: {
    hazardId: v.id('hazards'),
    verdict: literals(HAZARD_CONFIRM_VERDICTS),
    atCoord: v.optional(latLng),
    via: literals(HAZARD_CONFIRM_VIA),
    /**
     * When the skater actually observed it (epoch ms). Passed in rather than read from the clock so an
     * offline confirmation flushed hours later still stamps the moment they stood there. Clamped to
     * "not in the future" below.
     */
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, { hazardId, verdict, atCoord, via, observedAt }) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    // TODO(16+): fold into the uniform 16+ pass with legal (D41). A confirmation is public safety
    // content that moves a hazard's lifecycle, so minors are read-only here too.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot confirm hazards');
    }

    const hazard = await loadVisibleHazard(ctx, hazardId);
    if (!hazard) throw new ConvexError('Hazard not found');

    // A future timestamp (device clock skew, or a client trying to freeze a pin as permanently fresh)
    // is clamped rather than trusted.
    const at = Math.min(observedAt ?? now, now);

    const existing = await findUserVote(ctx, hazardId, profile._id);
    let firstContribution: boolean;
    if (existing) {
      // This skater already has a vote on this hazard: refresh it. `createdAt` stays monotonic so a
      // late-arriving offline replay can't drag their observation time backward.
      await ctx.db.patch(existing._id, {
        verdict,
        ...(atCoord ? { atCoord } : {}),
        via,
        createdAt: Math.max(existing.createdAt, at),
      });
      firstContribution = false;
    } else {
      await ctx.db.insert('hazardConfirmations', {
        hazardId,
        userId: profile._id,
        verdict,
        ...(atCoord ? { atCoord } : {}),
        via,
        createdAt: at,
      });
      firstContribution = true;
    }

    const votes = await recomputeLifecycle(ctx, hazard);
    await maybeFlagNeverExisted(ctx, hazard, votes, profile._id);

    // Boost-only reputation (D50). Awarded once per user per hazard — on their first vote, not on every
    // re-confirm — so laps, verdict changes, and offline replays can't farm points. Now routed through
    // `awardPointEvent` so it finally bumps the confirmer's `reputationPoints` (the Phase-6 retrofit),
    // then recomputes their badges (a confirmation feeds the `Watchdog` count).
    if (firstContribution) {
      await awardPointEvent(ctx, {
        userId: profile._id,
        reason: 'hazard_confirmed',
        refId: hazardId,
      });
      await checkAndAwardBadges(ctx, profile._id);
    }

    // Author-side corroboration (D50, new): once ≥2 **peers** have confirmed (the author's own votes are
    // excluded from `confirmCount`, D54), the hazard's author earns `hazard_corroborated` — once per
    // hazard. Independent of who is confirming, so it fires even when the confirmer isn't the author.
    await maybeAwardHazardCorroboration(ctx, hazardId);
  },
});

/**
 * Award the hazard's author `hazard_corroborated` the first time its peer `confirmCount` reaches the
 * threshold (D50). Idempotent per hazard: a prior `hazard_corroborated` ledger row for this author+hazard
 * short-circuits, so a 3rd/4th confirm (or an offline replay) never re-awards. Recomputes the author's
 * badges on award (the confirm count can push `Hazard Spotter` over its line when thumbs are also present).
 */
async function maybeAwardHazardCorroboration(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
): Promise<void> {
  const hazard = await ctx.db.get(hazardId);
  if (!hazard || hazard.confirmCount < HAZARD_CORROBORATION_MIN_CONFIRMS) return;
  const already = await ctx.db
    .query('pointEvents')
    .withIndex('by_user', (q) => q.eq('userId', hazard.createdByUserId))
    .filter((q) => q.eq(q.field('reason'), 'hazard_corroborated'))
    .filter((q) => q.eq(q.field('refId'), hazardId))
    .first();
  if (already) return;
  await awardPointEvent(ctx, {
    userId: hazard.createdByUserId,
    reason: 'hazard_corroborated',
    refId: hazardId,
  });
  await checkAndAwardBadges(ctx, hazard.createdByUserId);
}

/**
 * This user's current vote on a hazard, if any. `confirm` keeps one row per (user, hazard), so there is
 * normally at most one — but we `collect()` and take the latest rather than `.unique()` on purpose:
 * `.unique()` *throws* if a stray duplicate ever exists (a pre-invariant row, a backfill), which would
 * brick `confirm` for that hazard entirely. Tolerating duplicates keeps the mutation robust; the count
 * derivation already collapses multiple rows per user to their latest, so the counts stay correct.
 */
async function findUserVote(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
  userId: Id<'profiles'>,
): Promise<Doc<'hazardConfirmations'> | null> {
  const rows = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard_and_user', (q) => q.eq('hazardId', hazardId).eq('userId', userId))
    .collect();
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.createdAt >= latest.createdAt ? row : latest));
}

/** Re-derive the hazard's lifecycle from every vote and patch the stored counts/status. */
async function recomputeLifecycle(
  ctx: MutationCtx,
  hazard: Doc<'hazards'>,
): Promise<HazardVoteRecord[]> {
  const votes = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard', (q) => q.eq('hazardId', hazard._id))
    .collect();
  const records: HazardVoteRecord[] = votes.map((v) => ({
    userId: v.userId,
    verdict: v.verdict,
    at: v.createdAt,
  }));
  const next = deriveHazardLifecycle(records, {
    authorId: hazard.createdByUserId,
    createdAt: hazard.firstReportedAt,
    priorStatus: hazard.status,
    // Only a passage marker can reach `disputed` (D64) — the type is what decides whether a
    // below-threshold "gone" vote is conservative disclosure or an invitation to ignore a warning.
    isPassage: isPassageMarker(hazard.type),
  });

  // A confirmation that advances the decay clock (`lastConfirmedAt`) invalidates the stored weather
  // multiplier (Phase 10 / D56): the decay cron computed `decayMultiplier`/`snowHidden` over the *old*
  // "since last confirmed" window, so applying them to the new epoch would show the wrong freshness
  // bucket until the next cron pass (up to ~3h). Clear them and the refresh stamp — the read path then
  // fails open to plain base decay (which a just-confirmed pin reads as fresh anyway, never *less*
  // visible), and dropping `weatherAdjustedAt` lets the cron recompute against the new window on its
  // very next tick (its cadence gate no longer defers this hazard). A vote that leaves `lastConfirmedAt`
  // unchanged (e.g. `fully_healed`) keeps the still-valid multiplier — its window is unchanged.
  const clockAdvanced = next.lastConfirmedAt !== hazard.lastConfirmedAt;
  const hasStoredWeather =
    hazard.decayMultiplier !== undefined ||
    hazard.snowHidden !== undefined ||
    hazard.weatherAdjustedAt !== undefined;
  await ctx.db.patch(hazard._id, {
    ...next,
    ...(clockAdvanced && hasStoredWeather
      ? { decayMultiplier: undefined, snowHidden: undefined, weatherAdjustedAt: undefined }
      : {}),
  });
  return records;
}

/**
 * Tell a moderator when the community says a pin was never real (D65).
 *
 * `never_existed` archives on the same two votes as `fully_healed` — they agree about the present, and
 * the map shows the present — but only this one is a claim about the **report**. "It healed" is the ice
 * changing, which is what the app is for; "there was never anything here" means a pin was in the wrong
 * place, or somebody made it up. Archiving that quietly would let a pattern of fabricated hazards
 * disappear one archive at a time, which is exactly the pattern worth seeing.
 *
 * `unsafe_false_report` is the existing reason for it, and the flag never hides anything by itself —
 * moderation and lifecycle stay separate axes (D3), so the archive is the community's decision and the
 * flag is a moderator's to judge.
 *
 * **State-shaped, so `countsAsOccurrence: false`.** This runs on every vote, and the same two people
 * changing their minds back and forth must not inflate the occurrence count a moderator reads.
 */
async function maybeFlagNeverExisted(
  ctx: MutationCtx,
  hazard: Doc<'hazards'>,
  votes: readonly HazardVoteRecord[],
  reporterId: Id<'profiles'>,
): Promise<void> {
  // Distinct non-author users whose *current* verdict is `never_existed` — the same one-skater-one-
  // opinion rule the counts are derived under, so two votes from one account can't reach the line.
  const latest = new Map<string, HazardVoteRecord>();
  for (const vote of votes) {
    const prior = latest.get(vote.userId);
    if (!prior || vote.at >= prior.at) latest.set(vote.userId, vote);
  }
  let neverCount = 0;
  for (const vote of latest.values()) {
    if (vote.userId === hazard.createdByUserId) continue;
    if (vote.verdict === 'never_existed') neverCount += 1;
  }
  if (neverCount < DEFAULT_REMOVAL_THRESHOLD) return;

  await fileOrBumpAutoFlag(ctx, {
    targetType: 'hazard',
    targetId: hazard._id,
    reason: 'unsafe_false_report',
    flaggerId: reporterId,
    note: `${neverCount} skaters reported that nothing was ever at this pin.`,
    countsAsOccurrence: false,
  });
}

/**
 * The confirmation history for a hazard's detail drawer — newest first, **with names** (D65).
 *
 * A confirmation from someone whose history you can look at carries weight a bare count doesn't; that
 * is the whole argument for D50's boost-only trust. But a confirmation is a sharper disclosure than a
 * report: it says a named person stood at a *point* at a *time*, where a report is lake-level.
 *
 * So the name follows the consent the skater already gave. `profileVisibility: 'public'` means
 * searchable and browsable, and those confirmers are named; a private profile is **counted and not
 * named**. Reusing that flag beats inventing a per-confirmation consent, and minors are forced private
 * (D41), so they are never named by construction.
 *
 * A blocked author's name is *not* specially suppressed here: blocks hide profiles and comments, never
 * safety content (D3), and a confirmation is safety content. The count is what the pin is judged on
 * either way.
 */
export const listForHazard = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }) => {
    const hazard = await loadVisibleHazard(ctx, hazardId);
    if (!hazard) return [];
    const votes = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_hazard', (q) => q.eq('hazardId', hazardId))
      .collect();
    // One profile read per distinct confirmer, cached — a hazard the community is actively
    // maintaining is exactly the one with the most votes, so this must not be a read per *vote*.
    const names = new Map<Id<'profiles'>, string | undefined>();
    const named = await Promise.all(
      votes
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (vote) => {
          if (!names.has(vote.userId)) {
            const profile = await ctx.db.get(vote.userId);
            names.set(
              vote.userId,
              profile && profile.profileVisibility === 'public' ? profile.displayName : undefined,
            );
          }
          const displayName = names.get(vote.userId);
          return { ...vote, ...(displayName !== undefined ? { displayName } : {}) };
        }),
    );
    return named;
  },
});
