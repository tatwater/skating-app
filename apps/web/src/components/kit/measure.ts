/**
 * Storybook-as-instrument (D234): helpers a story's `play` function uses to measure junctions —
 * the distance from one piece of *content* to the next, not box to box — in a real layout engine
 * (the Vitest addon runs stories in Chromium).
 */

/** Resolve a CSS length (`var(--gap-hit-y)`, `0.75rem`) to px in `scope`'s theme. */
export function resolvePx(scope: Element, length: string): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;width:0;height:${length}`;
  scope.append(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

/**
 * The rectangle of what an element *shows*: a kit button's label (its padding and hit area are
 * not content), anything else's own box.
 */
export function contentRect(el: Element): DOMRect {
  const label = el.matches('[data-slot="button"]')
    ? el.querySelector(':scope > [data-slot="label"]')
    : null;
  return (label ?? el).getBoundingClientRect();
}

/** Vertical gap between consecutive elements' content: next top − previous bottom. */
export function verticalGaps(els: readonly Element[]): number[] {
  const rects = els.map(contentRect);
  return pairs(rects).map(([prev, next]) => next.top - prev.bottom);
}

/** Horizontal gap between consecutive elements' boxes: next left − previous right. */
export function horizontalGaps(els: readonly Element[]): number[] {
  const rects = els.map((el) => el.getBoundingClientRect());
  return pairs(rects).map(([prev, next]) => next.left - prev.right);
}

/** Each element with the one after it. */
function pairs<T>(items: readonly T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 1; i < items.length; i++) out.push([items[i - 1] as T, items[i] as T]);
  return out;
}

/** Sub-pixel layout rounds; a junction is right when it's within a quarter pixel. */
export const JUNCTION_TOLERANCE_PX = 0.25;
