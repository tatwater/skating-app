import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * **The console's one rule for a narrow screen**: a mode laid out as columns keeps them while their
 * token widths fit side by side, and below that becomes master–detail — the open record takes the
 * page (with a way back), and with none open the list does. Nothing scrolls sideways.
 *
 * Whether they fit is measured on the mode's own box against the columns' size tokens (each read
 * from the element, so a surface's density moves it), never a breakpoint of its own. Until it is
 * measured, and on the server, the columns are assumed to fit — the board's layout renders first.
 *
 * Read by People. The Bodies library and the Body console lay out their own columns and adopt this
 * once their open pull requests land (the phase doc's *Owed*).
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
