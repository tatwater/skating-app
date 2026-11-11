/**
 * Every non-color token: type, space, sizes, shape, layers, motion (D232, D233, D234).
 *
 * Seeded from the audited admin set (`skating-mockups/admin-variants/tokens.json`, 2026-10-30).
 * Lengths are written as the mock's px through `rem()` / `px()` / `em()` / `ratio()` so the unit
 * class is explicit at the definition, and every group is checked against its class by
 * `assertUnitClass` when the module loads — a length in the wrong class can't be exported.
 *
 * **Density rides the surface axis.** Type sizes, control and row heights and the semantic gaps
 * differ between the admin console and the skater app, so they are per-surface maps with one key
 * set. The skater values come from the skater web mocks (`skating-mockups/skater-web/*.css`,
 * 2026-10-30: "15 px body, 13 px assist, 11 px kickers, more air"). Everything else is shared.
 */

import { assertUnitClass, em, type Length, px, ratio, rem } from './units';

/** The two surfaces (the `data-surface` axis). */
export const SURFACES = ['admin', 'skater'] as const;
export type Surface = (typeof SURFACES)[number];

// ── Type ──────────────────────────────────────────────────────────────────────────────────────

/** Font-size keys: one set, sized per surface. */
export const FONT_SIZE_KEYS = [
  'rail',
  'kick',
  'mono-sm',
  'assist',
  'row',
  'body',
  'logo',
  'h',
  'stat',
  'disp',
  'disp-lg',
] as const;
export type FontSizeKey = (typeof FONT_SIZE_KEYS)[number];

/**
 * Font sizes per surface. Admin is the audit's scale. Skater moves each reading step up a pixel or
 * two, as its mocks do: kickers 11 (`.kick`), mono in rows 12 (`.tbl`; `.meta`'s 11.5 snapped up),
 * assist 13 (`.assist`), rows 14 (the mocks' most-used size), body 15 (`body`), a heading 17
 * (`.words .ti`, `.empty .ptt`), a headline value 20, the display word 22 (`.pnh .ttl`) and the
 * large display 26 (`.lh .disp`). The rail and the wordmark have no skater counterpart and keep
 * admin's sizes.
 *
 * The console has **one display size**, 20: its `disp-lg` is kept as a key (so the key set stays
 * whole and nothing that reads it breaks) but resolves to `disp`'s value. Skater keeps two.
 */
export const fontSize = {
  admin: assertUnitClass('fontSize', {
    rail: rem(8),
    kick: rem(10),
    'mono-sm': rem(11),
    assist: rem(12),
    row: rem(13),
    body: rem(14),
    logo: rem(15),
    h: rem(16),
    stat: rem(18),
    disp: rem(20),
    'disp-lg': rem(20), // one console display size: the same as `disp`
  }),
  skater: assertUnitClass('fontSize', {
    rail: rem(8),
    kick: rem(11),
    'mono-sm': rem(12),
    assist: rem(13),
    row: rem(14),
    body: rem(15),
    logo: rem(15),
    h: rem(17),
    stat: rem(20),
    disp: rem(22),
    'disp-lg': rem(26),
  }),
} as const satisfies Record<Surface, Record<FontSizeKey, Length>>;

/**
 * Families. Saira for everything typeset; Martian Mono for every value that aligns.
 *
 * Each stack leads with the name the web app's copy of the face registers under: `apps/web`
 * self-hosts both through Fontsource's variable packages, which declare their `@font-face` as
 * `Saira Variable` and `Martian Mono Variable`. The face's own name comes next, for whatever loads
 * it under that name (Paper, the mocks) — never ahead of the served file, or a machine with the
 * face installed locally would render something other than what every reader gets.
 */
export const fontFamily = {
  sans: ['Saira Variable', 'Saira', 'system-ui', 'sans-serif'],
  mono: ['Martian Mono Variable', 'Martian Mono', 'ui-monospace', 'Menlo', 'monospace'],
} as const;

/** Weights. 800 is the wordmark only. */
export const fontWeight = {
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  extrabold: 800,
} as const;

/** Letter-spacing, in em (D233). Caps are always tracked .1 em or more. */
export const tracking = assertUnitClass('tracking', {
  logo: em(-0.03),
  value: em(0.02),
  micro: em(0.04),
  key: em(0.06),
  rail: em(0.1),
  disp: em(0.12),
  label: em(0.16),
  head: em(0.2),
  kick: em(0.22),
});

