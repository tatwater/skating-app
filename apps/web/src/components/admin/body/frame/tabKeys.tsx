import { createContext, type ReactNode, type RefObject, useContext } from 'react';

import { type PaneBinding, usePaneKeys } from '@/lib/keys';

/**
 * **A tab's keys work wherever focus lands when the tab is reached.** The rule, decided once: a
 * tab's single-letter keys listen on the whole inspector — the tab strip and the panel under it —
 * not on the tab's own root. However the tab is reached, focus is somewhere in the inspector:
 *
 * - by a press or the arrow keys on the tab strip: on the tab's trigger;
 * - by an ask on the left: on the panel (the console moves it there);
 * - by the list's Open or a deep link: on the panel (the console moves focus there on arrival
 *   when nothing else holds it).
 *
 * Outside the console (a story, a test of the tab alone) there is no inspector, and the keys listen
 * on the tab's own root.
 */

const TabKeysScope = createContext<RefObject<HTMLElement | null> | null>(null);

export function TabKeysProvider({
  inspector,
  children,
}: {
  inspector: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return <TabKeysScope.Provider value={inspector}>{children}</TabKeysScope.Provider>;
}

/** A tab's keys: on the inspector inside the console, on `own` outside it. */
export function useTabKeys(own: RefObject<HTMLElement | null>, bindings: readonly PaneBinding[]) {
  const inspector = useContext(TabKeysScope);
  usePaneKeys(inspector ?? own, bindings);
}
