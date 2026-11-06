/**
 * Primitive colors, in OKLCH — the only place a raw color is written (D232).
 *
 * Converted once from the audited admin palette by `scripts/convert-audit.ts` (2026-11-06); the
 * trailing comment on each line is the audited hex, kept for provenance only. The two `star`
 * primitives and the `skater-*` ones come from the approved skater web mocks
 * (`skater-web/skater.css` and the *Gli · Web app · Review 3* Paper file, 2026-11-06), not the
 * audit; their comments are those mocks' hex. They are hand-picked, not derived (see
 * `designedColors` in `semantic.ts`). Edit the OKLCH
 * values here; nothing else in the repo may hold a raw color. No semantic meaning lives here —
 * `semantic.ts` maps these onto roles per surface and mode.
 */

import type { Oklch } from './oklch';

export const primitives = {
  void: { l: 0.1149, c: 0, h: 0 }, // #050505
  g1: { l: 0.1591, c: 0, h: 0 }, // #0d0d0d
  g2: { l: 0.1957, c: 0, h: 0 }, // #151515
  g3: { l: 0.252, c: 0, h: 0 }, // #222222
  g4: { l: 0.3407, c: 0, h: 0 }, // #383838
  g5: { l: 0.6066, c: 0, h: 0 }, // #828282
  g6: { l: 0.7252, c: 0, h: 0 }, // #a6a6a6
  g7: { l: 0.8884, c: 0, h: 0 }, // #dadada
  w: { l: 0.9761, c: 0, h: 0 }, // #f7f7f7
  ice: { l: 0.8012, c: 0.1334, h: 215.49 }, // #2fd3f4
  'ice-dim': { l: 0.5851, c: 0.0977, h: 215.16 }, // #1a8aa0
  amber: { l: 0.8128, c: 0.1623, h: 83.9 }, // #f3b71a
  red: { l: 0.6713, c: 0.2164, h: 22.08 }, // #ff4a55
  'star-dark': { l: 0.8128, c: 0.1623, h: 83.9 }, // #f3b71a
  'star-light': { l: 0.5721, c: 0.1214, h: 73.76 }, // #a26b00
  // The skater surface's designed palette. Dark differs from the audit only in its tertiary text.
  'skater-dark-fg3': { l: 0.6334, c: 0, h: 0 }, // #8a8a8a
  'skater-light-bg': { l: 1, c: 0, h: 0 }, // #ffffff
  'skater-light-panel': { l: 0.9731, c: 0, h: 0 }, // #f6f6f6
  'skater-light-raise': { l: 0.9491, c: 0, h: 0 }, // #eeeeee
  'skater-light-line': { l: 0.9097, c: 0, h: 0 }, // #e1e1e1
  'skater-light-line2': { l: 0.8203, c: 0, h: 0 }, // #c4c4c4
  'skater-light-fg': { l: 0.1448, c: 0, h: 0 }, // #0a0a0a
  'skater-light-fg1': { l: 0.2686, c: 0, h: 0 }, // #262626
  'skater-light-fg2': { l: 0.3979, c: 0, h: 0 }, // #474747
  'skater-light-fg3': { l: 0.5278, c: 0, h: 0 }, // #6b6b6b
  'skater-light-ice': { l: 0.5482, c: 0.1005, h: 223.61 }, // #0a7d9c
  'skater-light-amber': { l: 0.5721, c: 0.1214, h: 73.76 }, // #a26b00
  'skater-light-red': { l: 0.5554, c: 0.2096, h: 24.81 }, // #d21f2c
  'temp-cold-4': { l: 0.8699, c: 0.1126, h: 211.82 }, // #6fe8ff
  'temp-cold-3': { l: 0.8012, c: 0.1334, h: 215.49 }, // #2fd3f4
  'temp-cold-2': { l: 0.6439, c: 0.1085, h: 216.84 }, // #1f9db8
  'temp-cold-1': { l: 0.491, c: 0.0803, h: 219.83 }, // #1b6b80
  'temp-freeze': { l: 0.3649, c: 0.0109, h: 248.13 }, // #3a3f44
  'temp-warm-1': { l: 0.5438, c: 0.089, h: 81.36 }, // #8a6a2c
  'temp-warm-2': { l: 0.7292, c: 0.1447, h: 77.64 }, // #d99a1f
  'temp-warm-3': { l: 0.7045, c: 0.1926, h: 39.23 }, // #ff6b35
  'depth-dark-0': { l: 0.3658, c: 0.0485, h: 247.17 }, // #294157
  'depth-dark-0-line': { l: 0.4409, c: 0.0434, h: 248.84 }, // #40556a
  'depth-dark-0-index': { l: 0.5008, c: 0.0376, h: 245.81 }, // #526678
  'depth-dark-1': { l: 0.339, c: 0.0437, h: 245.62 }, // #243a4d
  'depth-dark-1-line': { l: 0.4122, c: 0.0399, h: 248.82 }, // #3a4d60
  'depth-dark-1-index': { l: 0.4735, c: 0.0354, h: 247.08 }, // #4c5e6f
  'depth-dark-2': { l: 0.3122, c: 0.0401, h: 245.22 }, // #1f3344
  'depth-dark-2-line': { l: 0.3861, c: 0.037, h: 247.35 }, // #344657
  'depth-dark-2-index': { l: 0.4459, c: 0.0331, h: 248.57 }, // #465666
  'depth-dark-3': { l: 0.2848, c: 0.0365, h: 244.72 }, // #1a2c3b
  'depth-dark-3-line': { l: 0.3602, c: 0.0334, h: 247.12 }, // #2f3f4e
  'depth-dark-3-index': { l: 0.4203, c: 0.0302, h: 246.73 }, // #404f5d
  'depth-dark-4': { l: 0.2573, c: 0.0343, h: 246.04 }, // #152533
  'depth-dark-4-line': { l: 0.3331, c: 0.0304, h: 245.05 }, // #293845
  'depth-dark-4-index': { l: 0.3943, c: 0.0272, h: 244.42 }, // #3a4854
  'depth-dark-5': { l: 0.2321, c: 0.0289, h: 243.14 }, // #111f2a
  'depth-dark-5-line': { l: 0.3062, c: 0.0266, h: 244.34 }, // #24313c
  'depth-dark-5-index': { l: 0.3661, c: 0.0239, h: 248.48 }, // #35404b
  'depth-dark-6': { l: 0.2031, c: 0.0265, h: 244.76 }, // #0c1822
  'depth-dark-6-line': { l: 0.2793, c: 0.024, h: 246.22 }, // #1f2a34
  'depth-dark-6-index': { l: 0.3391, c: 0.0208, h: 245.63 }, // #2f3942
  'depth-light-0': { l: 0.9251, c: 0.0161, h: 239.12 }, // #dde8f0
  'depth-light-0-line': { l: 0.8147, c: 0.0148, h: 238.06 }, // #bac4cb
  'depth-light-0-index': { l: 0.7495, c: 0.0125, h: 239.97 }, // #a7afb5
  'depth-light-1': { l: 0.9007, c: 0.022, h: 235.02 }, // #d1e1eb
  'depth-light-1-line': { l: 0.7903, c: 0.0201, h: 235.81 }, // #afbdc6
  'depth-light-1-index': { l: 0.7246, c: 0.0179, h: 236.8 }, // #9ca8b0
  'depth-light-2': { l: 0.8747, c: 0.029, h: 238.28 }, // #c5d9e7
  'depth-light-2-line': { l: 0.7641, c: 0.0265, h: 240.77 }, // #a4b5c2
  'depth-light-2-index': { l: 0.7007, c: 0.0235, h: 239.59 }, // #92a1ac
  'depth-light-3': { l: 0.8492, c: 0.0353, h: 241.52 }, // #bad1e3
  'depth-light-3-line': { l: 0.7396, c: 0.0319, h: 239 }, // #99aebd
  'depth-light-3-index': { l: 0.6742, c: 0.0284, h: 242.94 }, // #8899a7
  'depth-light-4': { l: 0.8257, c: 0.0415, h: 241.48 }, // #afcadf
  'depth-light-4-line': { l: 0.7139, c: 0.0379, h: 243.18 }, // #8fa6b9
  'depth-light-4-index': { l: 0.6497, c: 0.0332, h: 242.27 }, // #7e92a2
  'depth-light-5': { l: 0.8001, c: 0.0482, h: 243.52 }, // #a4c2db
  'depth-light-5-line': { l: 0.6902, c: 0.0436, h: 243.98 }, // #859fb5
  'depth-light-5-index': { l: 0.6254, c: 0.039, h: 243.32 }, // #748b9e
  'depth-light-6': { l: 0.7751, c: 0.0542, h: 245.93 }, // #9abad7
  'depth-light-6-line': { l: 0.6643, c: 0.05, h: 246.64 }, // #7b97b1
  'depth-light-6-index': { l: 0.5991, c: 0.0437, h: 246.27 }, // #6b8399
  white: { l: 1, c: 0, h: 0 }, // #ffffff
  black: { l: 0, c: 0, h: 0 }, // #000000
} as const satisfies Record<string, Oklch>;

