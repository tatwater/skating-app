/**
 * Geometry for the past-weather timeline — **pure, and deliberately not a component** (N6h
 * Workstream D).
 *
 * The same picture ships on the web app (SVG) and in the native app (`react-native-svg`), which share
 * no element types at all. What they can share is the arithmetic, so this module returns plain
 * coordinates and band *names*, and the renderers do nothing but map those onto their own primitives
 * and their theme's palette. Same split as `windRoseChart.ts`, for the same reason: a chart built
 * twice is two subtly different charts, and mobile has no test harness to catch the drift.
 *
 * ⚠ **No color literal appears in this file.** A mark carries a semantic band (`'deepCold'`,
 * `'snow'`) and the renderer resolves it against `@skating/design`'s validated scale. Core cannot
 * know which theme is mounted, and a hex here would be a third palette to keep in sync.
 *
 * ## What the picture is for, which is not "more detail"
 *
 * The seven-column strip it replaces shows each day's high and low. It cannot show **order**, and
 * order is most of the story: snow at 2 PM Tuesday and then a hard freeze Tuesday night is a
 * completely different surface from a freeze that was later buried. A continuous axis is the only
 * layout that carries that, and carrying it is the entire justification for the extra height.
 *
 * ## Lanes, not an overlay
 *
 * Five measures share **only the x axis**. Each owns a horizontal band with its own vertical scale,
 * because a shared y would mean plotting °F, mm, kph and W/m² against one axis — the dual-axis
 * anti-pattern, which invents correlations the data does not contain by making the alignment of two
 * scales look meaningful when it is arbitrary.
 *
 * ## The rule every auxiliary lane follows
 *
 * **Draw the whole series, emphasise the condition.** Wind is drawn for every hour and emphasised
 * while it was both freezing and calm; sun is drawn for every hour and emphasised while it was both
 * sunlit and above freezing. Those two emphases are *conjunctions with temperature* — the simultaneity
 * that a column layout destroys — so they are the payload, and the base trace is the context that
 * makes them legible as exceptions rather than as isolated marks.
 *
 * ## Three rules inherited from the panel this sits in
 *
 * - **Observation, never counsel (D3 / D150).** Nothing here scores, ranks or warns. `meltIndexMm`
 *   and the freezing-degree integrals are absent by construction — they are model-internal (D160),
 *   and a chart is a much easier place to leak one than a sentence.
 * - **A gap is drawn, not smoothed.** A hole **breaks the temperature path** rather than
 *   interpolating across it. This is the single easiest thing to get wrong here: one `<polyline>`
 *   through a hole draws a confident straight line through weather nobody observed. The one
 *   deliberate exception is a single absent hour — see {@link MAX_INTERPOLATED_SLOTS}, which exists
 *   because the spring-forward hour is indistinguishable from a lost one and is not a gap at all.
 * - **A partial day is a third state.** Today, mid-afternoon, is neither missing nor settled. It is
 *   drawn, and flagged so the renderer can draw it as provisional.
 */

import { cToF } from './units';
// ⚠ **Imported, not restated.** An earlier draft declared its own copy of both thresholds "for
// readability", which is exactly how a chart ends up highlighting a span the sentence beside it does
// not mention. Within one package there is no excuse for a second copy; the only duplication this
// module tolerates is the band edges, which cannot be imported because `@skating/design` is not a
// dependency of core (see `BAND_EDGE_FREEZING_F`).
import { SUNLIT_WM2 } from './weatherDay';
import { CALM_FREEZE_MAX_KPH } from './weatherPanel';

/** Lanes, top to bottom. The order is the render order and the reading order. */
export const TIMELINE_LANES = ['temperature', 'precipitation', 'wind', 'sun', 'snowDepth'] as const;
export type TimelineLane = (typeof TIMELINE_LANES)[number];

