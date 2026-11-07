/**
 * Unit classes (D233): every length says which kind it is, and the generator refuses the wrong kind.
 *
 * - **rem** — what should grow with the user's font size: type sizes, spacing, gaps, control and row
 *   heights, layout widths, breakpoints. Authored as the mock's px and stored as px ÷ 16 (the root
 *   font size is never set; the user agent owns it).
 * - **em** — letter-spacing, and insets that track their own element's type size.
 * - **ratio** — line-height, always unitless so it inherits correctly.
 * - **px** — drawing, not reading: borders and hairlines, focus rings, radii, shadows, fixed-stroke
 *   graphics and the 1–3 px optical nudges.
 */

/** The four ways a length may be written. */
export const UNIT_CLASSES = ['rem', 'em', 'px', 'ratio'] as const;
export type UnitClass = (typeof UNIT_CLASSES)[number];

/** A length tagged with its unit class. `value` is in that unit (rem, em, px, or a bare ratio). */
export interface Length {
  readonly unit: UnitClass;
  readonly value: number;
}

/** The base the mocks' px convert at (D233): `13px` → `0.8125rem`. */
export const REM_BASE_PX = 16;

/** A rem length from the mock's px at the 16 px base. */
export const rem = (mockPx: number): Length => ({ unit: 'rem', value: mockPx / REM_BASE_PX });
/** An em length. */
export const em = (value: number): Length => ({ unit: 'em', value });
/** A px length — only for drawing (see the module note). */
export const px = (value: number): Length => ({ unit: 'px', value });
/** A unitless ratio (line-height). */
export const ratio = (value: number): Length => ({ unit: 'ratio', value });

/**
 * Every group of length tokens and the one unit class its members must use. Token names say which
 * they are by their group: a `fontSize` is rem, a `border` is px, and so on.
 */
export const GROUP_UNIT = {
  fontSize: 'rem',
  space: 'rem',
  size: 'rem',
  breakpoint: 'rem',
  tracking: 'em',
  leading: 'ratio',
  nudge: 'px',
  radius: 'px',
  border: 'px',
} as const satisfies Record<string, UnitClass>;
export type LengthGroup = keyof typeof GROUP_UNIT;

/** Thrown when a length is written in a unit class its group doesn't allow. */
export class UnitClassError extends Error {
  override readonly name = 'UnitClassError';
}

/**
 * Refuse any length whose unit isn't its group's class, and any non-finite or negative value
 * (tracking alone may be negative — the wordmark's is). Returns the lengths untouched when they pass.
 */
export function assertUnitClass<T extends Record<string, Length>>(
  group: LengthGroup,
  lengths: T,
): T {
  const expected = GROUP_UNIT[group];
  for (const [name, length] of Object.entries(lengths)) {
    if (length.unit !== expected) {
      throw new UnitClassError(
        `${group}.${name} is ${length.value}${length.unit}, but ${group} must be ${expected}`,
      );
    }
    if (!Number.isFinite(length.value) || (group !== 'tracking' && length.value < 0)) {
      throw new UnitClassError(`${group}.${name} has an invalid value: ${length.value}`);
    }
  }
  return lengths;
}

/** Trim a number to at most 4 decimals with no trailing zeros, for stable output. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000 + 0);
}

/** A length as CSS: `0.8125rem`, `0.22em`, `1px`, `1.45`. Zero lengths keep their unit. */
export function toCssLength(length: Length): string {
  const n = formatNumber(length.value);
  return length.unit === 'ratio' ? n : `${n}${length.unit}`;
}

/**
 * A length as a React Native number. rem and px become dp (rem × 16); em and ratio stay multipliers,
 * because React Native's `letterSpacing` and `lineHeight` are absolute — the consumer multiplies
 * by the font size it is setting.
 */
export function toNativeNumber(length: Length): number {
  const value = length.unit === 'rem' ? length.value * REM_BASE_PX : length.value;
  return Math.round(value * 10_000) / 10_000 + 0;
}
