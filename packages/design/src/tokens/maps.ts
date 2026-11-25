/**
 * The four theme maps: surface (`admin` | `skater`) × mode (`dark` | `light`) (D232).
 *
 * Colors resolve per surface × mode: from `semantic.ts`'s roles, with the map's designed values
 * (`designedColors`) in place of the role's where it has them. A derived light value is computed
 * here, at build time, from the dark one — deterministically, so the same source always yields the
 * same maps. Admin dark is the audit and admin light is derived; skater dark is the audit with its
 * own tertiary gray, and skater light is the mocks' designed palette. Density — type sizes, part
 * sizes and semantic gaps — and the control radius also differ by surface.
 */

import { WCAG_AA_NORMAL } from '../contrast';
import {
  composite,
  contrastOklch,
  type Oklch,
  rgbToOklch,
  solveAlphaForContrast,
  solveForContrast,
  withAlpha,
} from './oklch';
import { type PrimitiveName, primitives } from './primitives';
import {
  ACCENT_FLOOR_GROUND,
  type ColorKey,
  type ColorSpec,
  colorSpecs,
  type DesignedColor,
  type DesignedMap,
  designedColors,
  MODES,
  type Mode,
  type OverlayBase,
} from './semantic';
import {
  controlRadius,
  type FontSizeKey,
  fontSize,
  type GapKey,
  gap,
  type SizeKey,
  SURFACES,
  type Surface,
  type SurfaceRadiusKey,
  size,
} from './sizes';
import type { Length } from './units';

/** One resolved theme: every semantic color plus the surface's density. */
export interface ThemeMap {
  readonly surface: Surface;
  readonly mode: Mode;
  readonly colors: Readonly<Record<ColorKey, Oklch>>;
  readonly fontSize: Readonly<Record<FontSizeKey, Length>>;
  readonly size: Readonly<Record<SizeKey, Length>>;
  readonly gap: Readonly<Record<GapKey, Length>>;
  /** The radii that differ by surface (the control radius); the rest are shared. */
  readonly radius: Readonly<Record<SurfaceRadiusKey, Length>>;
}

const prim = (name: PrimitiveName): Oklch => primitives[name];

/**
 * Resolve every semantic color for one mode, taking `designed` values over the roles' where given.
 * Throws on an unknown or circular reference, so a broken spec fails the build rather than
 * emitting a hole.
 */
export function resolveColors(
  mode: Mode,
  specs: Readonly<Record<string, ColorSpec>> = colorSpecs,
  designed: Readonly<Record<string, DesignedColor>> = {},
): Record<string, Oklch> {
  const resolved: Record<string, Oklch> = {};
  const resolving = new Set<string>();

  const resolve = (key: string): Oklch => {
    const done = resolved[key];
    if (done) return done;
    const spec = specs[key];
    if (!spec) throw new Error(`Unknown color key: ${key}`);
    if (resolving.has(key)) throw new Error(`Circular color reference at ${key}`);
    resolving.add(key);
    const hand = designed[key];
    const value = hand === undefined ? compute(spec) : fromDesign(hand);
    resolving.delete(key);
    resolved[key] = value;
    return value;
  };

  const field = () => resolve(fieldKey(specs));
  const darkField = () => prim(darkFieldSpec(specs).dark);
  const baseOf = (b: OverlayBase, m: Mode): Oklch => {
    if (!('key' in b)) return prim(b[m]);
    if (m === mode) return resolve(b.key);
    // The dark value of a keyed base, for a light overlay that matches the dark one.
    // Present: the same-mode `resolve(b.key)` above would have thrown first.
    const keyed = specs[b.key] as ColorSpec;
    if (keyed.role === 'overlay' || keyed.role === 'alias') {
      throw new Error(`An overlay can't sit on ${b.key}, which is itself an ${keyed.role}`);
    }
    return prim(keyed.dark);
  };

  const fromDesign = (d: DesignedColor): Oklch => {
    if (typeof d === 'string') return prim(d);
    return withAlpha('key' in d ? resolve(d.key) : prim(d.primitive), d.alpha);
  };

  const compute = (spec: ColorSpec): Oklch => {
    switch (spec.role) {
      case 'base':
      case 'data':
      case 'fixed':
        return prim(spec[mode]);
      case 'ground':
      case 'ink': {
        const dark = prim(spec.dark);
        if (mode === 'dark') return dark;
        // The ramp inverted: the dark value's contrast against the dark field, kept against the
        // light field, on its far side. Hue and chroma come along (gamut permitting).
        return solveForContrast(dark, field(), contrastOklch(dark, darkField()), 'darker');
      }
      case 'accent': {
        const dark = prim(spec.dark);
        if (mode === 'dark') return dark;
        // As light as it can be while a label in it still passes AA on its darkest ground.
        const floor = rgbToOklch(composite(resolve(ACCENT_FLOOR_GROUND), field()));
        return solveForContrast(dark, floor, WCAG_AA_NORMAL, 'darker');
      }
      case 'overlay': {
        const color = baseOf(spec.base, mode);
        if (mode === 'dark' || spec.light === 'keep') return withAlpha(color, spec.alpha);
        const darkBase = baseOf(spec.base, 'dark');
        const target = contrastOklch(withAlpha(darkBase, spec.alpha), darkField());
        return withAlpha(color, solveAlphaForContrast(color, field(), target));
      }
      case 'alias':
        return resolve(spec.of);
    }
  };

  // In spec order, whatever order the references resolved in, so every map lists keys alike.
  return Object.fromEntries(Object.keys(specs).map((key) => [key, resolve(key)]));
}

/** The key whose role is `base` — the field everything is measured against. */
function fieldKey(specs: Readonly<Record<string, ColorSpec>>): string {
  const entry = Object.entries(specs).find(([, spec]) => spec.role === 'base');
  if (!entry) throw new Error('No base (field) color in the spec');
  return entry[0];
}

function darkFieldSpec(specs: Readonly<Record<string, ColorSpec>>) {
  return specs[fieldKey(specs)] as Extract<ColorSpec, { role: 'base' }>;
}

/** The four maps, `themeMaps[surface][mode]`. */
export const themeMaps = Object.fromEntries(
  SURFACES.map((surface) => [
    surface,
    Object.fromEntries(
      MODES.map((mode) => [
        mode,
        {
          surface,
          mode,
          colors: resolveColors(
            mode,
            colorSpecs,
            (designedColors[surface][mode] ?? {}) as DesignedMap,
          ) as Record<ColorKey, Oklch>,
          fontSize: fontSize[surface],
          size: size[surface],
          gap: gap[surface],
          radius: controlRadius[surface],
        } satisfies ThemeMap,
      ]),
    ),
  ]),
) as Record<Surface, Record<Mode, ThemeMap>>;

/** Every map, flat, in a fixed order: admin dark, admin light, skater dark, skater light. */
export const allThemeMaps: readonly ThemeMap[] = SURFACES.flatMap((surface) =>
  MODES.map((mode) => themeMaps[surface][mode]),
);

/**
 * The map a page gets when it states neither attribute: the skater surface (the public app), in
 * light — D34's default (readability in glare is a safety feature) — unless the OS asks for dark,
 * which the CSS honors when the page states no mode.
 */
export const DEFAULT_SURFACE: Surface = 'skater';
export const DEFAULT_MODE: Mode = 'light';
