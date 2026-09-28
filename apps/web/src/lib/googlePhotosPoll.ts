/**
 * *From Google Photos* (A10-8 §8.6): what the page does after each look at the pick. Pure, so the
 * one judgment in the loop — when a closed window means the person walked away — is tested rather
 * than trusted.
 *
 * Google's picker closes its own window once the person is done (`/autoclose`), and the session
 * says `mediaItemsSet` a moment later; so a closed window alone is not an ending. A window closed
 * while the session still says *picking* for a few more looks is one: the person closed it
 * without choosing, and nothing will ever be set.
 */

export type PickPhase =
  | { phase: 'consent'; pollIntervalMs: number }
  | { phase: 'picking'; pollIntervalMs: number }
  | { phase: 'picked' }
  | { phase: 'gone' };

/** How many looks a closed window gets before the page gives up on it. */
export const CLOSED_WINDOW_GRACE_POLLS = 3;

export type PickStep =
  | { kind: 'wait'; ms: number; closedPolls: number }
  | { kind: 'add' }
  | { kind: 'end'; reason: 'gone' | 'walked-away' };

export function nextPickStep(
  status: PickPhase,
  windowClosed: boolean,
  closedPolls: number,
): PickStep {
  if (status.phase === 'picked') return { kind: 'add' };
  if (status.phase === 'gone') return { kind: 'end', reason: 'gone' };
  const closed = windowClosed ? closedPolls + 1 : 0;
  if (closed > CLOSED_WINDOW_GRACE_POLLS) return { kind: 'end', reason: 'walked-away' };
  return { kind: 'wait', ms: status.pollIntervalMs, closedPolls: closed };
}
