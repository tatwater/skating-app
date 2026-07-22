/**
 * Non-color primitive scales — spacing, radii, typography, elevation, motion.
 *
 * Framework-agnostic values (numbers = density-independent px; strings where a
 * unit or keyword is intrinsic). Tailwind (web) and Tamagui (mobile) each adapt
 * these into their own config shape (D7); nothing here imports a UI framework.
 */

/** Base spacing scale (px). Roughly a 4px rhythm with half-steps at the low end. */
export const space = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
} as const;

/** Corner radii (px). `full` pills buttons/avatars. */
export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  full: 9999,
} as const;

/** Font families. Native/system stacks by default; swap when brand fonts land. */
export const fontFamily = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
} as const;

/** Font sizes (px). Named on a t-shirt scale. */
export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

/** Line heights (unitless multipliers). */
export const lineHeight = {
  none: 1,
  tight: 1.2,
  snug: 1.35,
  normal: 1.5,
  relaxed: 1.7,
} as const;

/** Font weights. */
export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Stacking order for overlapping surfaces. */
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 100,
  overlay: 200,
  modal: 300,
  toast: 400,
} as const;

/** Motion durations (ms). Kept short — the map should feel responsive. */
export const duration = {
  instant: 0,
  fast: 120,
  normal: 200,
  slow: 320,
} as const;
