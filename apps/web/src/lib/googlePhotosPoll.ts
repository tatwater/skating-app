/**
 * *From Google Photos* (A10-8 §8.6): what the page does after each look at the pick. Pure, so the
 * loop's rule is tested rather than trusted.
 *
 * The page never judges by its window. Google's consent and picker pages can cut the window off from
 * the page that opened it (their cross-origin opener policy), and then `window.closed` reads `true`
 * while the person is still picking; ending on it would delete a live session under them. So the
 * pick ends only when the session does — picked, or gone — or when the person says *Cancel*.
 */

export type PickPhase =
  | { phase: 'consent'; pollIntervalMs: number }
  | { phase: 'picking'; pollIntervalMs: number }
  | { phase: 'picked' }
  | { phase: 'gone' };

export type PickStep = { kind: 'wait'; ms: number } | { kind: 'add' } | { kind: 'end' };

export function nextPickStep(status: PickPhase): PickStep {
  if (status.phase === 'picked') return { kind: 'add' };
  if (status.phase === 'gone') return { kind: 'end' };
  return { kind: 'wait', ms: status.pollIntervalMs };
}
