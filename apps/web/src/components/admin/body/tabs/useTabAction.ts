import { useCallback, useMemo } from 'react';

import { toast } from '@/components/kit/toast';

import { type Receipt, useUndo } from '../../shell/undo';
import { notSavedWhat } from '../consoleWords';
import { listChanged, sayNotSaved, sendFor, useBodyHold } from '../frame/currentBody';
import type { PickOutcome } from './latestPick';

/**
 * How the Body console's tabs run a write: the mutation, then the receipt toast with Undo while the
 * server offers one (the shell's `announce`, D226). Shared by Names, Places, Access and Water.
 *
 * - **`act`**, from a button: a refusal is a red toast in the server's own words; resolves `true`
 *   when the write landed.
 * - **`actInDialog`**, from a reason dialog: a refusal comes back as the server's words for the
 *   dialog to show over the kept reason (`null` when it landed), so nothing is typed twice.
 */
export function useTabAction(bodyId: string): {
  act: (write: () => Promise<unknown>, receipt: Receipt) => Promise<boolean>;
  actInDialog: (write: () => Promise<unknown>, receipt: Receipt) => Promise<string | null>;
  attempt: (write: () => Promise<unknown>, receipt: Receipt, what: string) => Promise<PickOutcome>;
  sayRefused: (what: string) => (why: string) => void;
} {
  const { announce } = useUndo();
  // The console this tab mounted under (`currentBody`): a pressed write runs to its end against
  // `bodyId`; a refusal is said here while this console is on screen, else in a toast naming the
  // body; the receipt names its body wherever it shows.
  const hold = useBodyHold();
  // `landed`: the write landed. `refused`: the server's words, for this console to say in place;
  // `null` when it landed, or when it was refused off its console (`sendFor` said it in a toast).
  const run = useCallback(
    async (
      write: () => Promise<unknown>,
      receipt: Receipt,
      /** What it was, for a refusal said off its page; else the receipt's title. */
      what?: string,
    ): Promise<{ landed: boolean; refused: string | null }> => {
      try {
        const landed = await sendFor(hold, {
          body: bodyId,
          write,
          receipt: (subject) => announce({ ...receipt, subject }),
          what: what ?? (typeof receipt.title === 'string' ? receipt.title : 'The change'),
        });
        return { landed, refused: null };
      } catch (err) {
        // A whole-list write whose base moved: its queue re-applies it, so it goes back as it came.
        if (listChanged(err) !== null) throw err;
        return { landed: false, refused: err instanceof Error ? err.message : String(err) };
      }
    },
    [announce, hold, bodyId],
  );
  const actInDialog = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt): Promise<string | null> =>
      // A refusal off the console has no dialog left to show it: already said in its toast.
      (await run(write, receipt)).refused,
    [run],
  );
  const act = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt): Promise<boolean> => {
      const { landed, refused } = await run(write, receipt);
      if (refused !== null) toast({ title: 'Not saved', description: refused, tone: 'bad' });
      // Never `true` for a write refused off its console: a queue would take it as acknowledged.
      return landed;
    },
    [run],
  );
  // A press-to-save control's write (`useLatestPick`): its outcome in the store's one shape, saying
  // nothing itself — the store says a refusal to whoever is still there. Refused off its page,
  // `sendFor` has already said it, naming the body.
  const attempt = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt, what: string): Promise<PickOutcome> => {
      const { landed, refused } = await run(write, receipt, what);
      if (landed) return { landed: true };
      return refused !== null
        ? { landed: false, why: refused }
        : { landed: false, why: '', said: true };
    },
    [run],
  );
  // The page's words for a refusal no one who asked is still there to hear: a toast naming the body.
  const sayRefused = useCallback(
    (what: string) => (why: string) => sayNotSaved(hold, notSavedWhat(what, why)),
    [hold],
  );
  return useMemo(
    () => ({ act, actInDialog, attempt, sayRefused }),
    [act, actInDialog, attempt, sayRefused],
  );
}
