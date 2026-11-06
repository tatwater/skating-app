/**
 * The token registry: every token, once, as a flat walkable list (D232).
 *
 * Each entry names the token, says what kind of value it is and which axis it varies on, gives its
 * raw CSS custom property and (when it has one) its Tailwind theme variable, and resolves its value
 * for any theme map. Every generator — CSS, Tailwind, the mobile module, the JSON a Paper push will
 * read — walks this list, so a token added here reaches every consumer, and nothing is emitted
 * that isn't here.
 */

import { type ThemeMap, themeMaps } from './maps';
import type { Oklch } from './oklch';
import { COLOR_KEYS, type ColorKey } from './semantic';
import {
  border,
  breakpoint,
  duration,
  easing,
  FONT_SIZE_KEYS,
  fontFamily,
  fontWeight,
  GAP_KEYS,
  leading,
  nudge,
  opacity,
  radius,
  SIZE_KEYS,
  space,
  tracking,
  zIndex,
} from './sizes';
import type { Length } from './units';

/** One layer of a box shadow; the color is a semantic key, so the shadow follows the mode. */
export interface ShadowLayer {
  readonly x: Length;
  readonly y: Length;
  readonly blur: Length;
  readonly spread: Length;
  readonly color: ColorKey;
  readonly inset?: boolean;
}

export type TokenValue =
  | { readonly kind: 'color'; readonly color: Oklch }
  | { readonly kind: 'length'; readonly length: Length }
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'fontFamily'; readonly families: readonly string[] }
  | { readonly kind: 'shadow'; readonly layers: readonly ShadowLayer[] }
  | { readonly kind: 'duration'; readonly ms: number }
  | { readonly kind: 'easing'; readonly bezier: readonly [number, number, number, number] };

/** Which axis a token varies on: neither, the surface (density), or the mode (color). */
export type Varies = 'none' | 'surface' | 'mode';

export interface TokenEntry {
  /** Dotted group and key, e.g. `color.fg3`, `font-size.row`. Stable; a Paper push keys on it. */
  readonly name: string;
  /** The group (`color`, `font-size`, `space`, …) and the key within it. */
  readonly group: string;
  readonly key: string;
  readonly varies: Varies;
  /** The raw custom property every surface sets, e.g. `--fg3`, `--type-row`. */
  readonly cssVar: string;
  /**
   * The Tailwind v4 theme variable that exposes it as utilities (`--color-fg3` → `text-fg3`), or
   * undefined when it has none (durations, layers) or would redefine a Tailwind default.
   */
  readonly tailwindVar?: string;
  readonly value: (map: ThemeMap) => TokenValue;
}

const color = (c: Oklch): TokenValue => ({ kind: 'color', color: c });
const length = (l: Length): TokenValue => ({ kind: 'length', length: l });
const num = (n: number): TokenValue => ({ kind: 'number', number: n });

/**
 * Tailwind defaults this wiring must not redefine, because the current UI uses them at Tailwind's
 * values: `leading-tight` / `-snug` / `-loose` (1.25 / 1.375 / 2 there; 1 / 1.2 / 1.8 here) and
 * the `font-sans` / `font-mono` stacks. Their tokens stay reachable as raw variables
 * (`leading-(--lead-tight)`, `font-(family-name:--family-mono)`) until the kit's re-skin replaces
 * those usages; then drop a name from this set and it wires itself.
 */
export const TAILWIND_DEFERRED = new Set([
  '--leading-tight',
  '--leading-snug',
  '--leading-loose',
  '--font-sans',
  '--font-mono',
]);

const tw = (name: string): string | undefined => (TAILWIND_DEFERRED.has(name) ? undefined : name);

function entry(
  group: string,
  key: string,
  varies: Varies,
  cssVar: string,
  tailwindVar: string | undefined,
  value: (map: ThemeMap) => TokenValue,
): TokenEntry {
  const twVar = tailwindVar === undefined ? undefined : tw(tailwindVar);
  return {
    name: `${group}.${key}`,
    group,
    key,
    varies,
    cssVar,
    ...(twVar === undefined ? {} : { tailwindVar: twVar }),
    value,
  };
}

function shared<T>(
  group: string,
  values: Readonly<Record<string, T>>,
  cssPrefix: string,
  tailwindPrefix: string | undefined,
  toValue: (v: T) => TokenValue,
): TokenEntry[] {
  return Object.entries(values).map(([key, v]) =>
    entry(
      group,
      key,
      'none',
      `--${cssPrefix}-${key}`,
      tailwindPrefix === undefined ? undefined : `--${tailwindPrefix}-${key}`,
      () => toValue(v),
    ),
  );
}

