import { type RefObject, useEffect } from 'react';

/**
 * **A pending or settling action never drops the keyboard to the page.** Watches a region (the
 * inspector's panel): when the control that last had focus inside it is removed or disabled (a
 * row that leaves once its write lands, a button that becomes another, a dialog closing onto a
 * trigger that is gone) and focus has fallen to the page, focus goes back into the region — so a
 * keyboard reader is never left to find the tab again.
 *
 * Only a loss it caused is mended: focus moved elsewhere on purpose (a press outside the region, a
 * link) clears the watch, and a dialog opened from the region keeps it (focus returns from there).
 * Where a tab knows the one right place to return to (Links' Edit, a drop's grip), it puts focus
 * there itself; this is the floor under every tab.
 */
export function useKeepFocus(region: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = region.current;
    if (root === null) return;
    let last: HTMLElement | null = null;
    const gone = (el: HTMLElement) =>
      !el.isConnected ||
      (el as HTMLButtonElement).disabled === true ||
      el.closest('[inert]') !== null;
    const rescue = () => {
      const active = document.activeElement;
      if (last === null || (active !== null && active !== document.body)) return;
      if (!gone(last)) return;
      last = null;
      root.focus({ preventScroll: true });
    };
    const onIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (root.contains(target)) last = target;
      // Focus taken elsewhere on purpose ends the watch; a dialog opened from here keeps it.
      else if (target.closest('[role="dialog"],[role="alertdialog"]') === null) last = null;
    };
    const later = () => setTimeout(rescue, 0);
    const watch = new MutationObserver(later);
    // The whole page, not only the region: a dialog opened from the region lives in a portal, and
    // when it closes onto a trigger that is gone, focus falls to the page with no event to hear.
    watch.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'inert'],
    });
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', later, true);
    return () => {
      watch.disconnect();
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', later, true);
    };
  }, [region]);
}
