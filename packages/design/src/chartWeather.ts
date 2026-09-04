/**
 * The weather-timeline chart scale — **the one place its literal colors live** (N6h Workstream D).
 *
 * ## Why this is not `themes.ts`
 *
 * Semantic tokens answer *"what role does this play in the UI"* — surface, border, danger. A data
 * scale answers a different question: *"what value does this color stand for"*. Those are not the
 * same job, and mapping a temperature band onto `warning` would mean any future re-tune of the
 * caution color silently re-tunes the meaning of 35°F. So the scale gets its own module, and the
 * roles stay out of it.
 *
 * ## Why it is not built purely from the `colors.ts` ramps, which was tried first
 *
 * The primitive ramps were drawn for UI surfaces, and their cool end is deliberately desaturated —
 * which is right for a border and wrong for a data mark. Measured, on white: `ice[700]` (`#0e698b`)
 * sits at OKLCH chroma **0.094** against a 0.10 floor, i.e. it reads as gray rather than as a hue;
 * `ice[800]` is worse (0.077). Every light-mode combination assembled only from existing steps failed
 * either that floor or the 3:1 contrast check. The four light-mode values below are therefore new,
 * and they are new for a measured reason rather than an aesthetic one.
 *
 * ## Every value here was validated, not chosen by eye
 *
 * Checked with the data-viz palette validator (OKLab ΔE×100 under Machado-Oliveira-Fernandes CVD
 * simulation, OKLCH lightness/chroma, WCAG contrast), all-pairs, against each mode's real `surface`
 * token — `#ffffff` for light and `neutral[900]` (`#151d26`) for dark:
 *
 * | scale | mode | chroma | CVD ΔE (worst pair) | normal ΔE | contrast |
 * |---|---|---|---|---|---|
 * | temperature | light | PASS | 15.4 | 16.1 | PASS (all ≥3:1) |
 * | temperature | dark | PASS | 16.6 | 17.5 | PASS |
 * | precipitation | light | (snow neutral by intent) | 17.8 | 19.3 | PASS |
 * | precipitation | dark | (snow neutral by intent) | 20.3 | 23.1 | PASS |
 *
 * Two checks are **deliberately not met**, and both are the validator's categorical rules being
 * applied to something that is not a categorical palette:
 *
 * - **Lightness band (dark).** A categorical palette keeps every slot at similar lightness so no slot
 *   looks "bigger" than another. {@link WEATHER_TEMPERATURE_SCALE} is *diverging* — the whole design
 *   is that both extremes are vivid and the middle recedes — so varying lightness is the encoding,
 *   not a defect. The dark steps sit *above* the band (brighter than it asks), which on a dark
 *   surface means more contrast rather than less.
 * - **Chroma floor (snow).** `snow` is a near-neutral on purpose. The floor exists to catch a hue
 *   that accidentally reads as gray; snow reading as gray-white is the intended meaning.
 *
 * ⚠ **Re-run the validator if any value here changes.** Adjacent-pair separation is not eyeballable —
 * an earlier draft of the warm pole (`warning[300]` → `warning[500]`) looked obviously distinct and
 * measured ΔE 14.3, under the 15 floor for full-color vision.
 */

import { ice, neutral, warning } from './colors';

/**
 * Temperature bands, cold → warm. **The break between `cold` and `thaw` is 32°F**, and it is the only
 * boundary in this app that carries real meaning.
 *
 * Four bands rather than a continuous ramp because a reader is asking a categorical question ("was it
 * below freezing?") and only secondarily a quantitative one — and because the line's *y position*
 * already carries the precise value. Color here is redundant reinforcement of the threshold, which is
 * what makes it readable at a glance instead of requiring the eye to trace against a rule.
 */
export const TEMPERATURE_BANDS = ['deepCold', 'cold', 'thaw', 'warm'] as const;
export type TemperatureBand = (typeof TEMPERATURE_BANDS)[number];

/**
 * Band edges in **°F**, as the founder specified them.
 *
 * `deepCold` runs below 20, `cold` 20→32, `thaw` 32→40, `warm` above 40. Held in Fahrenheit because
 * that is the unit they were reasoned about in and the unit the app displays (D25); the geometry
 * converts once.
 */
export const TEMPERATURE_BAND_EDGES_F = { deepCold: 20, freezing: 32, thaw: 40 } as const;

