/**
 * Semantic color tokens: one key set, resolved per surface × mode (D232). Components read only these.
 *
 * Each key has a **role**, and the role says both what the dark map binds it to (straight from the
 * audit) and how a light map is derived from that — computed, then checked by the contrast suite
 * (research doc §1) — unless the map is designed (below):
 *
 * - `base` — the field. Dark is the ramp's bottom (void); light is the ramp's top (w).
 * - `ground` / `ink` — "the ramp inverted": the light value keeps the dark value's hue and chroma
 *   and its *contrast against the field*, on the other side of it. A hairline that sits 1.3:1 off
 *   the void sits 1.3:1 off the light field; a kicker at 5.3:1 stays at 5.3:1. Grounds are what
 *   things sit on (recede, may sit close together); ink is text, marks and controls (must pass).
 * - `accent` — a hue that means something (ice, amber, red). Inverting its contrast would turn amber
 *   brown, so the light value keeps hue and chroma and takes the *lightest* lightness that still
 *   passes AA on the darkest ground an accent label sits on (`ACCENT_FLOOR_GROUND`).
 * - `overlay` — a translucent color: another semantic key (or a fixed primitive) at an alpha, so
 *   washes follow their accent and lifts follow the ink. With `light: 'match'` the light alpha is
 *   solved so the overlay keeps its contrast against the field — which keeps every text-on-lift
 *   contrast exactly as the dark map has it; `'keep'` (plates, scrims, shadows) keeps the alpha.
 * - `alias` — the same value as another key in the same map.
 * - `data` — a data scale with its own value per mode (bathymetry) or one value for both
 *   (temperature): a reading, not chrome, so it isn't inverted.
 * - `fixed` — a mark whose value is designed for each mode rather than derived (the favorite star):
 *   its light value isn't computed from the dark one, so the contrast suite checks it as drawn.
 *
 * The roles are the default. A map can instead take **designed** values key by key
 * (`designedColors`): hand-picked colors that the derivation doesn't touch, checked by the contrast
 * suite as drawn. Skater light is designed (the approved web mocks, founder 2026-11-06), so each
 * mode can grow its own character, such as glows that suit the dark; admin light stays derived until
 * it has mocks of its own. A key a designed map leaves out still derives, measured against that
 * map's designed field and accents.
 */

import type { OverlayName, PrimitiveName } from './primitives';
import type { Surface } from './sizes';

/** The two modes (the `data-mode` axis). */
export const MODES = ['dark', 'light'] as const;
export type Mode = (typeof MODES)[number];

/** Where an overlay's color comes from: a semantic key in the same map, or a primitive per mode. */
export type OverlayBase =
  | { readonly key: string }
  | { readonly dark: PrimitiveName; readonly light: PrimitiveName };

export type ColorSpec =
  | { readonly role: 'base'; readonly dark: PrimitiveName; readonly light: PrimitiveName }
  | { readonly role: 'ground' | 'ink' | 'accent'; readonly dark: PrimitiveName }
  | {
      readonly role: 'overlay';
      readonly base: OverlayBase;
      readonly alpha: number;
      /** How the light map treats the alpha: solve it to keep contrast with the field, or keep it. */
      readonly light: 'match' | 'keep';
      /** The audited overlay this reproduces in admin dark, for provenance and the round-trip test. */
      readonly audit?: OverlayName;
    }
  | { readonly role: 'alias'; readonly of: string }
  | { readonly role: 'data'; readonly dark: PrimitiveName; readonly light: PrimitiveName }
  | { readonly role: 'fixed'; readonly dark: PrimitiveName; readonly light: PrimitiveName };

const overlay = (
  base: OverlayBase,
  alpha: number,
  light: 'match' | 'keep',
  audit?: OverlayName,
): ColorSpec => ({ role: 'overlay', base, alpha, light, ...(audit ? { audit } : {}) });

/**
 * The ground an accent label must still pass AA on in the light map: the selection plate (the
 * darkest ground the pairing table puts accent text on). See `contrastPairs`.
 */