/**
 * Default lane heights in px, summing with gaps and the label band to {@link DEFAULT_TIMELINE_HEIGHT}.
 *
 * Temperature takes roughly half of everything available because it is the only lane a reader
 * interrogates for a *value*; the other four are answering "when" and "roughly how much", which a
 * 22px sparkline does honestly. ⚠ These are a default, not a constraint — {@link weatherTimelineModel}
 * rescales them proportionally to whatever height it is given, so a caller that wants a compact
 * variant changes one number rather than five.
 */
export const DEFAULT_LANE_HEIGHTS: Record<TimelineLane, number> = {
  temperature: 110,
  precipitation: 14,
  wind: 24,
  sun: 24,
  snowDepth: 18,
};

/** Vertical gap between lanes. Small — the lanes are a stack, not five separate charts. */
export const LANE_GAP = 4;

/** Height of the day-label band above the plot. */
export const DAY_LABEL_HEIGHT = 12;

/** The founder's call, after 200 turned out not to fit five lanes plus labels. */
export const DEFAULT_TIMELINE_HEIGHT = 240;

/**
 * Fahrenheit band edges — kept identical to `@skating/design`'s `TEMPERATURE_BAND_EDGES_F`.
 *
 * ⚠ **Duplicated across two packages on purpose, and pinned by a test.** `@skating/core` must not
 * depend on `@skating/design` (core is consumed by the Convex backend, which has no business
 * importing a color package), so the numbers live in both. `weatherTimeline.test.ts` asserts they
 * still agree, which is the cheap half of the guarantee; the expensive half — that they *mean* the
 * same thing — is that only this file uses them for geometry and only that one for color.
 */
export const BAND_EDGE_DEEP_COLD_F = 20;
export const BAND_EDGE_FREEZING_F = 32;
export const BAND_EDGE_THAW_F = 40;

/** Temperature bands, cold → warm. Mirrors `@skating/design`'s `TEMPERATURE_BANDS`. */
export const TEMPERATURE_BANDS = ['deepCold', 'cold', 'thaw', 'warm'] as const;
export type TemperatureBand = (typeof TEMPERATURE_BANDS)[number];

/**
 * The smallest temperature span the y axis will show, in °F.
 *
 * Without a floor, a week that never left 28–31°F would stretch three degrees across the whole lane
 * and draw a dramatic mountain range out of noise — the chart would look most eventful exactly when
 * the weather was most uniform. 25°F is wide enough that a genuinely flat week reads as flat.
 */
export const MIN_TEMPERATURE_SPAN_F = 25;

/** Below this hourly total (mm water-equivalent) an hour has not really precipitated. */
export const PRECIP_MIN_MM = 0.05;

/**
 * How wide a hole may be, in hour-slots, before it **breaks** a path instead of being interpolated.
 *
 * ⚠ **2.5 rather than 1.5, and the extra slot is not slack — it is the spring-forward hour.** Local
 * time has no 02:00 on that date, so 01:00 and 03:00 are *consecutive real hours* two slots apart on
 * an axis positioned by local hour. Breaking there would draw a confident gap across weather that was
 * fully observed, one night every March, right inside the season.
 *
 * The cost is that a genuinely absent single hour is interpolated rather than broken — and that is
 * accepted knowingly. Nothing in the data distinguishes the two cases without a timezone database
 * this module deliberately does not carry, and the two outcomes are not symmetric: a one-hour linear
 * interpolation on a 5–11 km hourly model sits well below the input's own resolution, while a false
 * gap is a visible claim that we know nothing about an hour we know everything about. **Every gap
 * that actually matters — a failed fetch, a borrowed day, a whole missing day — is many slots wide
 * and still breaks.**
 */
export const MAX_INTERPOLATED_SLOTS = 2.5;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One observed hour, as the archive stores it.
 *
 * ⚠ **`localDate` + `localHour`, never a timestamp.** `HourlyWeather.startMs` is deliberately
 * local-shifted, so passing it to a local formatter double-applies the offset — a silent 4–5 hour
 * slide in the Northeast. The archive already carries the lake's own wall clock; this consumes that
 * directly and does no offset arithmetic at all.
 */
