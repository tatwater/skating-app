/**
 * Primitive color ramps — the raw palette, with **no semantic meaning**.
 *
 * These are the only place literal hex values live; `themes.ts` maps them onto
 * semantic roles per theme. The palette is cool/icy to match the FUI, winter-ice
 * aesthetic (00-vision). Ramps run 50 (lightest) → 950 (darkest).
 *
 * Never reference a raw ramp from app UI — consume a semantic token so both
 * themes (D34) stay in sync.
 */

/** Cool-tinted neutrals — the structural grays (text, surfaces, borders). */
export const neutral = {
  50: '#f4f7fa',
  100: '#e5edf3',
  200: '#c9d7e2',
  300: '#a1b6c7',
  400: '#728da3',
  500: '#526b81',
  600: '#405366',
  700: '#334252',
  800: '#232e3a',
  900: '#151d26',
  950: '#0b1016',
} as const

/** Ice/cyan accent — the primary brand hue. */
export const ice = {
  50: '#ecfdff',
  100: '#cef7fe',
  200: '#a2eefc',
  300: '#63e0f9',
  400: '#1fc9ec',
  500: '#06a6cb',
  600: '#0884ab',
  700: '#0e698b',
  800: '#155671',
  900: '#164860',
  950: '#082f42',
} as const

/** Danger — hazards, open water, thin ice, destructive actions. */
export const danger = {
  50: '#fef2f2',
  100: '#fee2e2',
  200: '#fecaca',
  300: '#fca5a5',
  400: '#f87171',
  500: '#e0404b',
  600: '#c81e2b',
  700: '#a71622',
  800: '#8a1620',
  900: '#73171f',
  950: '#3f070c',
} as const

/** Warning — caution, aging reports, degrading conditions. */
export const warning = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  300: '#fbd24e',
  400: '#f7b917',
  500: '#e39a09',
  600: '#bd7304',
  700: '#975108',
  800: '#7c400e',
  900: '#6a3510',
  950: '#3d1b04',
} as const

/** Success — fresh reports, good conditions, confirmations. */
export const success = {
  50: '#f0fdf4',
  100: '#dcfce7',
  200: '#bbf7d0',
  300: '#86efac',
  400: '#4ade80',
  500: '#22b455',
  600: '#159143',
  700: '#137138',
  800: '#155a31',
  900: '#144a2b',
  950: '#052e16',
} as const

export const palette = { neutral, ice, danger, warning, success } as const

/** A named primitive ramp (e.g. `'ice'`). */
export type PaletteName = keyof typeof palette
/** A step within a ramp (50–950). */
export type PaletteStep = keyof typeof neutral