export const ACCENT_FLOOR_GROUND = 'lift-12';
const onKey = (key: string): OverlayBase => ({ key });
/** Lifts are ink at an alpha: white over the dark field, black over the light one. */
const INK_PURE: OverlayBase = { dark: 'white', light: 'black' };
/** A plate for controls over imagery: black under the dark map's light icons, white under the light map's dark ones. */
const PLATE_ON_IMAGERY: OverlayBase = { dark: 'black', light: 'white' };
/** Scrims and shadows darken in both modes. */
const BLACK: OverlayBase = { dark: 'black', light: 'black' };

const DEPTH_BANDS = [0, 1, 2, 3, 4, 5, 6] as const;
const TEMP_STEPS = [
  'cold-4',
  'cold-3',
  'cold-2',
  'cold-1',
  'freeze',
  'warm-1',
  'warm-2',
  'warm-3',
] as const;

type DepthKey = `depth-${(typeof DEPTH_BANDS)[number]}${'' | '-line' | '-index'}`;
type TempKey = `temp-${(typeof TEMP_STEPS)[number]}`;

function depthSpecs(): Record<DepthKey, ColorSpec> {
  const specs = {} as Record<DepthKey, ColorSpec>;
  for (const band of DEPTH_BANDS) {
    for (const suffix of ['', '-line', '-index'] as const) {
      specs[`depth-${band}${suffix}`] = {
        role: 'data',
        dark: `depth-dark-${band}${suffix}`,
        light: `depth-light-${band}${suffix}`,
      };
    }
  }
  return specs;
}

function tempSpecs(): Record<TempKey, ColorSpec> {
  const specs = {} as Record<TempKey, ColorSpec>;
  for (const step of TEMP_STEPS) {
    specs[`temp-${step}`] = { role: 'data', dark: `temp-${step}`, light: `temp-${step}` };
  }
  return specs;
}

/**
 * The semantic key set, in output order. Admin dark is exactly the audit; skater dark shares it.
 * Comments give the audited primitive's job.
 */
