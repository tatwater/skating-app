import { createContext, type ReactNode, type RefObject, useContext } from 'react';

/**
 * What the inspector column hands every frame and handler drawn in it, so `InspectorFrame` keeps
 * the canonical props (head, actions, locked, children) and a handler needs nothing but its item:
 *
 * - **`pane`** — the inspector's own element. A handler binds its single-letter action keys to it
 *   (`usePaneKeys(useInspectorPane(), …)`), so a key acts only while the inspector has focus and
 *   typing in the list never fires one.
 * - **`onBack`** — back to the list (the lock's *Back to the queue*, ⏎ while locked; ⇧⏎ anywhere in
 *   the inspector is the column's own key).
 * - **`history`** — the item's *History →*, already drawn for its kind (a live link, or *Coming soon*
 *   where it names a mode not built yet, D286); the lock shows it.
 * - **`decidedOnOpen`** — the item was already decided when it opened (the Decided lane, a tail row):
 *   the lock is a record, shown whoever decided it. Decided *while* open, the viewer's own decision
 *   clears quietly (they know, D283); a colleague's locks with the banner.
 * - **`now`** and **`timeZone`** — the clock and zone the lock's time is read in.
 *
 * Outside a provider (a handler's own story) every field takes a harmless default: no way back is
 * drawn, keys bind to nothing, the clock is the story's.
 */
export type InspectorContextValue = {
  pane: RefObject<HTMLElement | null>;
  onBack?: (() => void) | undefined;
  history?: ReactNode;
  decidedOnOpen: boolean;
  now: number;
  timeZone?: string | undefined;
};

const NO_PANE: RefObject<HTMLElement | null> = { current: null };

const InspectorContext = createContext<InspectorContextValue | null>(null);

export function InspectorProvider({
  value,
  children,
}: {
  value: InspectorContextValue;
  children: ReactNode;
}) {
  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

/** The inspector's context, or the defaults a frame drawn alone takes. */
export function useInspectorContext(): InspectorContextValue {
  return (
    useContext(InspectorContext) ?? {
      pane: NO_PANE,
      decidedOnOpen: false,
      now: Date.now(),
    }
  );
}

/** The inspector's element — what a handler binds its action keys to. */
export function useInspectorPane(): RefObject<HTMLElement | null> {
  return useInspectorContext().pane;
}
