import type { PostDraft, PostSheet } from '@skating/core';
import { useCallback, useRef, useState } from 'react';

import { useSignOut } from '@/lib/sheetOwner';
import { readStoredSheet, useSheet, useSheetAttempt } from '@/lib/sheetStore';
import { askOtherTabs } from '@/lib/unsavedElsewhere';

import {
  type SignOutDialogProps,
  type SignOutRisk,
  type UnsentDraft,
  unsentDraft,
} from './SignOutGuard';

/**
 * The open sheet if this page holds one, else the stored copy a reload left for this account —
 * signing out from Settings after a refresh still has a draft to lose.
 */
function currentDraft(sheet: PostSheet | null, attempt: PostDraft | null): UnsentDraft | null {
  if (sheet !== null) return unsentDraft(sheet, attempt);
  const stored = readStoredSheet(Date.now());
  return stored === null ? null : unsentDraft(stored.sheet, stored.attempt);
}

/**
 * Sign out, asking first when a draft would go with it — this tab's, the stored one, or another
 * tab's (`askOtherTabs`: an edit of a published report lives only in its tab's memory, and the
 * session ending takes it there too). `request` signs out once nothing would be lost — after the
 * other tabs' bounded wait — and otherwise opens the confirm, whose props are `dialog`. `onFailed` hears that
 * Clerk didn't answer (the console says so in a toast; the skater app passes nothing, as before).
 */
export function useGuardedSignOut({ onFailed }: { onFailed?: () => void } = {}): {
  request: () => void;
  open: boolean;
  dialog: Omit<SignOutDialogProps, 'onOpenDraft'>;
} {
  const signOut = useSignOut();
  const sheet = useSheet();
  const attempt = useSheetAttempt();
  const [draft, setDraft] = useState<SignOutRisk | null>(null);
  /** An ask of the other tabs is out: a second press waits for it, never asks twice. */
  const asking = useRef(false);
  const [busy, setBusy] = useState(false);

  const out = useCallback(async () => {
    setBusy(true);
    try {
      await signOut();
    } catch {
      // Clerk didn't answer: still signed in, the draft still here; the button can be pressed again.
      onFailed?.();
    } finally {
      setBusy(false);
    }
  }, [signOut, onFailed]);

  const request = useCallback(() => {
    const found = currentDraft(sheet, attempt);
    if (found !== null) {
      setDraft(found);
      return;
    }
    if (asking.current) return;
    asking.current = true;
    void askOtherTabs().then((answer) => {
      asking.current = false;
      if (answer === 'none') void out();
      else setDraft({ elsewhere: answer });
    });
  }, [sheet, attempt, out]);

  return {
    request,
    open: draft !== null,
    dialog: {
      draft,
      busy,
      onOpenChange: (open) => {
        if (!open) setDraft(null);
      },
      onSignOut: () => void out(),
    },
  };
}