export const colorSpecs = {
  // Grounds — the field and what sits on it. Allowed to sit close to each other.
  bg: { role: 'base', dark: 'void', light: 'w' }, // the field
  panel: { role: 'ground', dark: 'g1' }, // inputs, command blocks, the lowest lift
  raise: { role: 'ground', dark: 'g2' }, // a primary button's face
  line: { role: 'ground', dark: 'g3' }, // hairlines, dotted row separators
  line2: { role: 'ground', dark: 'g4' }, // stronger rules: table heads, input underlines

  // Ink — text and marks. Must pass AA on every ground they sit on.
  fg: { role: 'ink', dark: 'w' }, // lit: the display word, values, selection
  fg1: { role: 'ink', dark: 'g7' }, // bright body, names in lists, inverted slugs
  fg2: { role: 'ink', dark: 'g6' }, // body text in lists
  fg3: { role: 'ink', dark: 'g5' }, // kickers, assistive text, dim values
  'fg-disabled': { role: 'ink', dark: 'g4' }, // disabled text (exempt from AA, as WCAG allows)

  // Accents by meaning: ice (water, geography, a transient mode), amber (waits on a person),
  // red (safety; will not recover without a person).
  acc: { role: 'accent', dark: 'ice' },
  'acc-dim': { role: 'ink', dark: 'ice-dim' }, // ice at rest: a pill border, a quiet link
  warn: { role: 'accent', dark: 'amber' },
  bad: { role: 'accent', dark: 'red' },

  // Marks with a designed value per mode. `star` fills a *set* favorite only; an unset star stays
  // an outline in the ink it sits with.
  star: { role: 'fixed', dark: 'star-dark', light: 'star-light' },

  // Inverse — a solid ink plate (the primary button) and the text on it.
  'inv-bg': { role: 'ink', dark: 'w' },
  'inv-fg': { role: 'alias', of: 'bg' },

  // Accent washes, tints and glows follow their accent.
  'acc-tint': overlay(onKey('acc'), 0.05, 'match', 'ice-tint'),
  'acc-wash': overlay(onKey('acc'), 0.1, 'match', 'ice-wash'),
  'acc-wash-strong': overlay(onKey('acc'), 0.16, 'match', 'ice-wash-strong'),
  'acc-glow': overlay(onKey('acc'), 0.45, 'match', 'ice-glow'),
  'warn-tint': overlay(onKey('warn'), 0.07, 'match', 'amber-tint'),
  'warn-wash': overlay(onKey('warn'), 0.12, 'match', 'amber-wash'),
  'warn-line': overlay(onKey('warn'), 0.32, 'match', 'amber-line'),
  'warn-glow': overlay(onKey('warn'), 0.45, 'match', 'amber-glow'),
  'bad-tint': overlay(onKey('bad'), 0.06, 'match', 'red-tint'),
  'bad-wash': overlay(onKey('bad'), 0.12, 'match', 'red-wash'),
  'bad-dim': overlay(onKey('bad'), 0.42, 'match', 'red-dim'), // an armed danger button that waits
  'bad-glow': overlay(onKey('bad'), 0.45, 'match', 'red-glow'),
  // The search highlight behind matched text (with a 1 px ice underline, drawn by the component).
  // From the skater mocks, not the audit: ice at 24% on dark.
  'acc-mark': overlay(onKey('acc'), 0.24, 'match'),

  // Lifts — ink at an alpha over the field.
  'lift-03': overlay(INK_PURE, 0.03, 'match', 'lift-03'), // a striped or hovered row
  'lift-05': overlay(INK_PURE, 0.05, 'match', 'lift-05'), // a tinted cell, a minor grid line
  'lift-08': overlay(INK_PURE, 0.08, 'match', 'lift-08'), // a chosen lane or row
  'lift-12': overlay(INK_PURE, 0.12, 'match', 'lift-12'), // the selection plate, a lit toggle's track
  'lift-18': overlay(INK_PURE, 0.18, 'match', 'lift-18'), // a hover bracket, a mark over a slug
  glow: overlay(INK_PURE, 0.4, 'match', 'w-glow'), // the halo on a lit white thing

  // Plates, dims and shades (a shadow's color: `shade`, so `--shadow-*` stays Tailwind's box shadows).
  plate: overlay(onKey('panel'), 0.9, 'keep', 'plate'), // a plate floating over the map
  'plate-solid': overlay(onKey('panel'), 0.96, 'keep', 'plate-solid'), // action bar, tooltip, toast
  'map-plate': overlay(PLATE_ON_IMAGERY, 0.72, 'keep', 'map-plate'), // controls over the map or a photo
  'map-foot': overlay(onKey('bg'), 0.85, 'keep', 'map-foot'), // the map's foot strip

  // The map's water. Every listed body is one water color, and that color is ice (the skater
  // mocks' rule: ice is water, geography, selection): a wash of the accent over the basemap's own
  // ground, with its shore in the same ice at rest, so the map speaks the app's hue and not a
  // second blue. A body that isn't listed as active is gray, not ice: an ink lift and an ink
  // hairline, no chroma at all. `keep`, not `match`: these sit on the basemap, not the field.
  'map-water': overlay(onKey('acc'), 0.24, 'keep'), // the one water fill
  'map-shore': overlay(onKey('acc'), 0.6, 'keep'), // a listed body's shore at rest
  'map-water-inactive': overlay(INK_PURE, 0.08, 'keep'), // an inactive body's fill
  'map-shore-inactive': overlay(INK_PURE, 0.35, 'keep'), // its shore
  scrim: overlay(BLACK, 0.66, 'keep', 'scrim'), // behind a sheet, a drawer, an inset card
  'scrim-deep': overlay(BLACK, 0.76, 'keep', 'scrim-deep'), // behind a viewer modal
  shade: overlay(BLACK, 0.6, 'keep', 'shadow'), // the color of a box shadow
  'shade-strong': overlay(BLACK, 0.7, 'keep', 'shadow-strong'),
  'shade-deep': overlay(BLACK, 0.85, 'keep', 'shadow-deep'),

  // Data scales.
  ...tempSpecs(),
  ...depthSpecs(),
} as const satisfies Record<string, ColorSpec>;

