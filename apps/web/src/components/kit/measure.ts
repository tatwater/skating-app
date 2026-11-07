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
type AsymmetricMatcher = {
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
export function sameColor(expected: string): AsymmetricMatcher {
  toOklab(expected); // a color the parser can't read fails here, where the story names it
  const label = `sameColor(${expected})`;
  return {
    $$typeof: Symbol.for('jest.asymmetricMatcher'),
    asymmetricMatch: (actual) => {
      // A story failure prints the matcher's frame and nothing of the story, so an empty computed
      // value — a detached element, not a color — names the comparison that hit it.
      if (actual === '') {
        throw new Error(
          `No computed color to compare with ${label}: the element is not in the page.`,
        );
      }
      if (typeof actual !== 'string') return false;
      try {
        return colorDistance(actual, expected) <= COLOR_TOLERANCE;
      } catch (error) {
        // Any other unreadable value names the comparison too: a bare parser error sends the
        // reader to the logs.
        throw new Error(`${label} can't read the actual value: ${(error as Error).message}`);
      }
    },
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

// ── Lengths ──────────────────────────────────────────────────────────────────────────────────

/**
 * Lengths that move are compared as numbers, never as strings. A transition's last frames
 * serialize short of the end (`0.999749px` for 1 px, `7.99817px` for 8 px), so a regex or a string
 * read a moment early fails, and a regex like `/3px/` also matches `13px`. Two lengths match within
 * `LENGTH_TOLERANCE_PX` (toBeCloseTo's two decimals): far above serialization rounding, far below
 * any length the kit draws.
 */
export const LENGTH_TOLERANCE_PX = 0.005;

/** One layer of a computed `box-shadow`, its lengths in px. */
export type ShadowLayer = {
  color: string;
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
};

/**
 * A computed `box-shadow`'s layers, in order (`none` has none). Reads Chromium's form,
 * `<color> <x> <y> <blur> <spread> [inset]`; anything else throws, as `toOklab` does.
 */
export function shadowsIn(value: string): ShadowLayer[] {
  if (value.trim() === '') {
    throw new Error(
      'No computed shadow: an empty string — the element is not in the page (detached by a redraw) or not painted yet',
    );
  }
  if (value.trim() === 'none') return [];
  return splitTopLevel(value).map((layer) => {
    const color = colorsIn(layer)[0] ?? '';
    const rest = color === '' ? layer : layer.replace(color, ' ');
    const lengths = (rest.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?px/gi) ?? []).map(
      parseFloat,
    );
    if (color === '' || lengths.length < 2 || lengths.length > 4) {
      throw new Error(`Not a computed shadow layer: ${JSON.stringify(layer)}`);
    }
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    return { color, inset: /\binset\b/.test(rest), x, y, blur, spread };
  });
}

/** Splits a list on its top-level commas (not those inside a color's parentheses). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/**
 * A length a shadow should have: a number (matched within `LENGTH_TOLERANCE_PX`), or a closed
 * `[min, max]` range — for an infinite animation, which has no end state to wait for, the span
 * its every phase stays in.
 */
export type LengthSpec = number | readonly [number, number];

type ShadowLengths = readonly [LengthSpec, LengthSpec, LengthSpec, LengthSpec];

/**
 * One layer `sameShadow` looks for: its four lengths (x, y, blur, spread) — an outer shadow — or
 * an object that can also ask for an `inset` layer and a color (a computed one, compared as colors).
 */
export type ShadowSpec =
  | ShadowLengths
  | { lengths: ShadowLengths; inset?: boolean; color?: string };

const lengthOk = (actual: number, want: LengthSpec) =>
  typeof want === 'number'
    ? Math.abs(actual - want) <= LENGTH_TOLERANCE_PX
    : actual >= want[0] - LENGTH_TOLERANCE_PX && actual <= want[1] + LENGTH_TOLERANCE_PX;

const specText = (spec: ShadowSpec) => {
  const { lengths, inset = false, color } = 'lengths' in spec ? spec : { lengths: spec };
  const len = lengths.map((l) => (typeof l === 'number' ? `${l}px` : `${l[0]}–${l[1]}px`));
  return [inset ? 'inset' : '', ...len, color ?? ''].filter(Boolean).join(' ');
};

function layerMeets(layer: ShadowLayer, spec: ShadowSpec): boolean {
  const { lengths, inset = false, color } = 'lengths' in spec ? spec : { lengths: spec };
  const actual = [layer.x, layer.y, layer.blur, layer.spread];
  return (
    layer.inset === inset &&
    lengths.every((want, i) => lengthOk(actual[i] as number, want)) &&
    (color === undefined || colorDistance(layer.color, color) <= COLOR_TOLERANCE)
  );
}

/**
 * Matches a computed `box-shadow` that has a layer for each spec (each its own layer, in any
 * order; other layers may be there too), its lengths compared as numbers — inside `toEqual`:
 * `expect(getComputedStyle(el).boxShadow).toEqual(sameShadow([0, 1, 0, 0]))`, or the focus ring,
 * `sameShadow([0, 0, 0, 3], [0, 0, 0, 4])`. An empty actual names the comparison and fails.
 */
export function sameShadow(...specs: ShadowSpec[]): AsymmetricMatcher {
  for (const spec of specs) {
    const color = 'lengths' in spec ? spec.color : undefined;
    if (color !== undefined) toOklab(color); // an unreadable expected color fails here, by name
  }
  const label = `sameShadow(${specs.map(specText).join(', ')})`;
  return {
    $$typeof: Symbol.for('jest.asymmetricMatcher'),
    asymmetricMatch: (actual) => {
      if (actual === '') {
        throw new Error(
          `No computed shadow to compare with ${label}: the element is not in the page.`,
        );
      }
      if (typeof actual !== 'string') return false;
      let layers: ShadowLayer[];
      try {
        layers = shadowsIn(actual);
      } catch (error) {
        throw new Error(`${label} can't read the actual value: ${(error as Error).message}`);
      }
      const free = [...layers];
      return specs.every((spec) => {
        const at = free.findIndex((layer) => layerMeets(layer, spec));
        if (at === -1) return false;
        free.splice(at, 1);
        return true;
      });
    },
    toString: () => label,
    toAsymmetricMatcher: () => label,
    [Symbol.for('chai/inspect')]: () => label,
  };
}

/**
 * The focus ring (`--box-shadow-focus`): a 3 px ring in the ground inside a 4 px ring in the
 * bright ink — both its layers, by length.
 */
export const focusRing = () => sameShadow([0, 0, 0, 3], [0, 0, 0, 4]);

/**
 * Waits for `el`'s running finite transitions and animations to finish (with `subtree`, its
 * descendants' too) — the end of the race, exactly, for a story that reads a settled end state.
 * An infinite animation (a breathing lamp) never finishes, so it's skipped: assert it with a
 * `[min, max]` range instead. A paused one is skipped too. A transition that starts as another
 * ends is waited for in turn, a few rounds at most.
 */
export async function transitionsDone(
  el: Element,
  { subtree = false }: { subtree?: boolean } = {},
): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const running = el
      .getAnimations({ subtree })
      .filter(
        (a) =>
          a.playState === 'running' &&
          Number.isFinite(
            Number(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY),
          ),
      );
    if (running.length === 0) return;
    // A transition cancelled by its replacement rejects `finished`: it's over either way.
    await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
  }
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
  // Chromium computes every property to the empty string on an element that has left the page
  // (or isn't painted yet), so say that rather than report an unreadable color: the measurement
  // held a node too long, or read it too soon.
  if (css.trim() === '') {
    throw new Error(
      `No computed color: an empty string (${JSON.stringify(css)}) — the element is not in the page (detached by a redraw) or not painted yet; wait for the value before comparing`,
    );
  }
  const m = /^\s*([a-z-]+)\(([^()]*)\)\s*$/i.exec(css);
  if (m === null) throw new Error(`Not a computed color: ${JSON.stringify(css)}`);
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
