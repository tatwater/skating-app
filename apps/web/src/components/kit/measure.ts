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

/**
 * Colors are compared as colors, never as strings. Chromium serializes a computed color in the
 * form it was specified (`oklch(0.6713 0.2164 22.08)`) at rest, but in its interpolation space
 * (`oklab(0.6713 0.200529 0.0813449)`) while a transition runs or has just run, and the form
 * varies by version. Two colors match when they're within `COLOR_TOLERANCE` in OKLab (ΔE_OK) and
 * alpha. That's a quarter of a just-noticeable difference (~0.02): far above serialization
 * rounding (~1e-5) and an 8-bit step (~0.003), far below a wrong token or a half-done transition.
 */
export const COLOR_TOLERANCE = 0.005;

/** A color in OKLab, with its alpha. */
type Oklab = { l: number; a: number; b: number; alpha: number };

/** ΔE_OK between two computed CSS colors (or the alpha gap, when that's larger). */
export function colorDistance(x: string, y: string): number {
  const p = toOklab(x);
  const q = toOklab(y);
  // Two fully transparent colors are the same paint whatever their channels say.
  if (p.alpha < COLOR_TOLERANCE && q.alpha < COLOR_TOLERANCE) return 0;
  return Math.max(Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b), Math.abs(p.alpha - q.alpha));
}

/** What `expect` needs to treat a value as an asymmetric matcher (and print it as one). */
type ColorMatcher = {
  $$typeof: symbol;
  [inspect: symbol]: unknown;
  asymmetricMatch: (actual: unknown) => boolean;
  toString: () => string;
  toAsymmetricMatcher: () => string;
};

/**
 * Matches any serialization of `expected` (a computed color, e.g. from `computedColor`), inside
 * `toEqual` — on its own, in an array, or in `toContainEqual`:
 * `expect(getComputedStyle(el).color).toEqual(sameColor(computedColor(el, 'var(--bad)')))`.
 */
export function sameColor(expected: string): ColorMatcher {
  toOklab(expected); // a color the parser can't read fails here, where the story names it
  const label = `sameColor(${expected})`;
  return {
    $$typeof: Symbol.for('jest.asymmetricMatcher'),
    asymmetricMatch: (actual) =>
      typeof actual === 'string' && colorDistance(actual, expected) <= COLOR_TOLERANCE,
    toString: () => label,
    toAsymmetricMatcher: () => label,
    // How chai's messages print it ("expected 'oklch(…)' to deeply equal sameColor(…)").
    [Symbol.for('chai/inspect')]: () => label,
  };
}

/** The colors in a computed value that holds several (`box-shadow`, a gradient), in order. */
export function colorsIn(value: string): string[] {
  return value.match(/(?:rgba?|oklch|oklab|color)\([^()]*\)/g) ?? [];
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?$/i;

/** A channel: a number, a percentage of `percentOf`, or `none` (zero). */
function channel(token: string | undefined, percentOf: number): number {
  if (token === undefined || token === 'none') return 0;
  if (!NUMBER.test(token)) throw new Error(`Not a color channel: ${token}`);
  return token.endsWith('%') ? (parseFloat(token) / 100) * percentOf : parseFloat(token);
}

/**
 * A computed CSS color in OKLab. Reads the forms Chromium computes: `rgb()`/`rgba()`, `oklch()`,
 * `oklab()` and `color(srgb | srgb-linear …)`. Anything else throws, so a new serialization fails
 * loudly instead of comparing wrong.
 */
function toOklab(css: string): Oklab {
  // Chromium computes every property to the empty string on an element that has left the page, so
  // say that rather than report an unreadable color: the measurement held a node too long.
  if (css === '') throw new Error('No computed color: the element is not in the page.');
  const m = /^\s*([a-z-]+)\(([^()]*)\)\s*$/i.exec(css);
  if (m === null) throw new Error(`Not a computed color: ${css}`);
  const fn = (m[1] as string).toLowerCase();
  const [main, slash] = (m[2] as string).split('/');
  const parts = (main as string).split(/[\s,]+/).filter(Boolean);
  // The legacy form puts alpha fourth, after a comma.
  const alphaToken = slash?.trim() ?? (fn === 'rgba' || fn === 'rgb' ? parts[3] : undefined);
  const alpha = alphaToken === undefined ? 1 : channel(alphaToken, 1);
  if (fn === 'oklab') {
    return {
      l: channel(parts[0], 1),
      a: channel(parts[1], 0.4),
      b: channel(parts[2], 0.4),
      alpha,
    };
  }
  if (fn === 'oklch') {
    const c = channel(parts[1], 0.4);
    const h = (channel(parts[2], 1) * Math.PI) / 180;
    return { l: channel(parts[0], 1), a: c * Math.cos(h), b: c * Math.sin(h), alpha };
  }
  if (fn === 'rgb' || fn === 'rgba') {
    const [r, g, b] = [0, 1, 2].map((i) => decode(channel(parts[i], 255) / 255));
    return { ...linearToOklab(r as number, g as number, b as number), alpha };
  }
  if (fn === 'color') {
    const space = parts.shift();
    const [r, g, b] = [0, 1, 2].map((i) => channel(parts[i], 1));
    if (space === 'srgb') {
      return {
        ...linearToOklab(decode(r as number), decode(g as number), decode(b as number)),
        alpha,
      };
    }
    if (space === 'srgb-linear') {
      return { ...linearToOklab(r as number, g as number, b as number), alpha };
    }
  }
  throw new Error(`A color form the comparison can't read yet: ${css}`);
}

/** The sRGB transfer function, inverted (sign-kept, for out-of-gamut channels). */
function decode(c: number): number {
  const s = Math.abs(c);
  const lin = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  return Math.sign(c) * lin;
}

/** Linear sRGB → OKLab (Björn Ottosson's matrices, as CSS Color 4 uses them). */
function linearToOklab(r: number, g: number, b: number): Omit<Oklab, 'alpha'> {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
