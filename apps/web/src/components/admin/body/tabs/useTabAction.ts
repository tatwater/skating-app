import { useCallback, useMemo } from 'react';

import type { RefusalWords } from '../../said';
import { type Receipt, useUndo } from '../../shell/undo';
import { notSavedWords, sendFor, useBodyHold } from '../frame/currentBody';
import { LANDED, type PickOutcome, REFUSED } from './latestPick';

/**
 * How the Body console's tabs run a write: the mutation, then the receipt toast with Undo while the
 * server offers one (the shell's `announce`, D226), or — refused — a toast naming the body and what
 * was not saved (D268). Shared by Names, Places, Access and Water.
 *
 * - **`act`**, from a button or a reason dialog: resolves `true` when the write landed. A refusal is
 *   already said in its toast; a dialog that gets `false` stays open over what was typed.
 * - **`attempt`**, a press-to-save control's write (`useLatestPick`): its outcome in the store's one
 *   shape; **`words`** are the page's for a sender that threw, which the store says.
 */
/**
 * A write's receipt: fixed, or built from the write's own answer (a write that answers its audit row
 * and undo offer — the merge — hands its Undo to the receipt so the toast looks nothing up).
 */
export type TabReceipt<T> = Receipt | ((answer: T) => Receipt);

export function useTabAction(bodyId: string): {
  act: <T>(write: () => Promise<T>, receipt: TabReceipt<T>) => Promise<boolean>;
  attempt: <T>(
    write: () => Promise<T>,
    receipt: TabReceipt<T>,
    what: string,
  ) => Promise<PickOutcome>;
  words: (what: string) => (why: string) => RefusalWords;
} {
  const { announce } = useUndo();
  // The console this tab mounted under (`currentBody`): a pressed write runs to its end against
  // `bodyId`, and every result names the body wherever it shows.
  const hold = useBodyHold();
  const run = useCallback(
    <T>(
      write: () => Promise<T>,
      receipt: TabReceipt<T>,
      /** What it was, for its refusal; else the receipt's title. */
      what?: string,
    ): Promise<boolean> => {
      // The write's answer, kept for a receipt built from it.
      let answer: T | undefined;
      const fixed = typeof receipt === 'function' ? null : receipt;
      return sendFor(hold, {
        body: bodyId,
        write: async () => {
          answer = await write();
          return answer;
        },
        receipt: (subject) =>
          announce({ ...(fixed ?? (receipt as (a: T) => Receipt)(answer as T)), subject }),
        what:
          what ?? (fixed !== null && typeof fixed.title === 'string' ? fixed.title : 'The change'),
      });
    },
    [announce, hold, bodyId],
  );
  const attempt = useCallback(
    async <T>(
      write: () => Promise<T>,
      receipt: TabReceipt<T>,
      what: string,
    ): Promise<PickOutcome> => ((await run(write, receipt, what)) ? LANDED : REFUSED),
    [run],
  );
  const words = useCallback((what: string) => notSavedWords(hold, what), [hold]);
  // `act` is the runner itself, its refusal named by the receipt's title.
  return useMemo(() => ({ act: run, attempt, words }), [run, attempt, words]);
}
