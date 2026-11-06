/**
 * Which ink sits on which ground — the table the contrast suite runs on every map (D232).
 *
 * The founder's rule: grounds meant to recede may sit close to each other, but **text and controls
 * must pass AA (4.5:1) on the grounds they sit on**. A translucent ground (a lift, a wash, a plate)
 * is measured as it renders, composited over the field. Every color key is either an ink with the
 * grounds it may sit on, or a ground, or exempt with a reason — `maps.test.ts` fails on a key that
 * is none of them, so a new token can't dodge the sweep.
 *
 * Where an ink is *not* paired with a ground, it is because the audited dark map fails there, and
 * the kit must not put that ink on that ground (listed in `INK_KEEPS_OFF`).
 */

import type { ColorKey } from './semantic';

/** The grounds text can sit on, solid and translucent. */
export const GROUNDS = [
  'bg',
  'panel',
  'raise',
  'plate-solid',
  'lift-03',
  'lift-05',
  'lift-08',
  'lift-12',
  'lift-18',
  'acc-tint',
  'acc-wash',
  'acc-wash-strong',
  'warn-tint',
  'warn-wash',
  'bad-tint',
  'bad-wash',
] as const satisfies readonly ColorKey[];
export type Ground = (typeof GROUNDS)[number];

const SOLID: readonly Ground[] = ['bg', 'panel', 'raise', 'plate-solid'];

/** Each ink and the grounds it must pass AA (4.5:1) on, in every map. */
export const TEXT_PAIRS: Readonly<Partial<Record<ColorKey, readonly Ground[]>>> = {
  fg: GROUNDS,
  fg1: GROUNDS,
  fg2: GROUNDS,
  fg3: [
    ...SOLID,
    'lift-03',
    'lift-05',
    'lift-08',
    'acc-tint',
    'acc-wash',
    'warn-tint',
    'bad-tint',
    'bad-wash',
  ],
  acc: [
    ...SOLID,
    'lift-03',
    'lift-05',
    'lift-08',
    'lift-12',
    'acc-tint',
    'acc-wash',
    'acc-wash-strong',
  ],
  'acc-dim': [...SOLID, 'lift-03', 'lift-05'],
  warn: [...SOLID, 'lift-03', 'lift-05', 'lift-08', 'lift-12', 'warn-tint', 'warn-wash'],
  bad: [...SOLID, 'lift-03', 'lift-05', 'lift-08', 'lift-12', 'bad-tint', 'bad-wash'],
};

/**
 * Where the audited palette itself falls under AA, so the kit keeps that ink off that ground
 * (contrast in the admin dark map; the light maps preserve it). A founder call can lift an ink
 * or a ground instead.
 */
export const INK_KEEPS_OFF: Readonly<Partial<Record<ColorKey, readonly Ground[]>>> = {
  fg3: ['lift-12', 'lift-18', 'acc-wash-strong', 'warn-wash'], // 4.09, 3.34, 4.12, 4.48
  'acc-dim': ['lift-08', 'lift-12', 'lift-18'], // 4.34, 3.88, 3.17 — a quiet link stays on solid grounds
  acc: ['lift-18'],
  warn: ['lift-18'],
  bad: ['lift-18'], // 3.88 — a hover bracket never carries a red label
};

/** Inks that sit on one specific plate. */
export const PLATE_PAIRS: ReadonlyArray<readonly [ColorKey, ColorKey]> = [['inv-fg', 'inv-bg']];

/**
 * Non-text marks that carry meaning (WCAG 1.4.11, 3:1): the focus ring and the selection rule are
 * drawn in `fg`, on any solid ground.
 */
export const NON_TEXT_PAIRS: ReadonlyArray<readonly [ColorKey, Ground]> = [
  ['fg', 'bg'],
  ['fg', 'panel'],
  ['fg', 'raise'],
];

/** Keys the contrast rule doesn't apply to, and why. */
export const CONTRAST_EXEMPT: Readonly<Partial<Record<ColorKey, string>>> = {
  line: 'a decorative hairline; never the sole boundary of a control',
  line2: 'a stronger rule (table heads, input underlines); the input is also known by its label',
  'fg-disabled': 'disabled text — WCAG 1.4.3 exempts inactive controls',
  'bad-dim': "an armed danger button's label while it waits — an inactive state",
  'inv-bg': 'a plate; its ink is checked in PLATE_PAIRS',
  'inv-fg': 'checked against inv-bg in PLATE_PAIRS',
  'acc-glow': 'a glow, not a surface',
  'warn-glow': 'a glow, not a surface',
  'bad-glow': 'a glow, not a surface',
  glow: 'a glow, not a surface',
  'warn-line': "the missing-data gate's border; the gate is also known by its fill and words",
  plate: 'a plate over the map; text on it sits on plate-solid or is checked there',
  'map-plate': "a plate over imagery; what it sits on is the photo's, not the theme's",
  'map-foot': 'the map foot strip; within a hair of the field',
  scrim: 'a dim, not a ground',
  'scrim-deep': 'a dim, not a ground',
  shade: 'a shadow color',
  'shade-strong': 'a shadow color',
  'shade-deep': 'a shadow color',
};

/** Data scales (temperature, bathymetry) are readings with their own rules, not chrome. */
export const isDataKey = (key: string): boolean =>
  key.startsWith('temp-') || key.startsWith('depth-');