export type ColorKey = keyof typeof colorSpecs;
export const COLOR_KEYS = Object.keys(colorSpecs) as ColorKey[];

/**
 * A designed value: a primitive, or a designed alpha over another key in the same map (so a wash
 * follows its designed accent) or over a primitive.
 */
export type DesignedColor =
  | PrimitiveName
  | { readonly key: ColorKey; readonly alpha: number }
  | { readonly primitive: PrimitiveName; readonly alpha: number };

export type DesignedMap = Readonly<Partial<Record<ColorKey, DesignedColor>>>;

/**
 * Hand-picked values that replace the role's value in one map. Source: the approved skater web
 * mocks — `skater-web/skater.css` (the `body` and `body.light` blocks, `lat.css`'s search mark) and
 * the *Gli · Web app · Review 3* Paper file's `--color-light-*` and `--color-fg3-dark` tokens
 * (2026-11-06). Where the two disagree, Paper's token wins: light amber is Paper's #A26B00,
 * where the boards' CSS drew #C25400. The light accents (and `acc-dim`) are then darkened to pass
 * AA as text on every ground they're paired with (founder, 2026-11-06; see `primitives.ts`). Of the
 * two ambers, Paper's was kept: darkened, the orange lands within 17 ΔE2000 of the red, the amber 30.
 *
 * Skater light keys left out derive as before, against the designed white field: `fg-disabled`,
 * the tints, strong washes, glows and `warn-line`, `bad-dim`, the lifts, `plate-solid`,
 * `map-plate`, `map-foot`, `scrim-deep` and the inactive water. The mocks give no light value for
 * them. The map's water and shore are designed here (2026-11-07, the map re-skin), not in the mocks,
 * which drew the water in a pre-token blue.
 */
export const designedColors: Readonly<
  Record<Surface, Readonly<Partial<Record<Mode, DesignedMap>>>>
> = {
  admin: {},
  skater: {
    dark: {
      fg3: 'skater-dark-fg3', // the mock's own gray: clears 4.5:1 on every dark ground
    },
    light: {
      // Bright outdoor glare: higher contrast, never washed.
      bg: 'skater-light-bg',
      panel: 'skater-light-panel',
      raise: 'skater-light-raise',
      line: 'skater-light-line',
      line2: 'skater-light-line2',
      fg: 'skater-light-fg',
      fg1: 'skater-light-fg1',
      fg2: 'skater-light-fg2',
      fg3: 'skater-light-fg3',
      acc: 'skater-light-ice',
      'acc-dim': 'skater-light-ice-dim', // derived, it measured 4.34 on raise; darkened to pass
      warn: 'skater-light-amber',
      bad: 'skater-light-red',
      'inv-bg': 'skater-light-fg', // the primary button is solid ink; inv-fg (the field) is white
      'acc-wash': { key: 'acc', alpha: 0.09 }, // rgba(10,125,156,.09)
      'warn-wash': { key: 'warn', alpha: 0.1 }, // the mock's .10, over the designed amber
      'bad-wash': { key: 'bad', alpha: 0.08 }, // rgba(210,31,44,.08)
      'acc-mark': { key: 'acc', alpha: 0.22 }, // rgba(10,125,156,.22)
      plate: { key: 'bg', alpha: 0.92 }, // rgba(255,255,255,.92)
      scrim: { key: 'fg', alpha: 0.32 }, // rgba(10,10,10,.32): a lighter dim, still dark
      // The light ice is a dark teal, so the water takes less of it to read as the same wash, and
      // the shore a touch more to hold a 1 px line in glare (D34).
      'map-water': { key: 'acc', alpha: 0.2 },
      'map-shore': { key: 'acc', alpha: 0.7 },
      // Shadows soften on white: the tooltip's .12, the sheets' .18 (skater.css, rep.css, act.css).
      shade: { primitive: 'black', alpha: 0.12 },
      'shade-strong': { primitive: 'black', alpha: 0.18 },
      'shade-deep': { primitive: 'black', alpha: 0.18 },
    },
  },
};
