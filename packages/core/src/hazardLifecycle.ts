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
export type HazardVerdict = 'still_there' | 'healing_unsafe' | 'fully_healed'

/** Whether the latest verdict marked the hazard as healing-but-still-dangerous. */
export type HazardHealingState = 'none' | 'healing_unsafe'

/** Lifecycle status. Separate from moderation status — see the note on `HazardLifecycleState`. */
export type HazardStatus = 'active' | 'archived'

/**
 * The mutable lifecycle fields of a hazard.
 *
 * Note what is *not* here: `moderationStatus`. Moderation and lifecycle are deliberately separate axes
 * (2026-07-21). Archiving a troll pin instead of hiding it would make abuse indistinguishable from the
 * community clearing a real hazard — a moderator action must never read as a safety verdict (D3).
 */
export interface HazardLifecycleState {
  lastConfirmedAt: number
  confirmCount: number
  goneCount: number
  healingState: HazardHealingState
  status: HazardStatus
}

/**
 * How many independent `still_there` confirmations promote a hazard from *provisional* to *confirmed*.
 * Tunable, admin-editable in Phase 7 (D49); no reputation weighting yet (D50/D54).
 */
export const DEFAULT_CONFIRM_THRESHOLD = 1

/**
 * How many independent `fully_healed` verdicts archive a hazard. Higher than the confirm threshold on
 * purpose: the asymmetry is the safety margin. Believing a hazard is present when it isn't costs a
 * detour; believing it's gone when it isn't can kill someone (D3).
 */
export const DEFAULT_REMOVAL_THRESHOLD = 2

export interface ApplyConfirmationOptions {
  /** Confirmations by the hazard's own author don't count toward either threshold (D54). */
  isAuthor?: boolean
  removalThreshold?: number
}

/**
 * Apply one confirmation to a hazard's lifecycle state. Pure: returns the next state, mutates nothing.
 *
 * `at` (epoch ms) is the confirmation time — passed in rather than read from the clock so this stays
 * deterministic and testable, and so an offline confirmation flushed hours later still stamps the
 * moment the skater actually stood there.
 */
export function applyConfirmation(
  state: HazardLifecycleState,
  verdict: HazardVerdict,
  at: number,
  options: ApplyConfirmationOptions = {},
): HazardLifecycleState {
  const { isAuthor = false, removalThreshold = DEFAULT_REMOVAL_THRESHOLD } = options
  // The author vouching for their own report is not independent evidence (D54). It still refreshes the
  // decay clock — they were genuinely there and looked — it just can't promote or remove the pin.
  const counts = !isAuthor

  switch (verdict) {
    case 'still_there':
      return {
        ...state,
        lastConfirmedAt: at,
        confirmCount: state.confirmCount + (counts ? 1 : 0),
        // Seeing it still there supersedes an earlier "healing" note.
        healingState: 'none',
      }

    case 'healing_unsafe':
      return {
        ...state,
        // Someone looked at it, so the observation is fresh — but "healing" is not a clearance, so it
        // moves neither counter. The pin stays, now annotated, because a healing spot is exactly the
        // thing a future skater needs to be able to read.
        lastConfirmedAt: at,
        healingState: 'healing_unsafe',
      }

    case 'fully_healed': {
      const goneCount = state.goneCount + (counts ? 1 : 0)
      return {
        ...state,
        lastConfirmedAt: at,
        goneCount,
        healingState: 'none',
        status: shouldArchive(goneCount, removalThreshold) ? 'archived' : state.status,
      }
    }
  }
}

/** Whether enough independent `fully_healed` verdicts have accumulated to archive (never delete). */
export function shouldArchive(
  goneCount: number,
  removalThreshold = DEFAULT_REMOVAL_THRESHOLD,
): boolean {
  return goneCount >= removalThreshold
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
  return confirmCount < confirmThreshold
}

/** A fresh hazard's starting lifecycle state, at creation time `at` (epoch ms). */
export function initialLifecycleState(at: number): HazardLifecycleState {
  return {
    lastConfirmedAt: at,
    confirmCount: 0,
    goneCount: 0,
    healingState: 'none',
    status: 'active',
  }
}
