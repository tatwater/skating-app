import { type RefObject, useEffect } from 'react';

/**
 * Where focus may go from the region and still come back: a dialog, a menu or a listbox opened
 * from it, all of which live in a portal outside the region.
 */
const OPENED_FROM_REGION = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * **A pending or settling action never drops the keyboard to the page.** Watches a region (the
 * inspector's panel): when the control that last had focus inside it is removed, hidden, or disabled (a
 * row that leaves once its write lands, a button that becomes another, a dialog or menu closing
 * onto a trigger that is gone) and focus has fallen to the page, focus goes back into the region —
 * so a keyboard reader is never left to find the tab again.
 *
 * Only a loss it caused is mended: focus moved elsewhere on purpose (a press outside the region,
 * even on something that takes no focus, or a link) clears the watch, and a dialog or menu opened
 * from the region keeps it (focus returns from there). Where a tab knows the one right place to
 * return to (Links' Edit, a drop's grip), it puts focus there itself; this is the floor under every
 * tab.
 */
export function useKeepFocus(region: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = region.current;
    if (root === null) return;
    let last: HTMLElement | null = null;
    const gone = (el: HTMLElement) =>
      !el.isConnected ||
      (el as HTMLButtonElement).disabled === true ||
      el.closest('[hidden], [inert]') !== null;
    const rescue = () => {
      const active = document.activeElement;
      if (last === null || (active !== null && active !== document.body)) return;
      if (!gone(last)) return;
      last = null;
      root.focus({ preventScroll: true });
    };
    // Outside the region, and not in a dialog or menu opened from it (where the watch holds).
    const away = (target: Element) =>
      !root.contains(target) && target.closest(OPENED_FROM_REGION) === null;
    const onIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (root.contains(target)) last = target;
      // Focus taken elsewhere on purpose ends the watch; a dialog or menu opened from here keeps it.
      else if (away(target)) last = null;
    };
    // A press outside the region on something that takes no focus moves no focus to hear, but is
    // as much a choice to leave: it ends the watch too — unless a dialog or menu holds focus (a
    // press on its backdrop closes it, and focus returns from there).
    const onPress = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !away(event.target)) return;
      const active = document.activeElement;
      if (active !== null && active.closest(OPENED_FROM_REGION) !== null) return;
      last = null;
    };
    // Nothing is watched while nothing in the region has had focus: no timer for the page's churn.
    const later = () => {
      if (last !== null) setTimeout(rescue, 0);
    };
    const watch = new MutationObserver(later);
    // The whole page, not only the region: a dialog opened from the region lives in a portal, and
    // when it closes onto a trigger that is gone, focus falls to the page with no event to hear.
    watch.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'inert'],
    });
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', later, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      watch.disconnect();
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', later, true);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [region]);
}