export type PrimitiveName = keyof typeof primitives;

/** A translucent color: an opaque primitive at an alpha. */
export interface Overlay {
  readonly base: PrimitiveName;
  readonly alpha: number;
}

/** The audit's translucent colors (washes, lifts, plates, scrims, shadows), as base + alpha. */
export const overlays = {
  'ice-wash': { base: 'ice', alpha: 0.1 }, // #2fd3f41a
  'ice-glow': { base: 'ice', alpha: 0.45 }, // #2fd3f473
  'amber-wash': { base: 'amber', alpha: 0.12 }, // #f3b71a1f
  'amber-glow': { base: 'amber', alpha: 0.45 }, // #f3b71a73
  'red-wash': { base: 'red', alpha: 0.12 }, // #ff4a551f
  'red-glow': { base: 'red', alpha: 0.45 }, // #ff4a5573
  'lift-03': { base: 'white', alpha: 0.03 }, // #ffffff08
  'lift-05': { base: 'white', alpha: 0.05 }, // #ffffff0d
  'lift-08': { base: 'white', alpha: 0.08 }, // #ffffff14
  'lift-12': { base: 'white', alpha: 0.12 }, // #ffffff1f
  'lift-18': { base: 'white', alpha: 0.18 }, // #ffffff2e
  'w-glow': { base: 'white', alpha: 0.4 }, // #ffffff66
  plate: { base: 'g1', alpha: 0.9 }, // #0d0d0de6
  'plate-solid': { base: 'g1', alpha: 0.96 }, // #0d0d0df5
  'map-plate': { base: 'black', alpha: 0.72 }, // #000000b8
  'map-foot': { base: 'void', alpha: 0.85 }, // #050505d9
  scrim: { base: 'black', alpha: 0.66 }, // #000000a8
  'scrim-deep': { base: 'black', alpha: 0.76 }, // #000000c2
  shadow: { base: 'black', alpha: 0.6 }, // #00000099
  'shadow-strong': { base: 'black', alpha: 0.7 }, // #000000b3
  'shadow-deep': { base: 'black', alpha: 0.85 }, // #000000d9
  'ice-tint': { base: 'ice', alpha: 0.05 }, // #2fd3f40d
  'ice-wash-strong': { base: 'ice', alpha: 0.16 }, // #2fd3f429
  'amber-tint': { base: 'amber', alpha: 0.07 }, // #f3b71a12
  'amber-line': { base: 'amber', alpha: 0.32 }, // #f3b71a52
  'red-tint': { base: 'red', alpha: 0.06 }, // #ff4a550f
  'red-dim': { base: 'red', alpha: 0.42 }, // #ff4a556b
} as const satisfies Record<string, Overlay>;

export type OverlayName = keyof typeof overlays;