/** Per-mode temperature colors. Cold poles are cyan, warm poles amber-orange — opposite by design. */
export const WEATHER_TEMPERATURE_SCALE = {
  light: {
    /** Below 20°F. New literal: no `ice` step this dark clears the chroma floor (see module doc). */
    deepCold: '#075985',
    /** 20–32°F. */
    cold: '#0e8fb5',
    /** 32–40°F. */
    thaw: '#b07404',
    /** Above 40°F. */
    warm: '#8a3d05',
  },
  dark: {
    /**
     * Below 20°F — the brightest step in the scale.
     *
     * ⚠ **Brightness runs to the extremes here, not up the scale**, which is the opposite of a
     * sequential ramp and is intended. A hard freeze and a thaw are both events worth seeing; 30°F is
     * not. Making the coldest step *dimmer* (the first draft, reading "stronger blue" as "darker
     * blue") buried the condition a skater most wants to spot against a dark surface.
     */
    deepCold: ice[300],
    /** 20–32°F — the muted cold side of the divergence. */
    cold: ice[500],
    /** 32–40°F. */
    thaw: warning[300],
    /** Above 40°F. New literal: the `warning` ramp has no step that reads as orange rather than amber. */
    warm: '#f97316',
  },
} as const satisfies Record<'light' | 'dark', Record<TemperatureBand, string>>;

/**
 * How precipitation is drawn: **two colors and one texture, not five colors.**
 *
 * The archive can name five or more precipitation types once `weather_code` is requested, and at the
 * timeline's real density — roughly 2.2 px per hour over a 7-day window, ~0.5 px at 30 days — a
 * two-hour sleet event is four pixels wide. No fill, hue or hatch separates five classes at that
 * size, so trying would encode information nowhere except in the legend.
 *
 * So the *drawing* carries the axis that survives four pixels — **solid / liquid / froze-on-contact** —
 * and the exact type is named in words by the scrub readout, where there is room to be precise. Hatch
 * means "this arrived wet and froze", which is the one precipitation fact that changes a skating
 * surface rather than merely wetting it.
 */
export const WEATHER_PRECIPITATION_SCALE = {
  light: { snow: neutral[400], rain: '#2563eb' },
  dark: { snow: neutral[200], rain: '#4f9ae8' },
} as const satisfies Record<'light' | 'dark', { snow: string; rain: string }>;

/**
 * The auxiliary lanes (wind, sun, snow depth) draw in **neutrals, plus two borrowed colors**.
 *
 * Not a fifth, sixth and seventh hue. Each of those lanes is a single series in its own labelled
 * strip, so it needs no hue to establish identity — position already does that — and the anti-pattern
 * of "more than ~7 color classes carrying meaning" is real at this size.
 *
 * `sunLit` is the exception, and it is a *reference* rather than a new meaning: the sun trace is
 * yellow whenever the sun is actually up and neutral when it is not, so the lane reads as daylight at
 * a glance. Neutral is doing real work there too — it is the one color that can mean both "night" and
 * "overcast", which is exactly the pair of things a zero reading covers.
 *
 * `control` is the scrubber thumb and the scrub crosshair. ⚠ **Deliberately not a data color.** Those
 * are chrome, and chrome that borrows a scale's hue starts looking like a reading — the thumb sitting
 * under the wind lane in the same blue as a wind mark was already ambiguous.
 */
export const WEATHER_AUX_SCALE = {
  light: { trace: neutral[400], fill: neutral[200], control: ice[600], sunLit: '#b07404' },
  dark: { trace: neutral[500], fill: neutral[700], control: ice[400], sunLit: warning[300] },
} as const satisfies Record<
  'light' | 'dark',
  { trace: string; fill: string; control: string; sunLit: string }
>;

/**
 * The emphasis color for a lane whose condition is a **conjunction with temperature**.
 *
 * ⚠ **Borrowed from the temperature poles rather than picked, and that is the whole point.** Both
 * auxiliary emphases are defined by which side of freezing they sit on — wind is highlighted when it
 * was calm *and below* freezing, sun when it was bright *and above* — so painting them in the
 * temperature scale's own cold and warm poles makes the chart say one consistent thing with color:
 * **cyan is the cold side, orange is the warm side, everywhere.**
 *
 * An earlier version used a single shared blue for both, which quietly asserted the opposite: a sunny
 * thaw, which is the condition that softens a skating surface, was drawn in the same color as the
 * hard freeze that makes black ice.
 */
export function emphasisColor(mode: 'light' | 'dark', side: 'cold' | 'warm'): string {
  return side === 'cold'
    ? WEATHER_TEMPERATURE_SCALE[mode].deepCold
    : WEATHER_TEMPERATURE_SCALE[mode].warm;
}

/** Every weather-chart color for one theme, as the renderers consume it. */
export interface WeatherChartPalette {
  temperature: Record<TemperatureBand, string>;
  precipitation: { snow: string; rain: string };
  aux: { trace: string; fill: string; control: string; sunLit: string };
  /** Pre-resolved so a renderer never has to remember which pole a lane belongs to. */
  emphasis: { cold: string; warm: string };
}

/** Resolve the whole chart palette for a theme — one call per render, no per-mark lookups. */
export function weatherChartPalette(mode: 'light' | 'dark'): WeatherChartPalette {
  return {
    temperature: WEATHER_TEMPERATURE_SCALE[mode],
    precipitation: WEATHER_PRECIPITATION_SCALE[mode],
    aux: WEATHER_AUX_SCALE[mode],
    emphasis: { cold: emphasisColor(mode, 'cold'), warm: emphasisColor(mode, 'warm') },
  };
}
