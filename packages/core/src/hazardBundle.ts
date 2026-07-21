/**
 * The D55 auto-bundle selection rule — which of the author's on-ice hazards go into the report
 * they're writing.
 *
 * A hazard flagged from the ice is a standalone row. When the same skater later writes their report
 * for that lake and skate window, re-entering it would be busywork — so the form offers to attach
 * them. The rule is **pre-checked, opt-out**, and that's why the state is stored as the set of
 * hazards the author *deselected* rather than the set they selected.
 *
 * The difference matters because the candidate list is a live query. If we stored the selection
 * positively, a hazard that finished syncing after the form opened — or one flagged from the ice
 * moments earlier — would arrive unchecked and be silently dropped from the report. Storing the
 * opt-outs means a late-arriving candidate is included by default, which is the behaviour D55
 * actually promises. Nothing is ever attached invisibly: the prompt itemises every candidate.
 */

/**
 * The hazards to attach: every candidate the author hasn't explicitly deselected.
 *
 * Order follows the candidate list (the server returns them oldest-first), so the attachment order
 * matches what the skater sees itemised in the prompt.
 */
export function bundledHazardIds(
  candidateIds: readonly string[],
  optedOutIds: readonly string[],
): string[] {
  const optedOut = new Set(optedOutIds)
  return candidateIds.filter((id) => !optedOut.has(id))
}

/** Toggle one candidate's opt-out state. `checked` is the *desired* state of the checkbox. */
export function toggleBundleOptOut(
  optedOutIds: readonly string[],
  hazardId: string,
  checked: boolean,
): string[] {
  if (checked) return optedOutIds.filter((id) => id !== hazardId)
  // Deselecting is idempotent — a double-fire from a jittery tap must not add the id twice.
  return optedOutIds.includes(hazardId) ? [...optedOutIds] : [...optedOutIds, hazardId]
}
