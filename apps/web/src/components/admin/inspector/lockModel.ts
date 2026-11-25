/**
 * **The decided-only lock, as a state machine** (D283) — pure, so every path is tested without a
 * subscription. Shared by the Inbox and Corpus (moved here from `inbox/inspector/` in B01-6a); each
 * mode maps its own decided view to the frame's `DecidedState` (the Inbox's `decidedStateOf` is in
 * `inbox/inspector/inboxLock.ts`). The lock is the item's own decision, read live (the item read is
 * a subscription); what it means depends on what the item was when it opened:
 *
 * - **`none`** — nothing read yet for this ref (on its way).
 * - **`live`** — open and undecided: the handler's verbs stand.
 * - **`onOpen`** — already decided when it opened (the Decided lane, a tail row): a record, read
 *   only, its decision shown whoever made it.
 * - **`locked`** — decided by someone else while it was open here: the action bar goes and the
 *   banner says who, when and what, with the way back to the queue.
 * - **`quiet`** — decided by the viewer while it was open here: it clears quietly (they know).
 * - **`missing`** — the ref names nothing (*No such item*, the list still usable).
 * - **`gone`** — it was there and left while open (every member withdrawn: an item with no member
 *   is deleted, never decided) — *No such item* too.
 *
 * An undo (the item reopening) takes any decided state back to `live`; another ref starts over.
 */
export type LockPhase = 'none' | 'live' | 'onOpen' | 'locked' | 'quiet' | 'missing' | 'gone';

export type LockState = { ref: string | null; phase: LockPhase };

/** What one answer of the item read says, for the lock: no item, or whether and by whom decided. */
export type LockSeen =
  | { item: false }
  | { item: true; decided: false }
  | { item: true; decided: true; byMe: boolean };

export const LOCK_START: LockState = { ref: null, phase: 'none' };

/**
 * The lock after the read for `ref` answered `seen` (`undefined`: still on its way, or failed —
 * nothing changes on a read that didn't answer).
 */
export function nextLock(
  prev: LockState,
  ref: string | null,
  seen: LockSeen | undefined,
): LockState {
  const state = prev.ref === ref ? prev : { ref, phase: 'none' as const };
  if (seen === undefined) return state;
  const phase = step(state.phase, seen);
  return phase === state.phase ? state : { ref, phase };
}

function step(phase: LockPhase, seen: LockSeen): LockPhase {
  if (!seen.item) return phase === 'none' || phase === 'missing' ? 'missing' : 'gone';
  if (!seen.decided) return 'live';
  switch (phase) {
    case 'live':
      return seen.byMe ? 'quiet' : 'locked';
    case 'locked':
    case 'quiet':
    case 'onOpen':
      return phase;
    // First seen decided — or seen again after it was missing: a record, read only.
    case 'none':
    case 'missing':
    case 'gone':
      return 'onOpen';
  }
}

/** Whether a phase is a decided one (the action bar goes, `locked` is passed to the frame). */
export const isDecidedPhase = (phase: LockPhase): boolean =>
  phase === 'onOpen' || phase === 'locked' || phase === 'quiet';

/** The lock's reading of one item read's answer (either mode's: only `byMe` is read). */
export function lockSeenOf<Decided extends { byMe: boolean }>(
  item: { decided: Decided | null } | null | undefined,
): LockSeen | undefined {
  if (item === undefined) return undefined;
  if (item === null) return { item: false };
  return item.decided === null
    ? { item: true, decided: false }
    : { item: true, decided: true, byMe: item.decided.byMe };
}
