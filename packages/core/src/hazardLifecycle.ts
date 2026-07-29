/**
 * Hazard lifecycle — pure reducers over the three-tier confirmation vote (D52).
 *
 * The whole point of the three-tier verdict is that "gone" is not one thing. A refrozen lead *is* thin
 * ice; a healed pressure ridge *is* a line of refrozen blocks ("ice sharks") you can still catch an
 * edge on. So the middle verdict exists to let a skater say "it's changed, and it's still dangerous"
 * without that being counted as a clearance:
 *
 *   still_there    → resets the decay clock, counts toward confirmation
 *   healing_unsafe → annotates the pin, KEEPS it on the map, counts toward NOTHING
 *   fully_healed   → the ONLY verdict that moves a hazard toward removal
 *
 * Removal archives (never hard-deletes) so a hazard can resurface on re-report (D15).
 *
 * Kept pure and platform-free so the identical logic runs in Convex mutations, the web client and the
 * mobile offline queue — one implementation, one set of property tests (D40).
 */

/**
 * The confirmation vote. Three tiers of "is it still there" (D52), plus a fourth that answers a
 * different question entirely (D65).
 *
 * `never_existed` is not a fourth degree of gone. `fully_healed` says *the ice changed*; this says
 * *the report was wrong* — a mis-tapped location, a shadow read as a lead, or a troll. Without it, the
 * only way to clear a bogus pin was to record that it "healed", which writes a false entry into the ice
 * record and, once N5a's recurrence detection reads across seasons, becomes evidence that a hazard
 * formed somewhere it never did.
 */
export type HazardVerdict = 'still_there' | 'healing_unsafe' | 'fully_healed' | 'never_existed';

/**
 * The annotation on a pin, derived from the votes.
 *
 * `disputed` is **passage markers only** (D64). One skater saying "you can't cross here" is currently
 * invisible — `goneCount` goes to 1, `status` stays `active`, nothing renders — so the first person to
 * find a closed crossing changes nothing on screen for the next. On a *hazard* the same signal would
 * invite skaters to discount a live warning, which is the unsafe direction; on a passage marker it is
 * the conservative one, and it keeps both facts the skater needs: a crossing was reported here, and
 * somebody disagrees.
 */
export type HazardHealingState = 'none' | 'healing_unsafe' | 'disputed';

/** Lifecycle status. Separate from moderation status — see the note on `HazardLifecycleState`. */
export type HazardStatus = 'active' | 'archived';

/**
 * The mutable lifecycle fields of a hazard.
 *
 * Note what is *not* here: `moderationStatus`. Moderation and lifecycle are deliberately separate axes
 * (2026-07-21). Archiving a troll pin instead of hiding it would make abuse indistinguishable from the
 * community clearing a real hazard — a moderator action must never read as a safety verdict (D3).
 */
export interface HazardLifecycleState {
  lastConfirmedAt: number;
  confirmCount: number;
  goneCount: number;
  healingState: HazardHealingState;
  status: HazardStatus;
}

/**
 * How many independent `still_there` confirmations promote a hazard from *provisional* to *confirmed*.
 * Tunable, admin-editable in Phase 7 (D49); no reputation weighting yet (D50/D54).
 */
export const DEFAULT_CONFIRM_THRESHOLD = 1;

/**
 * How many independent confirmations a **suggested crossing** needs before it stops reading as one
 * skater's suggestion (D64) — double the bar above, which is what "more corroboration" means.
 *
 * Any `still_there` vote still resets the clock, so one person *can* keep a crossing alive; two are
 * needed before the marker is corroborated. The asymmetry is the same one as the expiry: this is the
 * only pin in the app that says *you can go this way*.
 */
export const PASSAGE_CONFIRM_THRESHOLD = 2;

/** The confirm bar for a type: passage markers need two, everything else one. */
export function confirmThresholdFor(isPassage: boolean): number {
  return isPassage ? PASSAGE_CONFIRM_THRESHOLD : DEFAULT_CONFIRM_THRESHOLD;
}

/**
 * How many independent `fully_healed` verdicts archive a hazard. Higher than the confirm threshold on
 * purpose: the asymmetry is the safety margin. Believing a hazard is present when it isn't costs a
 * detour; believing it's gone when it isn't can kill someone (D3).
 */
export const DEFAULT_REMOVAL_THRESHOLD = 2;

export interface ApplyConfirmationOptions {
  /** Confirmations by the hazard's own author don't count toward either threshold (D54). */
  isAuthor?: boolean;
  removalThreshold?: number;
  /**
   * Is this a passage marker (`ridge_crossing`)? Mirrors the same option on
   * {@link DeriveHazardLifecycleOptions}, and for the same reason: only a passage marker can reach
   * `disputed` (D64). Without it the offline optimistic state disagrees with what the server derives
   * for the *one* verdict a crossing most needs shown — a skater casts "ridge closed here", sees
   * nothing change, and only finds out it registered after the next sync.
   */
  isPassage?: boolean;
}