/** Line-height, as unitless ratios (D233). */
export const leading = assertUnitClass('leading', {
  tight: ratio(1),
  snug: ratio(1.2),
  list: ratio(1.35),
  body: ratio(1.45),
  loose: ratio(1.8),
});

// ── Space ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The spacing ruler: 4 px steps with half steps, in rem, shared by both surfaces (it is a ruler,
 * not a density). `_5` is Tailwind's `.5` — a CSS name can't hold a dot. Step `n` is always
 * `n × 0.25rem`, which is exactly Tailwind v4's default `--spacing` arithmetic, so `p-4` and
 * `--space-4` agree without wiring the scale into Tailwind.
 */
export const space = assertUnitClass('space', {
  '0_5': rem(2),
  '1': rem(4),
  '1_5': rem(6),
  '2': rem(8),
  '2_5': rem(10),
  '3': rem(12),
  '3_5': rem(14),
  '4': rem(16),
  '4_5': rem(18),
  '5': rem(20),
  '5_5': rem(22),
  '6': rem(24),
  '7': rem(28),
  '8': rem(32),
  '10': rem(40),
  '14': rem(56),
  '20': rem(80),
});

/** Optical nudges stay px (D233): a rule's overlap, a key's 1 px shift. */
export const nudge = assertUnitClass('nudge', { px: px(1) });

/** Semantic gap keys — the spacing that differs by surface. */
export const GAP_KEYS = ['gutter', 'heading', 'bar-x', 'bar-gap', 'hit-x', 'hit-y'] as const;
export type GapKey = (typeof GAP_KEYS)[number];

/**
 * Semantic gaps per surface (D234: each states a visual, content-to-content distance).
 *
 * - `gutter` — a pane's inset: admin 20 (`spacing.5`), skater 28 (`.pnh`, `.nws`).
 * - `heading` — a heading over its content: 12 on both (the app-wide rule; skater `.sec`).
 * - `bar-x` / `bar-gap` — the top bar's side padding and group gap: admin 22 / 14, skater 24 / 28.
 * - `hit-x` / `hit-y` — the padding an interactive row or cell carries, which the kit bleeds back
 *   out with a negative margin so the *content* lands on the gap (D234's token pair): admin 8 / 6
 *   (a table cell), skater 12 / 10 (its list rows and choice chips, snapped to the ruler).
 */
export const gap = {
  admin: assertUnitClass('space', {
    gutter: rem(20),
    heading: rem(12),
    'bar-x': rem(22),
    'bar-gap': rem(14),
    'hit-x': rem(8),
    'hit-y': rem(6),
  }),
  skater: assertUnitClass('space', {
    gutter: rem(28),
    heading: rem(12),
    'bar-x': rem(24),
    'bar-gap': rem(28),
    'hit-x': rem(12),
    'hit-y': rem(10),
  }),
} as const satisfies Record<Surface, Record<GapKey, Length>>;

// ── Sizes of recurring parts ──────────────────────────────────────────────────────────────────

/** Size keys: frame, columns, sheets, parts, people. */
export const SIZE_KEYS = [
  'status',
  'top',
  'rail',
  'rail-item',
  'key',
  'pill',
  'badge',
  'btn-xs',
  'btn-sm',
  'btn',
  'lane',
  'td',
  'avatar-sm',
  'avatar',
  'avatar-lg',
  'search',
  'lanes',
  'tape',
  'list',
  'inspector',
  'sheet-sm',
  'sheet-md',
  'drawer',
  'sheet',
] as const;
export type SizeKey = (typeof SIZE_KEYS)[number];

const adminSize = assertUnitClass('size', {
  status: rem(26),
  top: rem(44),
  rail: rem(64),
  'rail-item': rem(52),
  key: rem(16),
  pill: rem(17),
  badge: rem(20),
  'btn-xs': rem(22),
  'btn-sm': rem(24),
  btn: rem(28),
  lane: rem(28),
  td: rem(32),
  'avatar-sm': rem(16),
  avatar: rem(20),
  'avatar-lg': rem(26),
  search: rem(200),
  lanes: rem(236),
  tape: rem(240),
  list: rem(340),
  inspector: rem(380),
  'sheet-sm': rem(440),
  'sheet-md': rem(500),
  drawer: rem(820),
  sheet: rem(1000),
});