export interface TimelineHour {
  /** `YYYY-MM-DD` as the lake experienced it. */
  localDate: string;
  /** Local hour of day, 0–23. */
  localHour: number;
  temperatureC: number;
  precipitationMm?: number;
  rainMm?: number;
  snowfallCm?: number;
  snowDepthM?: number;
  windSpeedKph?: number;
  shortwaveWm2?: number;
  /** WMO code from Open-Meteo, when requested. Absent falls back to the rain/snow/temperature rule. */
  weatherCode?: number;
}

/** A day in the window: its hours, or a hole. */
export interface TimelineDayInput {
  dayMs: number;
  localDate: string;
  /** Empty or absent ⇒ a gap. Never synthesise zeroes to fill one. */
  hours?: readonly TimelineHour[];
  /** True when the archive recorded this day as unavailable, as opposed to never having asked. */
  missing?: boolean;
  /** True when the day has data but has not finished happening — today. */
  partial?: boolean;
}

export interface WeatherTimelineInput {
  days: readonly TimelineDayInput[];
  width: number;
  height?: number;
  laneHeights?: Partial<Record<TimelineLane, number>>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LaneBox {
  top: number;
  bottom: number;
  height: number;
}

export interface TimelineDayColumn {
  dayMs: number;
  localDate: string;
  x: number;
  width: number;
  missing: boolean;
  partial: boolean;
}

/** A gradient stop as an offset down the temperature lane, paired with the band it reaches there. */
export interface TemperatureGradientStop {
  /** 0 at the top of the lane (hottest), 1 at the bottom (coldest). */
  offset: number;
  band: TemperatureBand;
}

/**
 * How precipitation is drawn. `fill` is the *origin* (fell solid vs fell liquid); `hatched` is
 * whether it froze on contact — see `@skating/design`'s `WEATHER_PRECIPITATION_SCALE`.
 */
export type PrecipitationFill = 'snow' | 'rain';

export interface PrecipitationBlock {
  x: number;
  width: number;
  fill: PrecipitationFill;
  /** Froze on contact: freezing rain, freezing drizzle, sleet, ice pellets, mixed rain-and-snow. */
  hatched: boolean;
  /** The precise type, for the scrub readout where there is room to say it. */
  label: string;
  /** Water-equivalent for the hour, mm — the readout's number, never a bar height. */
  amountMm: number;
  /** Snowfall for the hour in cm when it fell as snow, so the readout can say inches of snow. */
  snowfallCm: number | null;
}

/** A run of consecutive hours where an emphasis condition held. */
export interface EmphasisSpan {
  x: number;
  width: number;
}

export interface TemperatureLayer {
  box: LaneBox;
  /** One path per contiguous run of observed hours. **Never one path through a gap.** */
  segments: string[];
  /** Same runs, but only the hours belonging to unfinished days — drawn provisionally. */
  partialSegments: string[];
  gradient: { x1: number; y1: number; x2: number; y2: number; stops: TemperatureGradientStop[] };
  /** y of the 32°F reference rule. Always inside the box: the scale is clamped to include it. */
  freezeY: number;
  minF: number;
  maxF: number;
}

export interface AuxLayer {
  box: LaneBox;
  /** A filled area from the lane's baseline. Empty when nothing was observed. */
  area: string;
  /** Spans where this lane's condition held. */
  emphasis: EmphasisSpan[];
  /** The value the lane's top represents, in the lane's own unit. */
  max: number;
}

/** An hour placed on the x axis — what a scrub gesture resolves against. */
export interface PositionedHour {
  x: number;
  hour: TimelineHour;
  dayMs: number;
  partial: boolean;
}

export interface WeatherTimelineModel {
  width: number;
  height: number;
  boxes: Record<TimelineLane, LaneBox>;
  days: TimelineDayColumn[];
  /** x of each day boundary — the full-height hairlines. Excludes both outer edges. */
  dividers: number[];
  temperature: TemperatureLayer | null;
  precipitation: { box: LaneBox; blocks: PrecipitationBlock[] };
  wind: AuxLayer | null;
  sun: AuxLayer | null;
  snowDepth: AuxLayer | null;
  /** Ascending by x. Empty when the window held no observed hour. */
  hours: PositionedHour[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Precipitation typing
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface PrecipKind {
  fill: PrecipitationFill;
  hatched: boolean;
  label: string;
}

/**
 * WMO code → how it is drawn and what it is called.
 *
 * Only the precipitating codes appear; clear/cloud/fog codes precipitate nothing and are absent
 * rather than mapped to a "none" entry, so a lookup miss and a dry hour are the same thing.
 *
 * ⚠ **56/57 and 66/67 are the codes this whole variable was added for.** Freezing drizzle and
 * freezing rain are the precipitation that most changes a skating surface — they arrive liquid and
 * bond — and no combination of `rain`, `snowfall` and temperature separates them from ordinary cold
 * rain reliably enough to name in a readout.
 */
const WMO_PRECIPITATION: Record<number, PrecipKind> = {
  51: { fill: 'rain', hatched: false, label: 'Light drizzle' },
  53: { fill: 'rain', hatched: false, label: 'Drizzle' },
  55: { fill: 'rain', hatched: false, label: 'Heavy drizzle' },
  56: { fill: 'rain', hatched: true, label: 'Freezing drizzle' },
  57: { fill: 'rain', hatched: true, label: 'Freezing drizzle' },
  61: { fill: 'rain', hatched: false, label: 'Light rain' },
  63: { fill: 'rain', hatched: false, label: 'Rain' },
  65: { fill: 'rain', hatched: false, label: 'Heavy rain' },
  66: { fill: 'rain', hatched: true, label: 'Freezing rain' },
  67: { fill: 'rain', hatched: true, label: 'Freezing rain' },
  68: { fill: 'snow', hatched: true, label: 'Rain and snow' },
  69: { fill: 'snow', hatched: true, label: 'Rain and snow' },
  71: { fill: 'snow', hatched: false, label: 'Light snow' },
  73: { fill: 'snow', hatched: false, label: 'Snow' },
  75: { fill: 'snow', hatched: false, label: 'Heavy snow' },
  77: { fill: 'snow', hatched: false, label: 'Snow grains' },
  79: { fill: 'snow', hatched: true, label: 'Ice pellets' },
  80: { fill: 'rain', hatched: false, label: 'Rain showers' },
  81: { fill: 'rain', hatched: false, label: 'Rain showers' },
  82: { fill: 'rain', hatched: false, label: 'Heavy rain showers' },
  83: { fill: 'snow', hatched: true, label: 'Rain and snow showers' },
  84: { fill: 'snow', hatched: true, label: 'Rain and snow showers' },
  85: { fill: 'snow', hatched: false, label: 'Snow showers' },
  86: { fill: 'snow', hatched: false, label: 'Heavy snow showers' },
  87: { fill: 'snow', hatched: true, label: 'Ice pellet showers' },
  88: { fill: 'snow', hatched: true, label: 'Ice pellet showers' },
};

/**
 * How to draw one hour's precipitation, or `null` when nothing meaningful fell.
 *
 * Prefers `weather_code`, which is the only input that can name sleet. Falls back to the rain/snow
 * split plus temperature, which cannot — but **can** still catch the case that matters most: liquid
 * arriving at or below freezing is freezing rain, and that is derivable from what the archive held
 * before `weather_code` was ever requested. Rows written before that variable was added therefore
 * still draw the hatch correctly rather than degrading to plain "rain".
 */
export function precipitationKind(hour: TimelineHour): PrecipKind | null {
  const snowfallCm = hour.snowfallCm ?? 0;
  const rainMm = hour.rainMm ?? 0;
  // Snowfall is depth of snow (~10:1), so it is converted to water-equivalent before being compared
  // against a millimetre threshold. Treating 0.3 cm of snow as "0.3 mm of precipitation" would set
  // the bar an order of magnitude too high and drop most light snow.
  const total = hour.precipitationMm ?? rainMm + snowfallCm * 10;
  if (!(total >= PRECIP_MIN_MM)) return null;

  if (typeof hour.weatherCode === 'number') {
    const mapped = WMO_PRECIPITATION[hour.weatherCode];
    if (mapped) return mapped;
    // A precipitating hour whose code we do not recognise still gets drawn — falling through to the
    // derivation below rather than returning null, because an unknown code is not an absence.
  }

  if (snowfallCm > 0 && rainMm <= 0) return { fill: 'snow', hatched: false, label: 'Snow' };
  if (snowfallCm > 0 && rainMm > 0) {
    return { fill: 'snow', hatched: true, label: 'Rain and snow' };
  }
  if (hour.temperatureC <= 0) return { fill: 'rain', hatched: true, label: 'Freezing rain' };
  return { fill: 'rain', hatched: false, label: 'Rain' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Scales
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Which band a temperature falls in. The boundaries belong to the colder band, as `<` implies. */
export function temperatureBandOf(tempF: number): TemperatureBand {
  if (tempF < BAND_EDGE_DEEP_COLD_F) return 'deepCold';
  if (tempF < BAND_EDGE_FREEZING_F) return 'cold';
  if (tempF < BAND_EDGE_THAW_F) return 'thaw';
  return 'warm';
}

/**
 * The temperature window the lane draws, always containing 32°F and never narrower than
 * {@link MIN_TEMPERATURE_SPAN_F}.
 *
 * Including 32 unconditionally is what makes "this line is entirely below the rule" a statement
 * rather than a coincidence of the week's range — the same reasoning the seven-column strip used, and
 * the reason the freezing rule can be drawn without a bounds check.
 */
export function temperatureWindowF(valuesF: readonly number[]): { minF: number; maxF: number } {
  let minF = BAND_EDGE_FREEZING_F;
  let maxF = BAND_EDGE_FREEZING_F;
  for (const v of valuesF) {
    if (!Number.isFinite(v)) continue;
    if (v < minF) minF = v;
    if (v > maxF) maxF = v;
  }
  const span = maxF - minF;
  if (span < MIN_TEMPERATURE_SPAN_F) {
    // Grown around the midpoint rather than downward, so a mild week does not get a floor of −10°F
    // and a cold week does not get a ceiling of 50°F. Both would waste half the lane on empty air.
    const pad = (MIN_TEMPERATURE_SPAN_F - span) / 2;
    minF -= pad;
    maxF += pad;
  }
  return { minF, maxF };
}

/**
 * Gradient stops down the temperature lane.
 *
 * **The gradient is why this chart needs no per-segment coloring.** The line's color is a function of
 * temperature, and temperature *is* the y position, so one vertical gradient in user space paints
 * every segment correctly — including the parts between two sampled hours, which no per-point scheme
 * gets right. It also renders identically under `react-native-svg`.
 *
 * ⚠ **Two stops share an offset at 32°F, and that is the hard step.** A smooth blend across freezing
 * would put a green-grey midpoint on the one boundary the chart exists to make obvious. Every other
 * transition blends, because 30°F and 25°F genuinely are the same kind of weather.
 *
 * Edges outside the visible window are **dropped, never clamped**. Clamping put a `deepCold` stop at
 * offset 1 on a week whose coldest hour was 25°F, painting a band the data never entered.
 */
export function temperatureGradientStops(minF: number, maxF: number): TemperatureGradientStop[] {
  const span = maxF - minF;
  if (!(span > 0)) return [{ offset: 0, band: temperatureBandOf(maxF) }];
  // Offset runs downward from the hottest edge, so it is the *complement* of the usual value scale.
  const offsetOf = (tempF: number) => (maxF - tempF) / span;

  const stops: TemperatureGradientStop[] = [{ offset: 0, band: temperatureBandOf(maxF) }];
  const inside = (edge: number) => edge > minF && edge < maxF;

  if (inside(BAND_EDGE_THAW_F)) stops.push({ offset: offsetOf(BAND_EDGE_THAW_F), band: 'thaw' });
  if (inside(BAND_EDGE_FREEZING_F)) {
    const at = offsetOf(BAND_EDGE_FREEZING_F);
    stops.push({ offset: at, band: 'thaw' }, { offset: at, band: 'cold' });
  }
  if (inside(BAND_EDGE_DEEP_COLD_F)) {
    stops.push({ offset: offsetOf(BAND_EDGE_DEEP_COLD_F), band: 'cold' });
  }
  stops.push({ offset: 1, band: temperatureBandOf(minF) });
  return stops;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function laneBoxes(
  height: number,
  overrides: Partial<Record<TimelineLane, number>> | undefined,
): Record<TimelineLane, LaneBox> {
  const requested = TIMELINE_LANES.map((lane) => ({
    lane,
    h: Math.max(1, overrides?.[lane] ?? DEFAULT_LANE_HEIGHTS[lane]),
  }));
  const chrome = DAY_LABEL_HEIGHT + LANE_GAP * (TIMELINE_LANES.length - 1);
  const available = Math.max(TIMELINE_LANES.length, height - chrome);
  const requestedTotal = requested.reduce((sum, r) => sum + r.h, 0);
  // Rescaled rather than clipped: a caller asking for 180px gets five proportionally shorter lanes
  // instead of a snow-depth lane hanging off the bottom of its own viewport.
  const scale = available / requestedTotal;

  const boxes = {} as Record<TimelineLane, LaneBox>;
  let top = DAY_LABEL_HEIGHT;
  for (const { lane, h } of requested) {
    const laneHeight = h * scale;
    boxes[lane] = { top, bottom: top + laneHeight, height: laneHeight };
    top += laneHeight + LANE_GAP;
  }
  return boxes;
}

/** `M x y L x y …` from already-positioned points. */
function linePath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  if (!first) return '';
  const head = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  if (rest.length === 0) {
    // A lone observed hour would otherwise emit a bare moveto, which draws nothing at all — an hour
    // of data rendering as an empty lane reads exactly like a gap. A zero-length line with a round
    // cap draws a dot.
    return `${head} L ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  }
  return `${head} ${rest.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')}`;
}

/** Contiguous runs, split wherever `breaks` says the series was interrupted. */
function runsOf<T>(items: readonly T[], breaks: (prev: T, next: T) => boolean): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const prev = current[current.length - 1];
    if (prev !== undefined && breaks(prev, item)) {
      runs.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Consecutive `true`s in `flags` become one span, positioned from `xs`. */
function emphasisSpans(
  positioned: readonly PositionedHour[],
  hourWidth: number,
  holds: (hour: TimelineHour) => boolean,
): EmphasisSpan[] {
  const spans: EmphasisSpan[] = [];
  let start: number | null = null;
  let end = 0;
  for (const p of positioned) {
    if (holds(p.hour)) {
      // Spans are drawn from the *left edge* of the first qualifying hour to the right edge of the
      // last, not between hour centres. A single calm-freezing hour must still be a visible block
      // rather than a zero-width line, and an hour is a duration.
      if (start === null) start = p.x - hourWidth / 2;
      end = p.x + hourWidth / 2;
    } else if (start !== null) {
      spans.push({ x: start, width: end - start });
      start = null;
    }
  }
  if (start !== null) spans.push({ x: start, width: end - start });
  return spans;
}

/**
 * Build an auxiliary lane's filled area and emphasis spans, or `null` when nothing was observed.
 *
 * `null` rather than a flat zero line, and the distinction is the usual one: a lane drawn along its
 * own baseline asserts a measured calm, a dead still day, no sun at all. An absent lane says we do
 * not know, which for `shortwave_radiation` on an older archive row is the truth.
 */
function auxLayer(
  box: LaneBox,
  positioned: readonly PositionedHour[],
  hourWidth: number,
  measure: (hour: TimelineHour) => number | null,
  holds: (hour: TimelineHour) => boolean,
  fallbackMax: number,
): AuxLayer | null {
  const values: { x: number; v: number }[] = [];
  for (const p of positioned) {
    const v = measure(p.hour);
    if (v !== null && Number.isFinite(v)) values.push({ x: p.x, v });
  }
  if (values.length === 0) return null;

  const max = Math.max(fallbackMax, ...values.map((v) => v.v));
  const y = (v: number) => box.bottom - (v / max) * box.height;
  // Closed back along the baseline so the shape reads as an area rather than a line. The area is
  // built from the same runs the line would use, so a gap in an auxiliary series is a gap here too.
  const runs = runsOf(values, (prev, next) => next.x - prev.x > hourWidth * MAX_INTERPOLATED_SLOTS);
  const area = runs
    .map((run) => {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) return '';
      const top = run.map((p) => `L ${p.x.toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ');
      return (
        `M ${first.x.toFixed(2)} ${box.bottom.toFixed(2)} ${top} ` +
        `L ${last.x.toFixed(2)} ${box.bottom.toFixed(2)} Z`
      );
    })
    .filter((d) => d.length > 0)
    .join(' ');

  return { box, area, emphasis: emphasisSpans(positioned, hourWidth, holds), max };
}

/**
 * Build the whole timeline, or `null` when there is nothing to draw.
 *
 * Days arrive in whatever order; they are sorted here. Each day gets an **equal-width column**
 * regardless of how many hours it contributed, which is what keeps the day dividers evenly spaced and
 * a partial day occupying only the left part of its own column.
 *
 * ## ⚠ DST, and the one hour a year this loses
 *
 * Hours are positioned by `localHour / 24` within their day. Both DST transitions fall inside a
 * skating season, and each breaks a different assumption:
 *
 * - **Spring forward** has no 02:00. The line interpolates across a one-hour hole, which is invisible
 *   and harmless — the hour genuinely did not exist.
 * - **Fall back** has *two* 01:00s. The second is dropped by the `(localDate, localHour)` dedupe.
 *
 * That loses one observed hour on one night a year, which is a deliberate trade against the
 * alternative: positioning by array index would make a 25-hour day 4% wider than its neighbours and
 * silently slide every divider after it. A bounded, documented cosmetic loss beats an unbounded,
 * invisible scale error.
 */
export function weatherTimelineModel(input: WeatherTimelineInput): WeatherTimelineModel | null {
  const { width } = input;
  const height = input.height ?? DEFAULT_TIMELINE_HEIGHT;
  if (!(width > 0) || !(height > 0)) return null;
  if (input.days.length === 0) return null;

  const ordered = [...input.days].sort((a, b) => a.dayMs - b.dayMs);
  const dayWidth = width / ordered.length;
  const hourWidth = dayWidth / 24;
  const boxes = laneBoxes(height, input.laneHeights);

  const days: TimelineDayColumn[] = [];
  const positioned: PositionedHour[] = [];

  ordered.forEach((day, index) => {
    const x = index * dayWidth;
    const hasHours = (day.hours?.length ?? 0) > 0;
    days.push({
      dayMs: day.dayMs,
      localDate: day.localDate,
      x,
      width: dayWidth,
      missing: day.missing === true || !hasHours,
      partial: day.partial === true,
    });

    const seen = new Set<number>();
    for (const hour of day.hours ?? []) {
      const h = hour.localHour;
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      if (seen.has(h)) continue; // the fall-back repeat — see the docblock
      seen.add(h);
      positioned.push({
        x: x + (h + 0.5) * hourWidth,
        hour,
        dayMs: day.dayMs,
        partial: day.partial === true,
      });
    }
  });

  positioned.sort((a, b) => a.x - b.x);

  const dividers = days.slice(1).map((d) => d.x);

  // ── Temperature ────────────────────────────────────────────────────────────────────────────────
  let temperature: TemperatureLayer | null = null;
  if (positioned.length > 0) {
    const valuesF = positioned.map((p) => cToF(p.hour.temperatureC));
    const { minF, maxF } = temperatureWindowF(valuesF);
    const box = boxes.temperature;
    const span = maxF - minF;
    const y = (tempF: number) => box.bottom - ((tempF - minF) / span) * box.height;

    const points = positioned.map((p, i) => ({
      x: p.x,
      y: y(valuesF[i] as number),
      partial: p.partial,
    }));
    // **The gap rule.** A hole longer than an hour and a half breaks the path. Without this the
    // renderer draws one confident straight line across a day the archive never got — the most
    // plausible-looking wrong mark this chart could make.
    const runs = runsOf(
      points,
      (prev, next) => next.x - prev.x > hourWidth * MAX_INTERPOLATED_SLOTS,
    );

    temperature = {
      box,
      segments: runs.map((run) => linePath(run.filter((p) => !p.partial))).filter((d) => d !== ''),
      partialSegments: runs
        .map((run) => linePath(run.filter((p) => p.partial)))
        .filter((d) => d !== ''),
      gradient: {
        x1: 0,
        y1: box.top,
        x2: 0,
        y2: box.bottom,
        stops: temperatureGradientStops(minF, maxF),
      },
      freezeY: y(BAND_EDGE_FREEZING_F),
      minF,
      maxF,
    };
  }

  // ── Precipitation ──────────────────────────────────────────────────────────────────────────────
  const blocks: PrecipitationBlock[] = [];
  for (const p of positioned) {
    const kind = precipitationKind(p.hour);
    if (!kind) continue;
    const snowfallCm = p.hour.snowfallCm ?? 0;
    blocks.push({
      x: p.x - hourWidth / 2,
      width: hourWidth,
      fill: kind.fill,
      hatched: kind.hatched,
      label: kind.label,
      amountMm: p.hour.precipitationMm ?? (p.hour.rainMm ?? 0) + snowfallCm * 10,
      snowfallCm: snowfallCm > 0 ? snowfallCm : null,
    });
  }

  // ── Wind, sun, snow depth ──────────────────────────────────────────────────────────────────────
  const wind = auxLayer(
    boxes.wind,
    positioned,
    hourWidth,
    (h) => h.windSpeedKph ?? null,
    // Calm *and* freezing — the conjunction, not either half. A calm July hour is not this.
    (h) =>
      (h.windSpeedKph ?? Number.POSITIVE_INFINITY) <= CALM_FREEZE_MAX_KPH && h.temperatureC < 0,
    // A floor on the axis so a still week does not scale 2 kph to full height and read as a gale.
    20,
  );

  const sun = auxLayer(
    boxes.sun,
    positioned,
    hourWidth,
    (h) => h.shortwaveWm2 ?? null,
    // The founder's "sticky and soft" mechanism, and `weatherDay.ts`'s `sunlitThawHours` predicate:
    // both conditions on the same hour. A sunny morning followed by a mild grey afternoon is not it.
    (h) => (h.shortwaveWm2 ?? 0) >= SUNLIT_WM2 && h.temperatureC > 0,
    // Clear-sky midwinter noon at this latitude, so lanes are comparable between lakes and weeks.
    400,
  );

  const snowDepth = auxLayer(
    boxes.snowDepth,
    positioned,
    hourWidth,
    (h) => h.snowDepthM ?? null,
    () => false, // depth has no condition to emphasise; it is the slow context under everything else
    0.1,
  );

  return {
    width,
    height,
    boxes,
    days,
    dividers,
    temperature,
    precipitation: { box: boxes.precipitation, blocks },
    wind,
    sun,
    snowDepth,
    hours: positioned,
  };
}

/**
 * The hour nearest an x position — what a scrub gesture resolves against.
 *
 * Nearest rather than containing, so a drag past either end still reads the closest real hour instead
 * of falling off into `null`. Returns `null` only when the model holds no hours at all.
 */
export function hourAtX(model: WeatherTimelineModel, x: number): PositionedHour | null {
  if (model.hours.length === 0) return null;
  let best: PositionedHour | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const p of model.hours) {
    const d = Math.abs(p.x - x);
    if (d < bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  return best;
}
