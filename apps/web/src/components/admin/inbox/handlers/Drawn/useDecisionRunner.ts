import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { ToastManager } from '@/components/kit/toast';

import { notSavedTitle, notSavedWhat } from '../../../body/consoleWords';
import { said } from '../../../said';
import { type Receipt, type UndoTarget, useUndo } from '../../../shell/undo';

/**
 * **One decision's write path** — the drawn and place handlers' (`useDrawnWrites`,
 * `usePlaceWrites`), the shape the access handler's runner has:
 *
 * - **Through `said` (D268)**: a refusal — the server's, a throw, a failed send — is one toast,
 *   "Not saved · ‹subject›" with the server's own sentence, never printed in place.
 * - **A landed decision raises the shell's receipt**, in the present tense (what the decision
 *   does: "Closes 3 asks"), with Undo found from the write's own result: these writes answer with
 *   the id of what they decided, which is the receipt's target, and the shell finds the caller's
 *   newest row on it (`undo.latestOwn`) — the decision just written.
 * - **A receipt never shows over another item**: the item drawn is asked again once the server has
 *   answered, and the receipt shows only if it is still the one drawn.
 * - **Nothing optimistic, one write at a time**: the press shows pending until the server answers,
 *   and the item's read draws what changed.
 *
 * `run` resolves whether it landed — a reason dialog closes on `true` and stays open over what was
 * typed on `false`.
 */

export type Decision<A extends string> = {
  /** Which lever this is, for the pending state. */
  act: A;
  /**
   * The write, answering what it decided as the receipt's Undo target — built from the write's own
   * answer (the id it returns), never from what the page assumed.
   */
  write: () => Promise<UndoTarget>;
  /** What a refusal's toast says was not saved ("The decision"). */
  what: string;
  /** The receipt, once it landed. */
  receipt: { title: string; description?: string };
};

export function useDecisionRunner<A extends string>({
  itemId,
  subject,
  manager,
}: {
  itemId: string;
  /** Whose it is, by name: the receipt's and the refusal's subject ("Caspian Lake"). */
  subject: string;
  manager?: ToastManager;
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
        const sent = await said(
          decision.write,
          (why) => ({
            title: notSavedTitle(subject),
            description: notSavedWhat(decision.what, why),
          }),
          manager !== undefined ? { manager } : {},
        );
        if (!sent.landed) return false;
        const receipt: Receipt = {
          title: decision.receipt.title,
          ...(decision.receipt.description !== undefined
            ? { description: decision.receipt.description }
            : {}),
          target: sent.value,
          subject,
        };
        void announce(receipt, () => shown.current === mine).catch(() => {});
        return true;
      } finally {
        out.current = false;
        setPending(null);
      }
    },
    [announce, itemId, subject, manager],
  );
  return { run, pending };
}
