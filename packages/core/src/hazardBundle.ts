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
 * opt-outs means a late-arriving candidate is included by default, which is the behavior D55
 * actually promises. Nothing is ever attached invisibly: the prompt itemises every candidate.
 */

import type { HazardRef } from './draftQueue';
import type { HazardQueueItem } from './hazardQueue';
import type { HazardType } from './types';

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
  const optedOut = new Set(optedOutIds);
  return candidateIds.filter((id) => !optedOut.has(id));
}

/** Toggle one candidate's opt-out state. `checked` is the *desired* state of the checkbox. */
export function toggleBundleOptOut(
  optedOutIds: readonly string[],
  hazardId: string,
  checked: boolean,
): string[] {
  if (checked) return optedOutIds.filter((id) => id !== hazardId);
  // Deselecting is idempotent — a double-fire from a jittery tap must not add the id twice.
  return optedOutIds.includes(hazardId) ? [...optedOutIds] : [...optedOutIds, hazardId];
}

// ── The phone's own queue as candidates (D55 offline, A10 §9.1) ──────────────────────────────────

/** Default auto-bundle lookback when a report gives no start time (D55) — tunable in Phase 07. */
export const BUNDLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * The window a hazard must have been flagged in to be offered: inside the skate when a start time
 * is known, else `BUNDLE_LOOKBACK_MS` before its end. One rule for the server's list
 * (`hazards.listBundleCandidates`) and the phone's queue (`queuedBundleCandidates`), so a hazard
 * flagged last week on the same lake is not pre-checked into today's report from either side.
 */
export function bundleWindow(
  skateEndTime: number,
  skateStartTime?: number,
  lookbackMs: number = BUNDLE_LOOKBACK_MS,
): { from: number; to: number } {
  return { from: skateStartTime ?? skateEndTime - lookbackMs, to: skateEndTime };
}

/**
 * A candidate that is still (or was) a row in the phone's hazard queue carries a `local:`-prefixed
 * id: the report draft stores it as `{ localId }` and the flush resolves it through the queue. A
 * server id is stored as `{ hazardId }`.
 */
export const LOCAL_HAZARD_ID_PREFIX = 'local:';

export function isLocalHazardId(id: string): boolean {
  return id.startsWith(LOCAL_HAZARD_ID_PREFIX);
}

/** The candidate id for a queue row that has no server id yet. */
export function localHazardCandidateId(localId: string): string {
  return `${LOCAL_HAZARD_ID_PREFIX}${localId}`;
}

/** The queue's local id behind a candidate id, or `null` for a server id. */
export function localHazardIdOf(id: string): string | null {
  return isLocalHazardId(id) ? id.slice(LOCAL_HAZARD_ID_PREFIX.length) : null;
}

/** How a report draft stores one bundled candidate (see `HazardRef`). */
export function hazardRefFor(id: string): HazardRef {
  const localId = localHazardIdOf(id);
  return localId !== null ? { localId } : { hazardId: id };
}

/** One of the phone's queued hazards, shaped like a server candidate for the prompt. */
export interface QueuedBundleCandidate {
  id: string;
  type: HazardType;
  firstReportedAt: number;
}

/**
 * The hazards on the phone that belong beside the server's list: this lake, inside the window, not
 * parked in `error`. One that has already flushed carries its server id and is offered under that
 * — and left out when the server's list already has it (`serverIds`); one still waiting is offered
 * by local id. A coord-only capture (no `waterBodyId` until flush) cannot be matched to the lake
 * and is not offered.
 */
export function queuedBundleCandidates(
  items: readonly HazardQueueItem[],
  args: {
    waterBodyId: string;
    skateEndTime: number;
    skateStartTime?: number;
    serverIds: ReadonlySet<string>;
  },
): QueuedBundleCandidate[] {
  // No end time yet (the field mid-edit) is no window, not an open one — the server's list is
  // skipped on the same condition.
  if (!Number.isFinite(args.skateEndTime)) return [];
  const { from, to } = bundleWindow(args.skateEndTime, args.skateStartTime);
  const out: QueuedBundleCandidate[] = [];
  for (const item of items) {
    if (item.kind !== 'hazard' || item.waterBodyId !== args.waterBodyId) continue;
    if (item.status === 'error') continue;
    if (item.capturedAt < from || item.capturedAt > to) continue;
    const id = item.hazardId ?? localHazardCandidateId(item.id);
    if (args.serverIds.has(id)) continue;
    out.push({ id, type: item.type, firstReportedAt: item.capturedAt });
  }
  return out.sort((a, b) => a.firstReportedAt - b.firstReportedAt);
}

/**
 * Reopening a draft: the candidates the skater left **unchecked** last time, so their choice
 * survives the edit (A10 §9.1). A candidate the saved refs name — by server id or by local id — is
 * checked; every other candidate offered now starts unchecked, including one that synced in since:
 * the last explicit choice wins over the default when there *was* a choice. A fresh form (no saved
 * refs) keeps the default — everything pre-checked.
 */
export function optOutsFromSavedRefs(
  candidateIds: readonly string[],
  saved: readonly HazardRef[] | undefined,
): string[] {
  if (!saved) return [];
  const kept = new Set<string>();
  for (const ref of saved) {
    if (ref.hazardId !== undefined) kept.add(ref.hazardId);
    if (ref.localId !== undefined) kept.add(localHazardCandidateId(ref.localId));
  }
  return candidateIds.filter((id) => !kept.has(id));
}