/**
 * Apply one confirmation to a hazard's lifecycle state. Pure: returns the next state, mutates nothing.
 *
 * `at` (epoch ms) is the confirmation time — passed in rather than read from the clock so this stays
 * deterministic and testable, and so an offline confirmation flushed hours later still stamps the
 * moment the skater actually stood there.
 *
 * ⚠ **This is the incremental single-vote model, and it is NOT how the counts are maintained in
 * storage.** Counts persisted on a hazard are *derived* from the whole vote set by
 * `deriveHazardLifecycle` — see the note there for why. This function survives only as the
 * property-tested statement of what a single verdict *means* (and its monotonic-clock rule); it is
 * **not** what `deriveHazardLifecycle` calls — that computes the counts with its own distinct-user
 * loop. A server must never call this to bump a stored counter: incrementing per vote row can't see
 * that two rows came from the same account, which is exactly the D3 hole derivation closes.
 */
export function applyConfirmation(
  state: HazardLifecycleState,
  verdict: HazardVerdict,
  at: number,
  options: ApplyConfirmationOptions = {},
): HazardLifecycleState {
  const {
    isAuthor = false,
    removalThreshold = DEFAULT_REMOVAL_THRESHOLD,
    isPassage = false,
  } = options;
  /**
   * `disputed` on a passage marker outranks whatever this vote would otherwise have annotated (D64) —
   * the same precedence `deriveHazardLifecycle` applies, restated here rather than shared because the
   * two functions maintain their counts differently and a shared helper would imply they don't.
   */
  const annotate = (goneCount: number, otherwise: HazardHealingState): HazardHealingState =>
    isPassage && goneCount >= 1 && goneCount < removalThreshold ? 'disputed' : otherwise;
  // The author vouching for their own report is not independent evidence (D54). It still refreshes the
  // decay clock — they were genuinely there and looked — it just can't promote or remove the pin.
  const counts = !isAuthor;
  // Adding an observation must never make a hazard look *less* observed. A "still here" cast at 06:00
  // that flushes at 10:05 — after an online confirm already refreshed the clock to 10:00 — must not
  // drag `lastConfirmedAt` backward and fade a pin that was verified minutes ago. Monotonic by force.
  const lastConfirmedAt = Math.max(state.lastConfirmedAt, at);

  switch (verdict) {
    case 'still_there':
      return {
        ...state,
        lastConfirmedAt,
        confirmCount: state.confirmCount + (counts ? 1 : 0),
        // Seeing it still there supersedes an earlier "healing" note — but not a standing dispute on
        // a crossing: one skater finding the ridge closed and another getting across is exactly the
        // disagreement `disputed` exists to show, and the newer vote doesn't erase the older one.
        healingState: annotate(state.goneCount, 'none'),
      };

    case 'healing_unsafe':
      return {
        ...state,
        // Someone looked at it, so the observation is fresh — but "healing" is not a clearance, so it
        // moves neither counter. The pin stays, now annotated, because a healing spot is exactly the
        // thing a future skater needs to be able to read.
        lastConfirmedAt,
        healingState: annotate(state.goneCount, 'healing_unsafe'),
      };

    // Both verdicts assert the same thing about the *present* — there is nothing there — and the map
    // shows the present, so they pool toward one threshold (D65). They disagree about history, and
    // that disagreement is recorded on the vote rows, where the moderation signal reads it. Requiring
    // two of a *kind* would leave a genuinely-clear hazard standing because its two witnesses
    // explained it differently, which is over-warning for no gain.
    case 'fully_healed':
    case 'never_existed': {
      const goneCount = state.goneCount + (counts ? 1 : 0);
      return {
        ...state,
        lastConfirmedAt,
        goneCount,
        healingState: annotate(goneCount, 'none'),
        status: shouldArchive(goneCount, removalThreshold) ? 'archived' : state.status,
      };
    }
  }
}

/** One stored confirmation, reduced to what the lifecycle derivation needs. */
export interface HazardVoteRecord {
  userId: string;
  verdict: HazardVerdict;
  /** Epoch ms the skater observed it (the clamped `observedAt`). */
  at: number;
}

export interface DeriveHazardLifecycleOptions {
  /** The hazard's author — their votes refresh the clock but never move a threshold (D54). */
  authorId: string;
  /** Hazard creation time (epoch ms) — the floor for `lastConfirmedAt` when there are no later votes. */
  createdAt: number;
  /**
   * The hazard's current status. Archival is a ratchet: once the community has archived a hazard, one
   * person later changing their mind must not silently resurrect it — that path is a fresh re-report
   * (D15). So a hazard that is already `archived` stays archived regardless of the recomputed count.
   */
  priorStatus: HazardStatus;
  removalThreshold?: number;
  /**
   * Is this a passage marker (`ridge_crossing`)? Only they can reach `disputed` (D64) — on a hazard,
   * surfacing a below-threshold "gone" vote would invite skaters to discount a live warning.
   */
  isPassage?: boolean;
}

