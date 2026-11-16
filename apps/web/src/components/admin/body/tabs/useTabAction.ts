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
export function useTabAction(bodyId: string): {
  act: (write: () => Promise<unknown>, receipt: Receipt) => Promise<boolean>;
  attempt: (write: () => Promise<unknown>, receipt: Receipt, what: string) => Promise<PickOutcome>;
  words: (what: string) => (why: string) => RefusalWords;
} {
  const { announce } = useUndo();
  // The console this tab mounted under (`currentBody`): a pressed write runs to its end against
  // `bodyId`, and every result names the body wherever it shows.
  const hold = useBodyHold();
  const run = useCallback(
    (
      write: () => Promise<unknown>,
      receipt: Receipt,
      /** What it was, for its refusal; else the receipt's title. */
      what?: string,
    ): Promise<boolean> =>
      sendFor(hold, {
        body: bodyId,
        write,
        receipt: (subject) => announce({ ...receipt, subject }),
        what: what ?? (typeof receipt.title === 'string' ? receipt.title : 'The change'),
      }),
    [announce, hold, bodyId],
  );
  const act = useCallback(
    (write: () => Promise<unknown>, receipt: Receipt) => run(write, receipt),
    [run],
  );
  const attempt = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt, what: string): Promise<PickOutcome> =>
      (await run(write, receipt, what)) ? LANDED : REFUSED,
    [run],
  );
  const words = useCallback((what: string) => notSavedWords(hold, what), [hold]);
  return useMemo(() => ({ act, attempt, words }), [act, attempt, words]);
}
