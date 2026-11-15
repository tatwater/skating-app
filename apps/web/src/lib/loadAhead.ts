import { type RefObject, useCallback, useEffect } from 'react';

/**
 * **When a scrolling list may ask for its next page** — one rule for every list that pages as it
 * scrolls: only while it is in sight and measured. A list out of sight (a pane a narrow screen hid,
 * a closed or collapsed section, a tab in the background) or not yet laid out measures a zero-height
 * viewport, which reads as "near the end" for every page — so without this rule it would page in
 * the whole list behind the operator's back. It asks again the moment it comes into sight: when its
 * viewport takes a size, and when the browser tab comes back.
 */

/** Ask for the next page this far (px) from the end. */
export const LOAD_AHEAD_PX = 640;

/**
 * Whether `el`'s list is near enough its end to ask for more — and may ask: in sight (the document
 * visible) and measured (a viewport with height).
 */
export function mayLoadAhead(el: HTMLElement | null, ahead = LOAD_AHEAD_PX): boolean {
  if (el === null) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (!(el.clientHeight > 0)) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight < ahead;
}

/**
 * A scrolling list's one trigger for its next page. `enabled` is the list's own say (more to come,
 * none on its way, not paused); the rule above is the rest. Returns the check, for the list's
 * scroll handler; it also runs whenever `changed` changes (a page landed), when the viewport takes a
 * size, and when the tab comes back.
 */
export function useLoadAhead(
  scroller: RefObject<HTMLElement | null>,
  enabled: boolean,
  onLoadMore: (() => void) | undefined,
  changed: unknown,
): () => void {
  const check = useCallback(() => {
    if (!enabled || onLoadMore === undefined) return;
    if (mayLoadAhead(scroller.current)) onLoadMore();
  }, [enabled, onLoadMore, scroller]);

  // A page landed, or the list's say changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checked whenever a page lands.
  useEffect(check, [check, changed]);

  // Into sight: the viewport takes a size (a pane shown, a section opened), or the tab comes back.
  useEffect(() => {
    const el = scroller.current;
    const observer = el === null ? null : new ResizeObserver(() => check());
    if (el !== null) observer?.observe(el);
    document.addEventListener('visibilitychange', check);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, [scroller, check]);

  return check;
}
