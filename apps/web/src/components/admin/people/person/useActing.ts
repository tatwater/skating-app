import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Asker } from '../../body/tabs/latestPick';
import { drawn } from '../../place';

import type { PersonAction } from './levers';
import { WORDS } from './personWords';

/**
 * The page's side of a write: which control is busy, the server's refusal in its place, and focus
 * kept where the operator was.
 *
 * - **Optimistic nothing.** The page waits for the server; the reads move by themselves once the
 *   write lands (Convex is reactive), so nothing is refetched by hand.
 * - **Busy keeps the control.** The pressed button stays mounted and focusable while it spins
 *   (`aria-disabled`, never unmounted) — the kit `Button`'s `loading`.
 * - **Focus stays in its region.** When the write settles, focus goes back to whatever held it
 *   before (the button, or a dialog's trigger); if that is gone, to the same lever's button, else to
 *   the block itself — never to the page.
 */
export function useActing(onAct: (action: PersonAction, asker?: Asker) => Promise<string | null>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Readonly<Record<string, string>>>({});
  const running = useRef<string | null>(null);
  /** Controls told "another change is on its way": their note goes when that change settles. */
  const held = useRef(new Set<string>());
  // The page that asked: while it is mounted a refusal is said in its place (the control, or the
  // dialog over it); once it has gone, the write path says it in a toast naming the person.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const act = useCallback(
    async (
      id: string,
      action: PersonAction,
      opts: { region: HTMLElement | null; inline: boolean },
    ): Promise<string | null> => {
      if (running.current !== null) {
        const wait = WORDS.anotherOnItsWay;
        if (opts.inline) {
          held.current.add(id);
          setRefusals((r) => ({ ...r, [id]: wait }));
        }
        return wait;
      }
      running.current = id;
      const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setBusy(id);
      setRefusals(({ [id]: _gone, ...rest }) => rest);
      let refused: string | null;
      try {
        // Its place: the lever's block, drawn when the answer comes — a page that stays mounted
        // but stops drawing it (another person's read, a permission gone) has none.
        refused = await onAct(action, {
          here: () => mounted.current && (opts.region === null || drawn(opts.region)),
        });
      } catch {
        refused = WORDS.somethingWrong;
      }
      running.current = null;
      setBusy(null);
      const waited = [...held.current];
      held.current.clear();
      setRefusals((r) => {
        const next = { ...r };
        for (const w of waited) delete next[w];
        if (refused !== null && opts.inline) next[id] = refused;
        return next;
      });
      // After the commit the settled state draws: put focus back inside the region — unless a
      // dialog refused, which stays open with the refusal and keeps its own focus.
      if (refused === null || opts.inline) {
        requestAnimationFrame(() => keepFocus(opts.region, before, id));
      }
      return refused;
    },
    [onAct],
  );

  return { busy, refusals, act };
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
