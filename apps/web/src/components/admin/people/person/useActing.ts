import { useCallback, useRef, useState } from 'react';

import type { PersonAction } from './levers';

/**
 * What a press came to: landed; refused — said in its toast, naming the person (D268); or not sent,
 * because another change is still on its way (`waiting`, the page's own note — never a server's).
 */
export type ActOutcome = 'landed' | 'refused' | 'waiting';

/**
 * The page's side of a write: which control is busy, the page's own note for a press that waited,
 * and focus kept where the operator was.
 *
 * - **Optimistic nothing.** The page waits for the server; the reads move by themselves once the
 *   write lands (Convex is reactive), so nothing is refetched by hand.
 * - **A refusal is a toast** naming the person, said by the write path wherever the moderator is
 *   when it comes; nothing is printed in the lever's place, and a dialog stays open over its reason.
 * - **Busy keeps the control.** The pressed button stays mounted and focusable while it spins
 *   (`aria-disabled`, never unmounted) — the kit `Button`'s `loading`.
 * - **Focus stays in its region.** When the write settles, focus goes back to whatever held it
 *   before (the button, or a dialog's trigger); if that is gone, to the same lever's button, else to
 *   the block itself — never to the page.
 */
export function useActing(onAct: (action: PersonAction) => Promise<boolean>) {
  const [busy, setBusy] = useState<string | null>(null);
  /** Controls told "another change is on its way": the page's note, gone when that change settles. */
  const [waits, setWaits] = useState<ReadonlySet<string>>(new Set());
  const running = useRef<string | null>(null);

  const act = useCallback(
    async (
      id: string,
      action: PersonAction,
      opts: { region: HTMLElement | null; inline: boolean },
    ): Promise<ActOutcome> => {
      if (running.current !== null) {
        if (opts.inline) setWaits((w) => new Set(w).add(id));
        return 'waiting';
      }
      running.current = id;
      const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setBusy(id);
      let landed: boolean;
      try {
        landed = await onAct(action);
      } catch {
        // The write path says every refusal itself; a throw past it changed nothing.
        landed = false;
      }
      running.current = null;
      setBusy(null);
      setWaits(new Set());
      // After the commit the settled state draws: put focus back inside the region — unless a
      // dialog was refused, which stays open and keeps its own focus.
      if (landed || opts.inline) {
        requestAnimationFrame(() => keepFocus(opts.region, before, id));
      }
      return landed ? 'landed' : 'refused';
    },
    [onAct],
  );

  return { busy, waits, act };
}

/** Focus back to `before` if it is still on the page; else the lever's button; else the block. */
export function keepFocus(
  region: HTMLElement | null,
  before: HTMLElement | null,
  id: string,
): void {
  if (region === null) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && region.contains(active)) return;
  if (before?.isConnected && region.contains(before)) {
    before.focus();
    return;
  }
  const button = region.querySelector<HTMLElement>(`[data-lever-button="${id}"]`);
  if (button !== null) {
    button.focus();
    return;
  }
  region.focus();
}