const sh = (
  x: number,
  y: number,
  blur: number,
  spread: number,
  c: ColorKey,
  inset = false,
): ShadowLayer => ({
  x: { unit: 'px', value: x },
  y: { unit: 'px', value: y },
  blur: { unit: 'px', value: blur },
  spread: { unit: 'px', value: spread },
  color: c,
  ...(inset ? { inset } : {}),
});

/** Box shadows, in px (drawing). Colors are semantic keys, so each follows the mode. */
export const shadows = {
  ring: [sh(0, 0, 0, 1, 'line2', true)], // an outline drawn as an inset ring
  'select-rule': [sh(2, 0, 0, 0, 'fg', true)], // the rule on a chosen lane or row
  'glow-ice': [sh(0, 0, 4, 0, 'acc-glow')], // a lit ice dot or mark
  'glow-w': [sh(0, 0, 8, 0, 'glow')], // the rail's active bar; a lit knob
  plate: [sh(0, 8, 24, 0, 'shade')], // a hover plate or tooltip
  actbar: [sh(0, 10, 28, 0, 'shade-strong')], // the floating action bar
  sheet: [sh(-24, 0, 48, 0, 'shade-strong')], // a sheet or drawer from the right
  modal: [sh(0, 24, 72, 0, 'shade-deep')], // a viewer modal; an inset card
  focus: [sh(0, 0, 0, 3, 'bg'), sh(0, 0, 0, 4, 'fg')], // a field-colored gap, then a 1 px ring
} as const satisfies Record<string, readonly ShadowLayer[]>;

/** Every token, in output order. */
export const registry: readonly TokenEntry[] = [
  // Colors vary by mode (and would by surface, if a surface ever diverged).
  ...COLOR_KEYS.map((key) =>
    entry('color', key, 'mode', `--${key}`, `--color-${key}`, (map) => color(map.colors[key])),
  ),
  // Density varies by surface.
  ...FONT_SIZE_KEYS.map((key) =>
    entry('font-size', key, 'surface', `--type-${key}`, `--text-${key}`, (map) =>
      length(map.fontSize[key]),
    ),
  ),
  ...SIZE_KEYS.map((key) =>
    entry('size', key, 'surface', `--size-${key}`, `--spacing-${key}`, (map) =>
      length(map.size[key]),
    ),
  ),
  ...GAP_KEYS.map((key) =>
    entry('gap', key, 'surface', `--gap-${key}`, `--spacing-${key}`, (map) => length(map.gap[key])),
  ),
  // Shared by every map. The spacing ruler isn't wired into Tailwind: its `--spacing` arithmetic
  // already yields the same values (see `space` in sizes.ts).
  ...shared('space', space, 'space', undefined, length),
  ...shared('space', nudge, 'space', undefined, length),
  ...shared('font-family', fontFamily, 'family', 'font', (families) => ({
    kind: 'fontFamily',
    families,
  })),
  ...shared('font-weight', fontWeight, 'weight', 'font-weight', num),
  ...shared('letter-spacing', tracking, 'track', 'tracking', length),
  ...shared('line-height', leading, 'lead', 'leading', length),
  ...shared('radius', radius, 'corner', 'radius', length),
  ...shared('border-width', border, 'stroke', undefined, length),
  ...shared('breakpoint', breakpoint, 'bp', 'breakpoint', length),
  ...shared('shadow', shadows, 'box-shadow', 'shadow', (layers) => ({ kind: 'shadow', layers })),
  ...shared('opacity', opacity, 'opacity', undefined, num),
  ...shared('z-index', zIndex, 'z', undefined, num),
  ...shared('duration', duration, 'duration', undefined, (ms) => ({ kind: 'duration', ms })),
  ...shared('easing', easing, 'easing', 'ease', (bezier) => ({ kind: 'easing', bezier })),
];

/** Walk every token with its value in every map — the shape a Paper push iterates. */
export function* walkTokens(): Generator<{
  entry: TokenEntry;
  map: ThemeMap;
  value: TokenValue;
}> {
  for (const entry of registry) {
    for (const surface of Object.values(themeMaps)) {
      for (const map of Object.values(surface)) yield { entry, map, value: entry.value(map) };
    }
  }
}
