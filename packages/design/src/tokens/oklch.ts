/**
 * OKLCH color math — the one place a token color is converted, composited or measured (D232).
 *
 * Every token color is authored as OKLCH (`l` 0–1, `c` ≥ 0, `h` degrees, optional `alpha`). This
 * module turns that into each consumer's format (CSS `oklch()`, hex / `rgba()` for React Native,
 * which parses no `oklch()`), and computes WCAG contrast straight from the OKLCH source so a ramp
 * edit fails the contrast suite before it ships. Conversion goes through culori; everything else is
 * small, pure arithmetic.
 */

import { clampChroma, converter, differenceCiede2000, formatHex } from 'culori';

/** An OKLCH color. `h` is 0 for an achromatic color (`c` 0); `alpha` is omitted when opaque. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha?: number;
}

/** An sRGB color with 0–1 channels and an alpha. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

const toOklchMode = converter('oklch');
const toRgbMode = converter('rgb');
const deltaE2000 = differenceCiede2000();

/** Decimal places kept in source: enough that every audited hex survives the round trip exactly. */
export const OKLCH_PRECISION = { l: 4, c: 4, h: 2 } as const;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  // `+ 0` turns a `-0` into `0`, so a rounded value never prints as "-0".
  return Math.round(value * factor) / factor + 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Round an OKLCH color to source precision. Achromatic colors get `c` 0 and `h` 0. */
export function roundOklch(color: Oklch): Oklch {
  const c = round(color.c, OKLCH_PRECISION.c);
  const rounded = {
    l: round(color.l, OKLCH_PRECISION.l),
    c,
    h: c === 0 ? 0 : round(((color.h % 360) + 360) % 360, OKLCH_PRECISION.h),
  };
  return color.alpha === undefined || color.alpha >= 1
    ? rounded
    : { ...rounded, alpha: round(color.alpha, 4) };
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into OKLCH at source precision. Used by the one-time
 * audit conversion and by tests; nothing at runtime parses hex.
 */
export function hexToOklch(hex: string): Oklch {
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    throw new Error(`Not a hex color: ${hex}`);
  }
  const parsed = toOklchMode(hex);
  /* v8 ignore next -- the regex above admits only strings culori parses */
  if (!parsed) throw new Error(`Not a hex color: ${hex}`);
  return roundOklch({ l: parsed.l, c: parsed.c, h: parsed.h ?? 0, alpha: parsed.alpha });
}

/** OKLCH → sRGB, channels clamped into 0–1 (gamut-map first with `toGamut` if that matters). */
export function toRgb(color: Oklch): Rgb {
  const rgb = toRgbMode({ mode: 'oklch', l: color.l, c: color.c, h: color.h });
  return {
    r: clamp01(rgb.r),
    g: clamp01(rgb.g),
    b: clamp01(rgb.b),
    alpha: color.alpha ?? 1,
  };
}

/** Reduce chroma (keeping lightness and hue) until the color fits sRGB, at source precision. */
export function toGamut(color: Oklch): Oklch {
  const mapped = clampChroma({ mode: 'oklch', l: color.l, c: color.c, h: color.h }, 'oklch', 'rgb');
  const fitted = roundOklch({
    l: mapped.l,
    c: mapped.c,
    h: mapped.h ?? color.h,
    alpha: color.alpha,
  });
  // Rounding chroma up can step back over the gamut edge; shave it until it fits.
  let c = fitted.c;
  while (c > 0 && !inGamut({ ...fitted, c })) c = round(c - 0.0001, OKLCH_PRECISION.c);
  return { ...fitted, c, h: c === 0 ? 0 : fitted.h };
}

/** Whether the color is inside sRGB (a hair of float slack allowed). */
export function inGamut(color: Oklch): boolean {
  const rgb = toRgbMode({ mode: 'oklch', l: color.l, c: color.c, h: color.h });
  const eps = 1e-4;
  return [rgb.r, rgb.g, rgb.b].every((v) => v >= -eps && v <= 1 + eps);
}

function byte(channel: number): number {
  return Math.round(clamp01(channel) * 255);
}

/** `#rrggbb` for the color's RGB, ignoring alpha. */
export function toHex(color: Oklch): string {
  const { r, g, b } = toRgb(color);
  return formatHex({ mode: 'rgb', r, g, b });
}

/**
 * A React Native color string: `#rrggbb` when opaque, `rgba(r, g, b, a)` otherwise. React Native's
 * parser accepts hex, `rgb()`, `hsl()` and `hwb()` — never `oklch()` — so mobile gets these.
 */
