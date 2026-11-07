import { useLayoutEffect } from 'react';

/**
 * Puts `data-surface="skater"` on `<html>` while a skater screen is mounted. The token sheet
 * resolves its maps on `:root` only (`:root[data-surface][data-mode]`), so the attribute on a
 * nested element changes nothing — and Base UI's portals (every popover, menu and tooltip) render
 * under `<body>`, where only the root's attribute reaches them. The previous value comes back on
 * unmount, so a screen that hands over to another surface leaves it as it found it.
 *
 * This is the floor, not the first paint: the server render has no attribute until hydration, so
 * the root document should state the surface too (a seam request).
 */
export function useSkaterSurface(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-surface');
    root.setAttribute('data-surface', 'skater');
    return () => {
      if (previous === null) root.removeAttribute('data-surface');
      else root.setAttribute('data-surface', previous);
    };
  }, []);
}
