/**
 * Minimum touch targets for controls that are visually smaller than a finger.
 *
 * Android's Material guidance and WCAG 2.5.8 both put the floor at 48dp (iOS says 44pt); Tamagui's
 * small button sizes land well under it — `$2` renders 28dp and `$3` renders 36dp. A 28dp control is
 * genuinely hard to hit, and it reads as the control "not working" rather than as a near miss,
 * because nothing happens when you're 6dp off.
 *
 * `hitSlop` is the right lever: it grows the *touch* rectangle without touching layout, so a compact
 * row of segmented buttons keeps its design and stops being a precision test. Prefer this over
 * bumping `size`, which would reflow the screens these sit in.
 */

/** WCAG 2.5.8 / Material minimum, in dp. iOS's 44pt is smaller, so this satisfies both. */
export const MIN_TAP_TARGET = 48;

/** Tamagui's rendered heights for the small button sizes, so the slop math isn't magic numbers. */
const RENDERED_HEIGHT = { $1: 20, $2: 28, $3: 36, $4: 44 } as const;

export type SmallButtonSize = keyof typeof RENDERED_HEIGHT;

/**
 * The `hitSlop` that lifts a button of the given Tamagui size to {@link MIN_TAP_TARGET}.
 *
 * Applied on all four edges. Horizontally that's usually generous already, but a segmented row is
 * only as wide as its label, so the same padding is wanted on both axes. Adjacent controls can't
 * "steal" each other's taps: React Native resolves overlapping hit rects to the topmost view, and
 * these sit side by side rather than stacked.
 */
export function tapTargetSlop(size: SmallButtonSize): number {
  return Math.max(0, Math.ceil((MIN_TAP_TARGET - RENDERED_HEIGHT[size]) / 2));
}
