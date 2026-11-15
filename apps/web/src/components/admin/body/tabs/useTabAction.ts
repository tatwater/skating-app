import { useCallback, useMemo } from 'react';

import { toast } from '@/components/kit/toast';

import { type Receipt, useUndo } from '../../shell/undo';
import { sendFor, useBodyBound } from '../frame/currentBody';

/**
 * How the Body console's tabs run a write: the mutation, then the receipt toast with Undo while the
 * server offers one (the shell's `announce`, D226). Shared by Names, Places, Access and Water.
 *
 * - **`act`**, from a button: a refusal is a red toast in the server's own words; resolves `true`
 *   when the write landed.
 * - **`actInDialog`**, from a reason dialog: a refusal comes back as the server's words for the
 *   dialog to show over the kept reason (`null` when it landed), so nothing is typed twice.
 */
export function useTabAction(): {
  act: (write: () => Promise<unknown>, receipt: Receipt) => Promise<boolean>;
  actInDialog: (write: () => Promise<unknown>, receipt: Receipt) => Promise<string | null>;
} {
  const { announce } = useUndo();
  // The console this tab mounted under (`currentBody`): nothing is sent once it has gone, and a
  // refusal or receipt landing after is dropped.
  const here = useBodyBound();
  const actInDialog = useCallback(
    async (write: () => Promise<unknown>, receipt: Receipt): Promise<string | null> => {
      // The one bound write (`sendFor`): nothing sent once the console has gone; a refusal comes
      // back (in the server's words) only while it is here; the receipt only then too, and its
      // failure is never a refusal — never a rejection that leaves a reason dialog waiting.
      try {
        await sendFor(here, write, () => announce(receipt));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [announce, here],
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
