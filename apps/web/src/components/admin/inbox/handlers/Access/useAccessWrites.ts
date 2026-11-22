import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { notSavedTitle, notSavedWhat } from '../../../body/consoleWords';
import { said } from '../../../said';
import { type Receipt, useUndo } from '../../../shell/undo';
import { type AccessAct, receiptDetail, receiptTitle } from './accessModel';
import { ACCESS_WORDS as W } from './accessWords';

/**
 * **The access ruling's one write path** (board 2.2): the Inbox's own write,
 * `inboxWrites.ruleAccess`, called with the **item** — so the Inbox's rule is asked before anything
 * changes: a staffer who filed one of the reports is refused (D289), and so is a ruling on an item a
 * colleague has already decided (D283). Never the Body console's lever (`setPublicAccess`), which
 * asks neither.
 *
 * Through `said` (D268): a refusal is one toast, "Not saved · ‹body›" with the server's sentence,
 * never printed in place. A landed ruling raises the shell's receipt with Undo on the ruling's own
 * row (the answer's `actionId`; one Undo puts the ruling back and reopens the reports and the item).
 * **Nothing is optimistic**: the bar shows the press pending until the server answers, and the item's
 * read draws what changed. One write at a time.
 *
 * `run` resolves whether it landed — the reason dialog closes on `true` and stays open over the
 * typed reason on `false`.
 */

/** `ruleAccess`'s answer. */
export type RuleAccessResult = FunctionReturnType<typeof api.inboxWrites.ruleAccess>;

/** The write itself: `ruleAccess`, or a story's or a test's fake of it. */
export type AccessWriteFn = (args: {
  itemId: Id<'inboxItems'>;
  verdict: 'none' | 'open' | null;
  reason?: string;
}) => Promise<RuleAccessResult>;

/** What the runner needs of the item: its id (the write's), and its body (the receipt's). */
export type AccessSubject = {
  itemId: Id<'inboxItems'>;
  waterBodyId: Id<'waterBodies'>;
  name: string;
};

/** The one mutation the handler rules through (a test holds the handler to it). */
export const RULE_ACCESS = api.inboxWrites.ruleAccess;

export function useAccessWrites(subject: AccessSubject): {
  run: (act: AccessAct, reason?: string) => Promise<boolean>;
  pending: AccessAct | null;
} {
  const ruleAccess = useMutation(RULE_ACCESS);
  return useAccessRunner(subject, ruleAccess);
}

/** The verdict a press sends: a clear is `null`. */
export const verdictOf = (act: AccessAct): 'none' | 'open' | null => (act === 'clear' ? null : act);

/** The runner, over any write: the hook's own, and a story's or a test's fake. */
export function useAccessRunner(
  subject: AccessSubject,
  write: AccessWriteFn,
): { run: (act: AccessAct, reason?: string) => Promise<boolean>; pending: AccessAct | null } {
  const { announce } = useUndo();
  const [pending, setPending] = useState<AccessAct | null>(null);
  const out = useRef(false);
  // **A receipt never shows over another item** (the shell's rule): the item this handler draws,
  // while it is mounted — set at the commit that shows it, and released (`null`) at the commit
  // that removes the handler or moves it to another item. A ruling's receipt asks it again once
  // the server has answered, and shows only if its own item is still the one drawn.
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    shown.current = subject.itemId;
    return () => {
      shown.current = null;
    };
  }, [subject.itemId]);
  const run = useCallback(
    async (act: AccessAct, reason?: string): Promise<boolean> => {
      if (out.current) return false;
      out.current = true;
      const mine: string = subject.itemId;
      setPending(act);
      try {
        const sent = await said(
          () =>
            write({
              itemId: subject.itemId,
              verdict: verdictOf(act),
              ...(reason ? { reason } : {}),
            }),
          (why) => ({
            title: notSavedTitle(subject.name),
            description: notSavedWhat(W.theRuling, why),
          }),
        );
        if (!sent.landed) return false;
        const answer = sent.value;
        const undo: Pick<Receipt, 'actionId' | 'undoNeedsReason' | 'undoable'> = answer.undoable
          ? { actionId: answer.actionId, undoNeedsReason: answer.undoNeedsReason }
          : { actionId: answer.actionId, undoable: false };
        void announce(
          {
            title: receiptTitle(act),
            description: receiptDetail(act, answer.flagsClosed),
            subject: subject.name,
            // The ruling's row is the body's.
            target: { targetType: 'waterbody', targetId: subject.waterBodyId },
            ...undo,
          },
          () => shown.current === mine,
        ).catch(() => {});
        return true;
      } finally {
        out.current = false;
        setPending(null);
      }
    },
    [announce, subject.itemId, subject.waterBodyId, subject.name, write],
  );
  return { run, pending };
}