/**
 * Sizes per surface. Skater differs where its mocks draw the same part larger: the top bar 56,
 * keys 18 (`.key`), buttons 36 / small 30 / in-row 28 (`.btn`, `.btn.sm`, `.pick`), a table row
 * 36 (`.cal`), people 22 / 28 / 30 (`.ppl .av`, `.av`, `.me`), and the search field 460
 * (`.top .search`'s max width). Parts the skater app doesn't have (rail, status bar, lanes, tape)
 * keep admin's values so the key set stays whole.
 */
export const size = {
  admin: adminSize,
  skater: assertUnitClass('size', {
    ...adminSize,
    top: rem(56),
    key: rem(18),
    'btn-xs': rem(28),
    'btn-sm': rem(30),
    btn: rem(36),
    td: rem(36),
    'avatar-sm': rem(22),
    avatar: rem(28),
    'avatar-lg': rem(30),
    search: rem(460),
  }),
} as const satisfies Record<Surface, Record<SizeKey, Length>>;

/**
 * Breakpoints, in rem so they move with the user's font size (D233). Shared by both surfaces.
 * Media queries can't read custom properties, so these are emitted as literals.
 */
export const breakpoint = assertUnitClass('breakpoint', {
  phone: rem(390),
  compact: rem(600),
  desktop: rem(1440),
});

// ── Shape ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Radii, in px (drawing). **Only what you can press is rounded; containers are square.**
 *
 * - `container` — badges, tags, cards, panels, popovers, tooltips, dialogs and sheets: square on
 *   both surfaces.
 * - `control` — anything pressable (buttons, inputs, selectable chips, clickable rows). Per
 *   surface; see `controlRadius` below.
 * - `key` — keyboard hints, rounded like chiclet keys on both surfaces: the one container that
 *   isn't square.
 * - `toggle` — a switch's track; `full` — people's circles and dots.
 */
export const radius = assertUnitClass('radius', {
  none: px(0),
  container: px(0),
  key: px(3),
  toggle: px(6),
  full: px(9999),
});

/** Radius keys that differ by surface. */
export const SURFACE_RADIUS_KEYS = ['control'] as const;
export type SurfaceRadiusKey = (typeof SURFACE_RADIUS_KEYS)[number];

/**
 * The control radius per surface: skater's pressable things take 2 px; the console's stay square.
 * Whether console controls move to 2 px is an open call, and either answer is this one value.
 */
export const controlRadius = {
  admin: assertUnitClass('radius', { control: px(0) }),
  skater: assertUnitClass('radius', { control: px(2) }),
} as const satisfies Record<Surface, Record<SurfaceRadiusKey, Length>>;

/** Border widths, in px (drawing). */
export const border = assertUnitClass('border', {
  hair: px(1),
  note: px(2),
  run: px(3),
  now: px(4),
  tick: px(6),
});

/** Opacity steps. */
export const opacity = {
  dim: 0.28,
  disabled: 0.4,
  muted: 0.5,
} as const;

/** Stacking order; meaningful and consistent, kept from the audit. */
export const zIndex = {
  raised: 1,
  'map-control': 2,
  plate: 3,
  tip: 4,
  menu: 5,
  actbar: 6,
  icard: 8,
  gobar: 9,
  toast: 20,
  scrim: 40,
  sheet: 41,
  'viewer-scrim': 50,
  viewer: 51,
} as const;

// ── Motion ────────────────────────────────────────────────────────────────────────────────────

/**
 * Durations in ms: a small set, crisp rather than floaty. `lamp` is the status lamp's breath.
 * Under `prefers-reduced-motion: reduce` the CSS output sets every one to 0ms.
 */
export const duration = {
  instant: 80,
  fast: 120,
  base: 200,
  slow: 320,
  lamp: 2400,
} as const;

/** Easing curves. `standard` for moves, `enter` / `exit` for things arriving and leaving. */
export const easing = {
  standard: [0.2, 0, 0, 1],
  enter: [0, 0, 0.2, 1],
  exit: [0.4, 0, 1, 1],
  lamp: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
