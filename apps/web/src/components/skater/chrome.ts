import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect } from 'react';

import { focusOwnsPrintableKeys } from '@/lib/keys';
import { type ChromeOverlay, useChromeStore } from '@/stores/chromeStore';

/**
 * The top bar's shared mechanics: one overlay at a time, one Esc per screen, `/` for search, and
 * links that route in-app on a plain click but still open in a new tab on a modified one.
 *
 * `useChromeStore` is the single source for which overlay is open (search, notifications, the
 * avatar menu). Each overlay's Base UI root is controlled from it, so opening one closes the other
 * and "the outermost open thing" is always well-defined.
 */

/** An overlay's controlled `open` and the `onOpenChange` its Base UI root calls. */
export function useChromeOverlay(kind: ChromeOverlay): {
  open: boolean;
  onOpenChange: (next: boolean) => void;
} {
  const open = useChromeStore((s) => s.overlay === kind);
  const onOpenChange = useCallback(
    (next: boolean) => {
      const { overlay, setOverlay } = useChromeStore.getState();
      if (next) setOverlay(kind);
      // A close only closes *this* overlay: pressing the avatar while the bell's plate is open
      // reports the plate's outside-press after the menu has already claimed the store.
      else if (overlay === kind) setOverlay(null);
    },
    [kind],
  );
  return { open, onOpenChange };
}

/**
 * A modal surface the top bar must not open search over: a dialog, an alert dialog, or a sheet
 * (the New report sheet is a dialog). The bell's own plate is a dialog too, but it's chrome — `/`
 * from inside it moves to search, as the one-overlay rule says.
 */
export function blockingModalOpen(root: ParentNode = document): boolean {
  return (
    root.querySelector(
      '[role="dialog"]:not([data-slot="popover-content"]),[role="alertdialog"],[data-slot="sheet-content"]',
    ) !== null
  );
}

/**
 * The shell's two keys, on `window` in the capture phase so they run before anything on the page:
 *
 * - **Esc** closes the open overlay and stops there — an inset card or sheet under the overlay
 *   never sees that Esc, which is what "one Esc per screen" means. With no overlay open, Esc
 *   passes through untouched to whatever owns it.
 * - **`/`** opens search from any page, unless focus is typing (a field, or a composite with its own
 *   type-ahead), a modifier is held, or a modal is open over the page.
 */
export function useChromeKeys(onOpenSearch: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const { overlay, setOverlay } = useChromeStore.getState();
        if (overlay === null) return;
        event.preventDefault();
        event.stopPropagation();
        setOverlay(null);
        return;
      }
      if (event.key !== '/' || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (focusOwnsPrintableKeys() || blockingModalOpen()) return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onOpenSearch]);
}

/** A press the browser should handle itself: a modifier, a middle click, or a `target` link. */
export function isPlainLeftClick(event: ReactMouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.currentTarget.getAttribute('target');
  return target === null || target === '_self';
}

/**
 * The props for an in-app link: a real `href` (so open-in-new-tab and copy-link work) and a click
 * that hands a plain press to the router instead of reloading the document.
 */
export function navLinkProps(
  href: string,
  onNavigate: (href: string) => void,
): { href: string; onClick: (event: ReactMouseEvent<HTMLElement>) => void } {
  return {
    href,
    onClick: (event) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      onNavigate(href);
    },
  };
}

/** Which top-level page a path belongs to, for the top bar's lit link. */
export function activeTopLevel(pathname: string): 'explore' | 'latest' | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (path === '/' || /^\/(water|report|hazard|bounty)\/[^/]+$/.test(path)) return 'explore';
  if (path === '/latest' || path === '/feed') return 'latest';
  return null;
}

/**
 * The current URL with `?post=new` added, keeping every other param: the New report sheet opens
 * over whatever page it was asked from (D242), so the page underneath stays where it was.
 */
export function withNewReport(pathname: string, search: string, postBody?: string): string {
  const params = new URLSearchParams(search);
  params.set('post', 'new');
  if (postBody !== undefined) params.set('postBody', postBody);
  else params.delete('postBody');
  return `${pathname}?${params.toString()}`;
}
