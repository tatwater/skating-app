import { useCallback, useMemo } from 'react';

import { toast } from '@/components/kit/toast';

import { type Receipt, useUndo } from '../../shell/undo';
import { listChanged, sendFor, useBodyHold } from '../frame/currentBody';

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
} {
  const { announce } = useUndo();
  // The console this tab mounted under (`currentBody`): a pressed write runs to its end against
  // `bodyId`; a refusal is said here while this console is on screen, else in a toast naming the
  // body; the receipt names its body wherever it shows.
  const hold = useBodyHold();
  const actInDialog = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt): Promise<string | null> => {
      try {
        await sendFor(hold, {
          body: bodyId,
          write,
          receipt: (subject) => announce({ ...receipt, subject }),
          what: typeof receipt.title === 'string' ? receipt.title : 'The change',
        });
        return null;
      } catch (err) {
        // A whole-list write whose base moved: its queue re-applies it, so it goes back as it came.
        if (listChanged(err) !== null) throw err;
        return err instanceof Error ? err.message : String(err);
      }
    },
    [announce, hold, bodyId],
  );
  const act = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt): Promise<boolean> => {
      const refused = await actInDialog(write, receipt);
      if (refused !== null) toast({ title: 'Not saved', description: refused, tone: 'bad' });
      return refused === null;
    },
    [actInDialog],
  );
  return useMemo(() => ({ act, actInDialog }), [act, actInDialog]);
}
