import { type NativeMode, nativeThemes } from '@skating/design/native';
import type { MapLineStyle, MapOutlineStyle } from './mapDescriptors';

/**
 * The console map's own paint, from the admin surface's tokens (founder, 2026-11-10: the console's
 * map uses the same token system under `data-surface="admin"`, expressed as the boards' look).
 *
 * The basemap under it is the app's winter basemap, unchanged — its land is `map-earth`, which the
 * admin and skater surfaces share, so the console map and the skater map stand on one ground. What
 * the console draws on top is the boards' `v4` style: grayscale ink, the body's shore the brightest
 * line, its water one quiet step off the land, bays dashed, the graticule a faint lift. Color is
 * rationed as everywhere on the console: nothing here is ice, amber or red but what means it.
 *
 * Each style names **tokens**, not colors. MapLibre paints from values, so `bodyMapPalette` resolves
 * the names through the generated native map for the console's mode; an SVG still paints the same
 * names as CSS variables (`tokenVar`). One table, two renderers, no second palette.
 */

export type BodyMapMode = NativeMode;

export type AdminColorToken = keyof (typeof nativeThemes)['admin']['dark']['color'];

/** A style's paint, by token name. Widths are px and dashes are in line widths (MapLibre's unit). */
export interface StrokeSpec {
  fill: AdminColorToken | null;
  line: AdminColorToken;
  width: number;
  dash: readonly number[] | null;
}

/** The boards' hairline; a lit item steps up to 2, a stored mouth and a track to 1.5. */
const HAIR = 1;

export const OUTLINE_STYLES: Readonly<Record<MapOutlineStyle, StrokeSpec>> = {
  // The body: its water is the raised ground — one step off the land, and opaque, so it covers the
  // basemap's own gray water — its shore the second ink (the boards' `g7`).
  body: { fill: 'raise', line: 'fg1', width: HAIR, dash: null },
  // A bay is dashed in the third ink and drawn under the shore, so where the two meet the shore
  // wins and only the bay's water edge (its chord) reads as dashes.
  bay: { fill: null, line: 'fg2', width: HAIR, dash: [2, 3] },
  neighbor: { fill: null, line: 'fg3', width: HAIR, dash: [4, 3] },
  footprint: { fill: 'lift-08', line: 'fg2', width: HAIR, dash: null },
  // Not ours yet (the Inbox's catalog candidate, a skater's drawing): the bright ink, dashed, a step
  // heavier than the shore it is weighed against. No fill: the shore under it stays readable.
  candidate: { fill: null, line: 'fg', width: 1.5, dash: [3, 2] },
};

export const LINE_STYLES: Readonly<Record<MapLineStyle, StrokeSpec>> = {
  divider: { fill: null, line: 'fg2', width: HAIR, dash: [2, 3] },
  mouth: { fill: null, line: 'fg2', width: 1.5, dash: null },
  // The boards' town line: a long dash and a dot, in the quiet ink.
  townLine: { fill: null, line: 'fg3', width: HAIR, dash: [8, 3, 1, 3] },
  track: { fill: null, line: 'fg2', width: 1.5, dash: null },
  leader: { fill: null, line: 'fg2', width: HAIR, dash: null },
  // The walk from a lot to its put-in: the skater drawer's dash, in the console's gray ink.
  approach: { fill: null, line: 'fg1', width: 1.5, dash: [2, 2] },
  // A survey's dimension line, quiet: drawn over the map in pixels, its ticks a fixed length.
  dimension: { fill: null, line: 'fg3', width: HAIR, dash: null },
  // A distance the Inbox weighs (asked to lookalike, candidate to ours): a quiet dashed rule.
  gap: { fill: null, line: 'fg2', width: HAIR, dash: [2, 3] },
};

/**
 * A hazard's dot field, by tone: the warning red, or the amber of *healing, still unsafe* — the
 * console's one use of either on the map, since both mean what they say. How strongly a field
 * draws is its freshness (`hazardField.ts`), never its color.
 */
export const FIELD_TONES: Readonly<Record<'hazard' | 'healing', AdminColorToken>> = {
  hazard: 'bad',
  healing: 'warn',
};

/** A field dot's radius, px: the board's cells at the body's zoom. */
export const FIELD_DOT_RADIUS = 1.6;

/** What a lit outline or line becomes: the bright ink, a step heavier, a lift inside. */
export const LIT_STYLE: StrokeSpec = { fill: 'lift-08', line: 'fg', width: 2, dash: null };

/** The graticule's lines: the boards' 5 % grid (`rgba(255,255,255,.055)`) is the 5 % lift. */
export const GRATICULE_TOKEN: AdminColorToken = 'lift-05';

/** One token's value in a mode. */
export function adminToken(mode: BodyMapMode, name: AdminColorToken): string {
  return nativeThemes.admin[mode].color[name];
}

/** A token as a CSS variable, for anything the browser paints. */
export function tokenVar(name: AdminColorToken): string {
  return `var(--${name})`;
}

export interface ResolvedStroke {
  fill: string | null;
  line: string;
  width: number;
  dash: readonly number[] | null;
}

export interface BodyMapPalette {
  outline: Record<MapOutlineStyle, ResolvedStroke>;
  line: Record<MapLineStyle, ResolvedStroke>;
  lit: ResolvedStroke;
  field: Record<'hazard' | 'healing', string>;
}

function resolve(mode: BodyMapMode, spec: StrokeSpec): ResolvedStroke {
  return {
    fill: spec.fill === null ? null : adminToken(mode, spec.fill),
    line: adminToken(mode, spec.line),
    width: spec.width,
    dash: spec.dash,
  };
}

function resolveAll<K extends string>(
  mode: BodyMapMode,
  table: Readonly<Record<K, StrokeSpec>>,
): Record<K, ResolvedStroke> {
  return Object.fromEntries(
    (Object.entries(table) as [K, StrokeSpec][]).map(([k, s]) => [k, resolve(mode, s)]),
  ) as Record<K, ResolvedStroke>;
}

/** The palette MapLibre paints from, for the console's mode. */
export function bodyMapPalette(mode: BodyMapMode): BodyMapPalette {
  return {
    outline: resolveAll(mode, OUTLINE_STYLES),
    line: resolveAll(mode, LINE_STYLES),
    lit: resolve(mode, LIT_STYLE),
    field: {
      hazard: adminToken(mode, FIELD_TONES.hazard),
      healing: adminToken(mode, FIELD_TONES.healing),
    },
  };
}
