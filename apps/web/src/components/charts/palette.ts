/**
 * The operator-chart palette (Phase 7b). Categorical hues drawn from `@skating/design`'s ramps and
 * **validated with the dataviz skill's checker** — not eyeballed. Both orders pass the lightness band,
 * the chroma floor, adjacent-pair CVD separation (deutan/protan/tritan), the normal-vision floor, and
 * surface contrast for their mode; green is placed away from red so no colorblind-adjacent pair is a
 * red/green one. The amber slot trips only the sub-3:1 contrast WARN, which the skill discharges with a
 * secondary encoding — every categorical chart here also carries a legend and a table view, so identity
 * is never color-alone (D34 a11y).
 *
 * Two orders because dark mode is *stepped*, not flipped (D34): the light hues would wash out on the
 * dark surface, so each maps to a darker ramp step that still clears the dark band.
 */

/** Fixed categorical order — assigned by position, NEVER cycled (dataviz non-negotiable). */
export const CHART_SERIES_LIGHT = [
  '#159143', // success-600 — green, kept away from the red slot
  '#0884ab', // ice-600
  '#e39a09', // warning-500 — amber (carries a legend + table for the contrast WARN)
  '#8b5cf6', // violet-500
  '#c81e2b', // danger-600 — red
] as const;

export const CHART_SERIES_DARK = [
  '#159143',
  '#0884ab',
  '#bd7304', // warning-600 — darker amber clears the dark band + contrast
  '#8b5cf6',
  '#e0404b', // danger-500
] as const;

/** The categorical order for the resolved theme. A 6th series is a design smell — fold into "Other". */
export function chartSeries(dark: boolean): readonly string[] {
  return dark ? CHART_SERIES_DARK : CHART_SERIES_LIGHT;
}

/**
 * Status hues for the few charts whose categories carry inherent meaning — a funnel stage, a
 * good/bad split, a gate verdict. Reserved (dataviz rule) and never reused as "series N"; each is only
 * ever shown with its own label, so meaning is never color-alone.
 */
export const CHART_STATUS = {
  good: { light: '#159143', dark: '#22b455' },
  warning: { light: '#e39a09', dark: '#f7b917' },
  bad: { light: '#c81e2b', dark: '#e0404b' },
  neutral: { light: '#526b81', dark: '#728da3' },
} as const;

export type ChartStatus = keyof typeof CHART_STATUS;

export function statusColor(status: ChartStatus, dark: boolean): string {
  return CHART_STATUS[status][dark ? 'dark' : 'light'];
}

/**
 * Recessive grid/axis/tooltip colors, read from the app's semantic CSS tokens so a chart tracks the
 * active theme without a second source of truth. `border` for gridlines, `foreground-muted` for tick
 * labels — text always wears a text token, never a series color (dataviz rule).
 */
export const CHART_TOKENS = {
  grid: 'var(--color-border)',
  axis: 'var(--color-foreground-muted)',
  tooltipBg: 'var(--color-surface)',
  tooltipBorder: 'var(--color-border)',
  tooltipText: 'var(--color-foreground)',
} as const;