/**
 * Derive a hazard's lifecycle state from its **entire** vote set. This — not `applyConfirmation` — is
 * how stored counts are maintained.
 *
 * **Why derive instead of increment (the whole reason this exists).** A counter bumped once per vote
 * row cannot tell that two rows came from the *same* account, so one person could vote `fully_healed`
 * twice and hit the removal threshold alone — a false all-clear cast by a single skater, which is the
 * worst outcome in the whole system (D3). Counting *distinct users' current verdicts* makes that
 * impossible by construction, and it makes the mutation **idempotent**: recomputing from the votes
 * yields the same state no matter how many times an offline confirmation replays on flush.
 *
 * Rules, all following from "one skater = one current opinion":
 *  - Each user contributes only their **latest** vote (ties broken by latest wins).
 *  - `confirmCount` / `goneCount` count **distinct non-author users** whose current verdict is
 *    `still_there` / `fully_healed`.
 *  - `healingState` reflects the single most recent vote *overall* (author included — a healing note is
 *    information, not a threshold) — **except** on a passage marker below the removal threshold, where
 *    a standing "gone" vote makes it `disputed` regardless of what was said most recently (D64).
 *  - `lastConfirmedAt` is the max of creation time and every vote's `at` — monotonic, author included.
 *  - `status` archives at the threshold and never un-archives (see `priorStatus`).
 */
export function deriveHazardLifecycle(
  votes: readonly HazardVoteRecord[],
  options: DeriveHazardLifecycleOptions,
): HazardLifecycleState {
  const {
    authorId,
    createdAt,
    priorStatus,
    removalThreshold = DEFAULT_REMOVAL_THRESHOLD,
    isPassage = false,
  } = options;

  // Reduce to each user's most recent vote.
  const latestByUser = new Map<string, HazardVoteRecord>();
  for (const vote of votes) {
    const prior = latestByUser.get(vote.userId);
    if (!prior || vote.at >= prior.at) latestByUser.set(vote.userId, vote);
  }

  let confirmCount = 0;
  let goneCount = 0;
  let lastConfirmedAt = createdAt;
  let mostRecent: HazardVoteRecord | undefined;
  for (const vote of latestByUser.values()) {
    lastConfirmedAt = Math.max(lastConfirmedAt, vote.at);
    if (!mostRecent || vote.at >= mostRecent.at) mostRecent = vote;
    // The author's own vote refreshes the clock (handled above) but is not independent evidence, so it
    // moves neither threshold.
    if (vote.userId === authorId) continue;
    if (vote.verdict === 'still_there') confirmCount += 1;
    // Pooled, as in `applyConfirmation`: "it healed" and "it was never here" agree about now (D65).
    else if (vote.verdict === 'fully_healed' || vote.verdict === 'never_existed') goneCount += 1;
  }

  // `disputed` outranks `healing_unsafe` when both apply: "the ridge is closed here" is a stronger
  // claim than "the crossing is dicey", and the stronger one is what a skater needs to read first.
  const disputed = isPassage && goneCount >= 1 && goneCount < removalThreshold;
  const healingState: HazardHealingState = disputed
    ? 'disputed'
    : mostRecent?.verdict === 'healing_unsafe'
      ? 'healing_unsafe'
      : 'none';
  const status: HazardStatus =
    priorStatus === 'archived' || shouldArchive(goneCount, removalThreshold)
      ? 'archived'
      : 'active';

  return { lastConfirmedAt, confirmCount, goneCount, healingState, status };
}

/** Whether enough independent `fully_healed` verdicts have accumulated to archive (never delete). */
export function shouldArchive(
  goneCount: number,
  removalThreshold = DEFAULT_REMOVAL_THRESHOLD,
): boolean {
  return goneCount >= removalThreshold;
}

/**
 * A hazard is *provisional* until independently confirmed, and *confirmed* after (D51/D54) — derived,
 * never stored, so tuning the threshold reclassifies existing hazards with no migration.
 *
 * This drives two things: provisional hazards render softer, and on-ice they surface as the soft
 * "can you confirm?" prompt rather than a hard warning — which is what keeps a troll's fake pin from
 * ever becoming a scary alert for anyone but the people physically on that ice.
 *
 * Pass {@link confirmThresholdFor} rather than the default when the type may be a passage marker: a
 * suggested crossing needs two confirmations to stop being provisional (D64).
 */
export function isProvisional(
  confirmCount: number,
  confirmThreshold = DEFAULT_CONFIRM_THRESHOLD,
): boolean {
  return confirmCount < confirmThreshold;
}

/** A fresh hazard's starting lifecycle state, at creation time `at` (epoch ms). */
export function initialLifecycleState(at: number): HazardLifecycleState {
  return {
    lastConfirmedAt: at,
    confirmCount: 0,
    goneCount: 0,
    healingState: 'none',
    status: 'active',
  };
}
