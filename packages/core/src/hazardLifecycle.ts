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

/** The three-tier confirmation vote (D52). Replaces the old binary still_there|gone. */
export type HazardVerdict = 'still_there' | 'healing_unsafe' | 'fully_healed';

/** Whether the latest verdict marked the hazard as healing-but-still-dangerous. */
export type HazardHealingState = 'none' | 'healing_unsafe';

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
 * How many independent `fully_healed` verdicts archive a hazard. Higher than the confirm threshold on
 * purpose: the asymmetry is the safety margin. Believing a hazard is present when it isn't costs a
 * detour; believing it's gone when it isn't can kill someone (D3).
 */
export const DEFAULT_REMOVAL_THRESHOLD = 2;

export interface ApplyConfirmationOptions {
  /** Confirmations by the hazard's own author don't count toward either threshold (D54). */
  isAuthor?: boolean;
  removalThreshold?: number;
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
  const { isAuthor = false, removalThreshold = DEFAULT_REMOVAL_THRESHOLD } = options;
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
        // Seeing it still there supersedes an earlier "healing" note.
        healingState: 'none',
      };

    case 'healing_unsafe':
      return {
        ...state,
        // Someone looked at it, so the observation is fresh — but "healing" is not a clearance, so it
        // moves neither counter. The pin stays, now annotated, because a healing spot is exactly the
        // thing a future skater needs to be able to read.
        lastConfirmedAt,
        healingState: 'healing_unsafe',
      };

    case 'fully_healed': {
      const goneCount = state.goneCount + (counts ? 1 : 0);
      return {
        ...state,
        lastConfirmedAt,
        goneCount,
        healingState: 'none',
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
 *    information, not a threshold).
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
    else if (vote.verdict === 'fully_healed') goneCount += 1;
  }

  const healingState: HazardHealingState =
    mostRecent?.verdict === 'healing_unsafe' ? 'healing_unsafe' : 'none';
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
