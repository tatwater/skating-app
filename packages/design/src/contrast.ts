/**
 * WCAG 2.1 relative-luminance + contrast-ratio math.
 *
 * Readability outdoors in glare is a **safety feature** (D34/00-vision), so the
 * themes in `themes.ts` are held to WCAG AA by a test that runs these helpers
 * over every foreground/background pair. Kept pure and dependency-free.
 *
 * @see https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

/** WCAG AA minimum for normal-size text (and UI icons/graphics ≥ 3:1). */
export const WCAG_AA_NORMAL = 4.5
/** WCAG AA minimum for large text (≥ 18.66px bold / 24px regular). */
export const WCAG_AA_LARGE = 3

/** Parse a `#rgb` or `#rrggbb` hex string into 0–255 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.trim().replace(/^#/, '')
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  const int = Number.parseInt(full, 16)
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff]
}

/** Linearize a single 0–255 sRGB channel per WCAG. */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Relative luminance (0 = black, 1 = white) of a hex color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** Contrast ratio between two hex colors, in `[1, 21]`. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Whether `fg`/`bg` clear a contrast threshold (default: AA normal text). */
export function meetsContrast(fg: string, bg: string, threshold: number = WCAG_AA_NORMAL): boolean {
  return contrastRatio(fg, bg) >= threshold
}