export function toNativeColor(color: Oklch): string {
  const alpha = round(color.alpha ?? 1, 4);
  if (alpha >= 1) return toHex(color);
  const { r, g, b } = toRgb(color);
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${alpha})`;
}

/** A CSS `oklch()` string: `oklch(0.6 0.12 210)` or `oklch(0.6 0.12 210 / 0.1)`. */
export function toCssOklch(color: Oklch): string {
  const { l, c, h, alpha } = roundOklch(color);
  const body = `${l} ${c} ${h}`;
  return alpha === undefined ? `oklch(${body})` : `oklch(${body} / ${alpha})`;
}

/** The same color with a different alpha (1 drops it). */
export function withAlpha(color: Oklch, alpha: number): Oklch {
  const { l, c, h } = color;
  return alpha >= 1 ? { l, c, h } : { l, c, h, alpha };
}

/**
 * Paint `top` (possibly translucent) over an opaque `bottom`, the way a browser does — in gamma
 * sRGB — and return the opaque result. This is what text actually sits on when its ground is a
 * wash or a lift.
 */
export function composite(top: Oklch, bottom: Oklch): Rgb {
  const t = toRgb(top);
  const b = toRgb(bottom);
  const a = t.alpha;
  return {
    r: t.r * a + b.r * (1 - a),
    g: t.g * a + b.g * (1 - a),
    b: t.b * a + b.b * (1 - a),
    alpha: 1,
  };
}

function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque sRGB color (alpha ignored). */
export function luminanceOfRgb(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** WCAG contrast between two opaque sRGB colors, in `[1, 21]`. */
export function contrastOfRgb(a: Rgb, b: Rgb): number {
  const la = luminanceOfRgb(a);
  const lb = luminanceOfRgb(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * WCAG contrast of `fg` over `ground`, computed from the OKLCH source. A translucent `fg` is
 * composited over the ground first, so a 42 % red label is measured as it renders.
 */
export function contrastOklch(fg: Oklch, ground: Oklch): number {
  const opaqueGround = toRgb(withAlpha(ground, 1));
  return contrastOfRgb(composite(fg, withAlpha(ground, 1)), opaqueGround);
}

/** CIEDE2000 difference between two colors (alpha ignored); under ~1 is imperceptible. */
export function deltaE(a: Oklch, b: Oklch): number {
  return deltaE2000(
    { mode: 'oklch', l: a.l, c: a.c, h: a.h },
    { mode: 'oklch', l: b.l, c: b.c, h: b.h },
  );
}

/**
 * The color with `color`'s hue and (gamut-allowed) chroma whose contrast against `ground` is
 * `target`, on the side of the ground given by `direction` — the move that inverts a dark ramp
 * into a light one while keeping each step's distance from its ground.
 *
 * Bisects lightness. If the target can't be reached on that side (asking for 25:1, say) it returns
 * the extreme (lightness 0 or 1). Deterministic: a fixed iteration count over the rounded values.
 */
export function solveForContrast(
  color: Oklch,
  ground: Oklch,
  target: number,
  direction: 'darker' | 'lighter',
): Oklch {
  const opaqueGround = toRgb(withAlpha(ground, 1));
  const groundL = ground.l;
  const contrastAt = (l: number) =>
    contrastOfRgb(toRgb(toGamut({ l, c: color.c, h: color.h })), opaqueGround);
  // Search the half of the lightness axis on the requested side of the ground.
  let near = groundL;
  let far = direction === 'darker' ? 0 : 1;
  if (contrastAt(far) <= target) return toGamut({ l: far, c: color.c, h: color.h });
  for (let i = 0; i < 40; i++) {
    const mid = (near + far) / 2;
    if (contrastAt(mid) >= target) far = mid;
    else near = mid;
  }
  // `contrastAt` measures the rounded, gamut-mapped color, so `far` clears the target exactly as
  // it will be stored — no rounding afterwards can pull it back under.
  return toGamut({ l: far, c: color.c, h: color.h });
}

/** An opaque sRGB color (e.g. a composite) back to OKLCH at source precision. */
export function rgbToOklch(rgb: Rgb): Oklch {
  const c = toOklchMode({ mode: 'rgb', r: rgb.r, g: rgb.g, b: rgb.b });
  return roundOklch({ l: c.l, c: c.c, h: c.h ?? 0 });
}

/**
 * The alpha at which `base`, painted over `field`, stands `target`:1 off the field — how a light
 * map keeps a dark map's lift or wash at the same visual distance from its ground. Returns 1 when
 * even the solid base can't reach the target. Deterministic bisection, rounded to 4 decimals and
 * nudged up until the rounded alpha still reaches the target.
 */
export function solveAlphaForContrast(base: Oklch, field: Oklch, target: number): number {
  const opaqueField = withAlpha(field, 1);
  const fieldRgb = toRgb(opaqueField);
  const contrastAt = (alpha: number) =>
    contrastOfRgb(composite(withAlpha(base, alpha), opaqueField), fieldRgb);
  if (contrastAt(1) <= target) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (contrastAt(mid) >= target) high = mid;
    else low = mid;
  }
  let alpha = Math.ceil(high * 10_000) / 10_000;
  while (alpha < 1 && contrastAt(alpha) < target - 1e-9) alpha = round(alpha + 0.0001, 4);
  return alpha;
}
