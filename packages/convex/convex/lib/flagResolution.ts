import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { bumpMetricMetaCounter } from './metrics';
import { enqueueActorNotification } from './notificationQueue';

export type FlagResolution = 'actioned' | 'dismissed';

/**
 * Close one open content flag — the status patch, the tuning metric, and the word to whoever filed
 * it — in one place, so every path that resolves a flag does all three.
 *
 * **Why a helper and not just `moderation.resolveFlag`.** A flag is resolved from two places: the
 * queue, one at a time with a reason, and `waterBodies.setPublicAccess`, which closes every open
 * `no_public_access` report on a lake as a side effect of ruling on the lake (A06f). The second path
 * predates both the Phase 07-2 `flag_dispositions` counter and the A08 `content_flag_resolved`
 * notification, and it patched the rows directly — so a reporter the drawer had told *"it's with the
 * moderators"* never heard the verdict, and the control-room chart read zero upheld and zero
 * dismissed for that reason forever. The A06d shape again: a new surface added to a system that
 * enumerates its inputs, failing silently.
 *
 * **What stays with the caller: the audit row.** The queue writes one `resolve_flag` /
 * `dismiss_flag` row per flag because each is a decision with its own reason; a ruling writes one
 * `set_public_access` row naming how many reports it closed, because the decision was about the
 * lake and the reports are its consequence. Two shapes, both right, so neither is forced here.
 *
 * **Not idempotent — the caller guards the terminal state.** `resolveFlag` throws on an already-
 * resolved flag so a stale queue view can't double-count the metric; `setPublicAccess` only ever
 * reads `status === 'open'` rows off the index. Either way, a row reaches here exactly once.
 */
export async function closeFlag(
  ctx: MutationCtx,
  flag: Doc<'contentFlags'>,
  resolution: FlagResolution,
  actorId: Id<'profiles'>,
  now: number,
): Promise<void> {
  await ctx.db.patch(flag._id, {
    status: resolution,
    resolvedByUserId: actorId,
    resolvedAt: now,
  });

  // The enforcement funnel's last stage (Phase 07-2): upheld vs dismissed, **keyed by flag reason**.
  // The reason is what makes it a tuning signal rather than a workload stat — mostly-dismissed
  // `auto_low_quality` says AUTO_LOW_QUALITY_NET_UNHELPFUL is too low, and mostly-dismissed
  // `unsafe_false_report` says CONTRADICTION_FLAG_THRESHOLD is. Counted on write because the
  // dispositions of *today's* resolutions can't be reconstructed from a queue that only holds
  // what's still open.
  await bumpMetricMetaCounter(ctx, 'flag_dispositions', `${flag.reason}:${resolution}`, 1, now);

  // `content_flag_resolved` (A08/B3): tell the person who filed it that a moderator ruled. Verdict
  // only — not what was done, not to whom, not by which moderator. **`origin === 'user'` only**:
  // an auto-filed flag names a real person in `flaggerId` who never filed anything (the rater whose
  // thumb crossed a threshold), and telling them "the report you filed was actioned" would both
  // confuse them and disclose that their thumb produced a moderation flag. Absent origin (rows from
  // before the field) reads as auto — silence is the fail-quiet direction. Through the settle queue
  // (D169); there's no undo for a resolution, but one path in is the point. No `actorId`: the
  // moderator is deliberately not the actor (a block between flagger and moderator must not
  // swallow a verdict), so the self gate is spelled out here — a moderator ruling on their own
  // flag already knows.
  if (flag.origin === 'user' && flag.flaggerId !== actorId) {
    await enqueueActorNotification(ctx, {
      recipientId: flag.flaggerId,
      targetId: flag._id,
      trigger: { kind: 'flag_resolved', flagId: flag._id, resolution },
      now,
    });
  }
}
