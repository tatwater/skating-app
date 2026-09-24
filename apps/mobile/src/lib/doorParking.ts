/**
 * What happens to the open sheet when a new door opens (A10-3, D204).
 *
 * A door replaces the sheet on screen, and a half-written report must never be lost to a tap on a
 * lake. A *new* report with unsaved changes is parked in Drafts first. Two cases can't be parked,
 * and in both the answer is to keep the sheet rather than replace it:
 *
 *  - **An edit of a published report.** Drafts hold new reports only; an edit is saved or
 *    cancelled from its own sheet.
 *  - **A park that failed** — the draft is sending right now, or the write did not land. Opening
 *    the next door anyway would throw the changes away without a word (Greptile, PR #76).
 *
 * The save is passed in so the rule can be tested without the phone's storage.
 */

import type { PostSheet } from '@skating/core';

export type Parking =
  /** Nothing unsaved, or it was parked in Drafts: the door may open. */
  | { kind: 'clear' }
  /** The sheet keeps the screen; `message` says why and what to do. */
  | { kind: 'held'; message: string };

export const EDIT_HELD_MESSAGE =
  'You have unsaved changes to a published report. Save or cancel them, then open the other one.';

export async function parkForNewDoor(
  current: PostSheet | null,
  now: number,
  saveAsDraft: (sheet: PostSheet, now: number) => Promise<unknown>,
): Promise<Parking> {
  if (current === null || !current.dirty) return { kind: 'clear' };
  if (current.mode.kind !== 'create') return { kind: 'held', message: EDIT_HELD_MESSAGE };
  try {
    await saveAsDraft(current, now);
    return { kind: 'clear' };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      kind: 'held',
      message: `Couldn't hold this report in Drafts (${why}). It's still here — save or post it, then open the other one.`,
    };
  }
}
