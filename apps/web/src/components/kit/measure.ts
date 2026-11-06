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

/**
 * The sRGB pixel a stack of CSS colors paints, bottom first, resolved in `scope`'s theme — so a
 * translucent token (a lift, a wash) is measured as it renders over its ground. Any color syntax
 * the browser parses (`oklch()`, `var(--line2)`) works: the canvas does the conversion.
 */
export function paintedRgb(scope: Element, layers: readonly string[]): [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Chromium always has a 2D context; the guard is for the type, not a case worth a test.
  /* v8 ignore next */
  if (ctx === null) throw new Error('No 2D canvas to measure color with.');
  for (const layer of layers) {
    ctx.fillStyle = computedColor(scope, layer);
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data.subarray(0, 3));
  return [r, g, b] as [number, number, number];
}

/** WCAG 2 contrast between two painted colors (each a stack, bottom first). */
export function contrastBetween(
  scope: Element,
  a: readonly string[],
  b: readonly string[],
): number {
  const la = luminance(paintedRgb(scope, a));
  const lb = luminance(paintedRgb(scope, b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A CSS color as the browser computes it in `scope`'s theme. */
export function computedColor(scope: Element, color: string): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  // A void element (an input) can't hold the probe; its parent shares its theme.
  const host = scope.matches(VOID) ? scope.parentElement : scope;
  // Stories measure rendered elements, which always have a parent; the guard is for the type.
  /* v8 ignore next */
  if (host === null) throw new Error('Measure a void element only once it is in the page.');
  host.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

const VOID = 'input, textarea, select, img, br, hr';

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
