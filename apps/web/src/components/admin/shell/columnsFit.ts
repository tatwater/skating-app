import { type FocusEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';

/**
 * **The console's one rule for a narrow screen**: a mode laid out as columns keeps them while their
 * token widths fit side by side, and below that becomes master–detail — the open record takes the
 * page (with a way back), and with none open the list does. Nothing scrolls sideways.
 *
 * Whether they fit is measured on the mode's own box against the columns' size tokens (each read
 * from the element, so a surface's density moves it), never a breakpoint of its own. Until it is
 * measured, and on the server, the columns are assumed to fit — the board's layout renders first.
 *
 * Read by People and the Bodies library. The Body console lays out its own columns and adopts this
 * in its own pass (the phase doc's *Owed*).
 */
export function useColumnsFit(
  ref: RefObject<HTMLElement | null>,
  /** The columns' width tokens (`--size-lanes`…), in rem. */
  tokens: readonly string[],
): boolean {
  const [fits, setFits] = useState(true);
  const key = tokens.join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the tokens' names, by value.
  useLayoutEffect(() => {
    const el = ref.current;
    // (The ref is set before layout effects run; the guard is for the type.)
    /* v8 ignore next */
    if (el === null) return;
    const check = () => {
      const style = getComputedStyle(el);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const needs = tokens.reduce((sum, t) => sum + parseFloat(style.getPropertyValue(t)) * rem, 0);
      const width = el.getBoundingClientRect().width;
      // A token that hasn't resolved (a test page, a frame not yet styled) measures as fitting.
      setFits(!Number.isFinite(needs) || width === 0 || width >= needs);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return fits;
}

/** Which panes a master–detail page has on screen: all, or — narrow — the list or the open record. */
export type PanesShown = 'all' | 'list' | 'detail';

/**
 * **Focus under the narrow rule** — one answer for every page that reads {@link useColumnsFit}. A
 * pane the rule hides takes no focus with it, however it went — the page's way back, the browser's,
 * a row opened from the keys or a press, a resize: focus that sat in it (or on a control that went
 * with it) moves to the pane now on screen, never to the page. With the columns side by side, a
 * record closed some other way than its way back (the browser's back, a link) takes the control
 * that held focus with it: focus goes back to the list. Focus that left the page is never pulled back.
 *
 * Spread `pageProps` on the page; call `askBack()` before closing the record from its way back, so
 * focus lands on the list once it is drawn. The record's pane is `[data-pane="<detailPane>"]`, a
 * direct child of the page; the list's panes are `lanes` and `middle`.
 */
export function usePaneFocus({
  page,
  shown,
  open,
  focusList,
  detailPane,
}: {
  page: RefObject<HTMLElement | null>;
  shown: PanesShown;
  /** A record is open. */
  open: boolean;
  focusList: () => void;
  detailPane: string;
}): {
  pageProps: {
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  askBack: () => void;
} {
  // Where focus last sat in the page, kept when it went nowhere (its control hidden or gone).
  const held = useRef<HTMLElement | null>(null);
  const backAsked = useRef(false);
  const toList = useRef(focusList);
  toList.current = focusList;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the panes on screen change.
  useLayoutEffect(() => {
    const asked = backAsked.current && shown === 'list';
    backAsked.current = false;
    const active = document.activeElement;
    const nowhere = active === null || active === document.body;
    const from = held.current;
    if (shown === 'all') {
      if (!open && nowhere && from !== null && !from.isConnected) toList.current();
      return;
    }
    const hidden = (el: Element | null) => {
      const pane = el?.closest<HTMLElement>('[data-pane]')?.dataset.pane;
      return shown === 'detail' ? pane === 'lanes' || pane === 'middle' : pane === detailPane;
    };
    const lost = nowhere
      ? from !== null && (!from.isConnected || hidden(from))
      : page.current?.contains(active) === true && hidden(active);
    if (!asked && !lost) return;
    if (shown === 'list') toList.current();
    else
      page.current
        ?.querySelector<HTMLElement>(`:scope > [data-pane="${detailPane}"]`)
        ?.focus({ preventScroll: true });
  }, [shown, open]);
  return {
    pageProps: {
      onFocus: (event) => {
        held.current = event.target as HTMLElement;
      },
      onBlur: (event) => {
        // Focus moved on out of the page: nothing to keep. Taken out from under focus (hidden or
        // unmounted), it goes nowhere (`relatedTarget` is null) and stays held for the effect above.
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) held.current = null;
      },
    },
    askBack: () => {
      backAsked.current = true;
    },
  };
}
