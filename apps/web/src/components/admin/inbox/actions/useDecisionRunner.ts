import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { notSavedTitle, notSavedWhat } from '../../body/consoleWords';
import { said } from '../../said';
import { type Receipt, type UndoTarget, useUndo } from '../../shell/undo';

/**
 * **The Inbox's one decision runner** — every request, place and drawn write runs through it
 * (`useRequestWrites`, `usePlaceWrites`, `useDrawnWrites`), the shape the access handler's runner has:
 *
 * - **Through `said` (D268)**: a refusal — the server's, a throw, a failed send — is one toast,
 *   "Not saved · ‹subject›" with the server's own sentence, never printed in place.
 * - **A landed decision raises the shell's receipt**, in the present tense (what the decision
 *   does: "Closes 3 asks"), with Undo from the write's own answer when it gives one
 *   ({@link WriteAnswer}: its audit row and whether it can be undone).
 * - **A receipt never shows over another item**: the item drawn is asked again once the server has
 *   answered, and the receipt shows only if it is still the one drawn.
 * - **Nothing optimistic, one write at a time**: the press shows pending until the server answers,
 *   and the item's read draws what changed.
 *
 * `run` resolves whether it landed — a reason dialog closes on `true` and stays open over what was
 * typed on `false`.
 */

/**
 * What a decision's write answers with, once the server says it (Access's `ruleAccess` already
 * does): the decision's own audit row and whether it can be undone now.
 */
export type WriteAnswer = { actionId: string; undoable: boolean; undoNeedsReason: boolean };

/**
 * What landed: the receipt's target (built from the item's ids or the write's answer, never from
 * what the page assumed), and the write's own answer when it gives one.
 */
export type Landed = { target: UndoTarget; answer?: WriteAnswer };

export type Decision<A extends string> = {
  /** Which lever this is, for the pending state. */
  act: A;
  write: () => Promise<Landed>;
  /** What a refusal's toast says was not saved ("The decision"). */
  what: string;
  /** The receipt, once it landed; `undoable: false` when it decided nothing (a lookup). */
  receipt: { title: string; description?: string; undoable?: false };
};

/** The receipt's Undo: from the write's answer, else the shell's lookup on the target. */
export function undoOf(
  landed: Landed,
  undoable: false | undefined,
): Pick<Receipt, 'actionId' | 'undoNeedsReason' | 'undoable'> {
  if (undoable === false) return { undoable: false };
  const answer = landed.answer;
  // FALLBACK (until the request, place and drawn writes answer with `WriteAnswer`): no answer, so
  // the shell looks up the caller's newest row on the target (`undo.latestOwn`) — the decision
  // just written. Delete this branch, and make `answer` required, once they do.
  if (answer === undefined) return {};
  return answer.undoable
    ? { actionId: answer.actionId, undoNeedsReason: answer.undoNeedsReason }
    : { actionId: answer.actionId, undoable: false };
}

export function useDecisionRunner<A extends string>({
  itemId,
  subject,
}: {
  itemId: string;
  /** Whose it is, by name: the receipt's and the refusal's subject ("Caspian Lake"). */
  subject: string;
}): { run: (decision: Decision<A>) => Promise<boolean>; pending: A | null } {
  const { announce } = useUndo();
  const [pending, setPending] = useState<A | null>(null);
  const out = useRef(false);
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    shown.current = itemId;
    return () => {
      shown.current = null;
    };
  }, [itemId]);
  const run = useCallback(
    async (decision: Decision<A>): Promise<boolean> => {
      if (out.current) return false;
      out.current = true;
      const mine = itemId;
      setPending(decision.act);
      try {
        const sent = await said(decision.write, (why) => ({
          title: notSavedTitle(subject),
          description: notSavedWhat(decision.what, why),
        }));
        if (!sent.landed) return false;
        const receipt: Receipt = {
          title: decision.receipt.title,
          ...(decision.receipt.description !== undefined
            ? { description: decision.receipt.description }
            : {}),
          target: sent.value.target,
          subject,
          ...undoOf(sent.value, decision.receipt.undoable),
        };
        void announce(receipt, () => shown.current === mine).catch(() => {});
        return true;
      } finally {
        out.current = false;
        setPending(null);
      }
    },
    [announce, itemId, subject],
  );
  return { run, pending };
}
