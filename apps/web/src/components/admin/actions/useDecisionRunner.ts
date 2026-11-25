import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { notSavedTitle, notSavedWhat } from '../body/consoleWords';
import { said } from '../said';
import { type Receipt, type UndoTarget, useUndo } from '../shell/undo';

/**
 * **The Inbox's one decision runner** — every request, place and drawn write runs through it
 * (`useRequestWrites`, `usePlaceWrites`, `useDrawnWrites`), the shape the access handler's runner has:
 *
 * - **Through `said` (D268)**: a refusal — the server's, a throw, a failed send — is one toast,
 *   "Not saved · ‹subject›" with the server's own sentence, never printed in place.
 * - **A landed decision raises the shell's receipt**, in the present tense (what the decision
 *   does: "Closes 3 asks"), with Undo from the write's own answer ({@link WriteAnswer}: its audit
 *   row and whether this viewer can undo it now) — never a lookup of the latest action.
 * - **A receipt never shows over another item**: the item drawn is asked again once the server has
 *   answered, and the receipt shows only if it is still the one drawn.
 * - **Nothing optimistic, one write at a time**: the press shows pending until the server answers,
 *   and the item's read draws what changed.
 *
 * `run` resolves whether it landed — a reason dialog closes on `true` and stays open over what was
 * typed on `false`.
 */

/**
 * What a decision's write answers (the server's `InboxDecisionResult`, as Access's `ruleAccess`
 * answers too): the decision's own audit row, and whether this viewer can undo it now — read by the
 * undo engine's own rule, so the toast never looks up "the latest action" on the target.
 */
export type WriteAnswer = { actionId: string } & (
  | { undoable: true; undoNeedsReason: boolean }
  | { undoable: false }
);

/**
 * What landed: the receipt's target (built from the item's ids or the write's answer, never from
 * what the page assumed), and the write's own answer — `null` for a write that decided nothing (a
 * lookup), which offers no Undo.
 */
export type Landed = { target: UndoTarget; answer: WriteAnswer | null };

export type Decision<A extends string> = {
  /** Which lever this is, for the pending state. */
  act: A;
  write: () => Promise<Landed>;
  /** What a refusal's toast says was not saved ("The decision"). */
  what: string;
  /**
   * The receipt, once it landed; `action` is the audit verb the write recorded when its Undo has
   * more to say (a merge's unmerge — see the shell's `Receipt.action`).
   */
  receipt: { title: string; description?: string; action?: string };
  /**
   * The receipt from what the write answered, when that decides it (a reply the server stored as
   * not sent says so, never "on its way"); read only once the write landed, in place of `receipt`.
   */
  receiptOf?: () => { title: string; description?: string; action?: string };
};

/** The receipt's Undo, from the write's own answer alone: no answer, no Undo, nothing looked up. */
export function undoOf(landed: Landed): Pick<Receipt, 'actionId' | 'undoNeedsReason' | 'undoable'> {
  const answer = landed.answer;
  if (answer === null) return { undoable: false };
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
        const words = decision.receiptOf?.() ?? decision.receipt;
        const receipt: Receipt = {
          title: words.title,
          ...(words.description !== undefined ? { description: words.description } : {}),
          target: sent.value.target,
          subject,
          ...(words.action !== undefined ? { action: words.action } : {}),
          ...undoOf(sent.value),
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
