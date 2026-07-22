import { createContext, useContext } from 'react';

/**
 * A tiny bus that lets a detail drawer's *content* scroll its enclosing `BottomSheetScrollView`.
 *
 * The scroll view lives in `MapDrawer`, but the content renders through Expo Router's `<Slot />`, so
 * a child like `HazardDetail` can't reach the scroll ref by props. `MapDrawer` provides `scrollToY`;
 * a child measures a target (via `onLayout`) and asks the drawer to bring it into view — which is how
 * the `?action=confirm` deep link (D54 Layer 2) lands on the confirm control even when it's below the
 * fold. The default is a no-op so a component rendered outside a drawer (e.g. a test) is inert.
 */
export const DrawerScrollContext = createContext<{
  /** Scroll the drawer so content offset `y` (in the scroll view's content coordinates) is near the top. */
  scrollToY: (y: number) => void;
}>({ scrollToY: () => {} });

export function useDrawerScroll() {
  return useContext(DrawerScrollContext);
}
