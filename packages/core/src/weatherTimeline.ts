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

// ⚠ **Imported, not restated.** An earlier draft declared its own copy of both thresholds "for
// readability", which is exactly how a chart ends up highlighting a span the sentence beside it does
// not mention. Within one package there is no excuse for a second copy; the only duplication this
// module tolerates is the band edges, which cannot be imported because `@skating/design` is not a
// dependency of core (see `BAND_EDGE_FREEZING_F`).
import { MIN_FETCH_CLAUSE_M } from './lakeCaption';
import { cmToInches, cToF, formatTemperatureF, kphToMph, mmToInches, roundTo } from './units';
import {
  dayMsToLocalDate,
  isCompleteDay,
  SUNLIT_WM2,
  WIND_SECTOR_COUNT,
  windSectorOf,
} from './weatherDay';
import { CALM_FREEZE_MAX_KPH, COMPASS_LABELS, formatLocalHour } from './weatherPanel';

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
 * Pixels per hour — **the chart's scale, and the reason it is a constant rather than a division.**
 *
 * Until 2026-09-04 the window was N whole days stretched to whatever width the container had, which
 * made an hour 2.286 px in the web sidebar, 2.131 px on an iPhone 15 Pro and 1.940 px on an SE. The
 * same week of weather drew a different shape on every screen and nothing could be designed against
 * it. Fixing the scale inverts the relationship: an hour is always this wide, and *how many days fit*
 * becomes the thing that varies.
 *
 * 2 px/hour is 48 px a day, so a 376 px plot shows 7 days and five sixths of an eighth — and the
 * cropped column is deliberate. A partial day at the edge is the cheapest possible signal that the
 * chart scrolls, and it costs nothing to draw.
 *
 * ⚠ **A default, not a fixed value.** `pxPerHour` is an input precisely so the zoom levels the founder
 * sketched — 1 px = 30 min (this), 15 min (4 px/h), 10 min (6), 5 min (12) — are a prop change rather
 * than a rewrite of the x axis. Everything downstream derives from `hourWidth`, so nothing else has to
 * learn about zoom.
 */
export const PX_PER_HOUR = 2;

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

/**
 * Narrowest column, in px, that can carry its own `Wed 14` label.
 *
 * ⚠ **Found by rendering the panned-out view, which nothing else would have caught.** At the seven-day
 * default a column is ~53px and every day is labelled comfortably. Dragged out to the founder's
 * thirty, a column is ~12px and thirty labels overprint into a solid unreadable band — the axis stops
 * being an axis. Labels are thinned to every Nth day instead, which keeps the *scale* legible even
 * when every date cannot be named.
 *
 * 26px fits `Wed 14` at 9px type with a little air. Deliberately about the label, not about the data:
 * the dividers, the marks and the scrub readout are all unaffected, so panning out costs only the
 * names of the intermediate days.
 */
export const MIN_DAY_LABEL_WIDTH = 26;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The scroll thumb
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Narrowest the thumb is allowed to get, in px.
 *
 * Proportional sizing alone would make the thumb 7/30ths of the track — fine — but a future wider
 * range would shrink it below the ~24px that a finger or a cursor can reliably catch. A floor costs
 * a little proportional honesty at the extremes and keeps the control usable, which is the trade
 * every scrollbar makes.
 */
export const MIN_SCROLL_THUMB_WIDTH = 24;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fetch, as the wind lane's second channel
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Density steps in the wind lane's fill. Four, because the eye cannot read more than a few.
 *
 * Bucketing also keeps the path count sane: wind direction turns slowly, so a week of hours collapses
 * into a handful of runs rather than 168 one-hour slivers.
 */
export const FETCH_INTENSITY_LEVELS = 4;

/**
 * The lake's reach at a bearing and its longest reach in any direction, or `null` when the question
 * does not apply.
 *
 * ## ⚠ It returns `null` for about 95% of the corpus, and that is the correct answer
 *
 * `MIN_FETCH_CLAUSE_M` already settled this for the lake caption: below a kilometre of open water
 * *"the answer is 'there isn't any' in every direction — a clause naming the most exposed bearing
 * would imply a distinction the geometry cannot support."* Measured against the corpus, that rules
 * out most of it: max fetch is **224 m at the median**, 692 m at p90, and only **5% of bodies exceed
 * a kilometre** in any direction.
 *
 * So a per-lake opacity ramp on a typical pond would be pure noise dressed as insight — it would
 * paint a vivid contrast between a 60 m shore and a 90 m one. Gating on the same threshold the prose
 * uses means the two surfaces agree about which lakes have an exposure story at all, and the wind
 * lane simply draws flat on the ones that do not.
 *
 * Shared by both public readers so the gate is stated once: {@link fetchAlong} takes the metres and
 * {@link fetchIntensityAt} takes the ratio.
 */
function fetchReachAt(
  fetchProfileM: readonly number[] | null | undefined,
  bearingDeg: number | null | undefined,
): { here: number; peak: number } | null {
  if (!Array.isArray(fetchProfileM) || fetchProfileM.length !== WIND_SECTOR_COUNT) return null;
  if (typeof bearingDeg !== 'number' || !Number.isFinite(bearingDeg)) return null;
  let peak = Number.NEGATIVE_INFINITY;
  for (const v of fetchProfileM) if (typeof v === 'number' && v > peak) peak = v;
  if (!Number.isFinite(peak) || peak < MIN_FETCH_CLAUSE_M) return null;
  const here = fetchProfileM[windSectorOf(bearingDeg)];
  if (typeof here !== 'number' || !Number.isFinite(here)) return null;
  return { here, peak };
}

/**
 * The metres of open water behind the wind at a bearing — or `null` when the claim is not worth
 * making.
 *
 * The words half of {@link fetchIntensityAt}, gated on the same `MIN_FETCH_CLAUSE_M` so the drawing
 * and the readout agree about which lakes have an exposure story. Returns the **raw metres** rather
 * than a normalised share, because a sentence should name the measurement and a fill should show the
 * proportion.
 */
export function fetchAlong(
  fetchProfileM: readonly number[] | null | undefined,
  bearingDeg: number | null | undefined,
): number | null {
  return fetchReachAt(fetchProfileM, bearingDeg)?.here ?? null;
}

/**
 * How exposed this lake was to the wind at a given bearing, in `[0, 1]` — or `null` when the
 * question does not apply (see {@link fetchReachAt}).
 *
 * **Normalised per lake, not against a fixed reference**, which is the opposite of the wind rose's
 * choice and right for the opposite reason: the rose compares lakes ("is this one windy?"), while
 * this compares *bearings within one lake* ("was the wind running the long way today?"). A shared
 * scale would flatten Willoughby's own contrast to nothing next to Champlain.
 */
export function fetchIntensityAt(
  fetchProfileM: readonly number[] | null | undefined,
  bearingDeg: number | null | undefined,
): number | null {
  const reach = fetchReachAt(fetchProfileM, bearingDeg);
  if (!reach) return null;
  return Math.min(1, Math.max(0, reach.here / reach.peak));
}

export interface TimelineScrollbar {
  /** Thumb left edge, px from the track's left. */
  x: number;
  /** Thumb width, px — how much of the whole range is on screen. */
  width: number;
}

/**
 * Where the scroll thumb sits, or `null` when the whole range already fits.
 *
 * ⚠ **`scrollPx` counts BACKWARDS — 0 is the most recent — and the thumb runs forwards.** So the thumb
 * sits at the *right* end at 0 and slides left as you travel back, which is the only arrangement that
 * matches how a reader thinks about a timeline. Getting this inverted produces a control that works
 * perfectly and moves the wrong way, which no type and no test catches unless the test says the
 * direction out loud — so these tests do.
 *
 * Everything is in **pixels** since the 2026-09-04 scale change. The thumb's width is the honest
 * viewport-over-content ratio, so it grows when you zoom out and shrinks when you zoom in, for free.
 */
/**
 * The thumb's width — the honest viewport-over-content ratio, floored so it stays catchable.
 *
 * ⚠ **One definition, because two would be invertible without either noticing.** The thumb's
 * position and the position a click on the track selects are inverses of each other, and they can
 * only be inverses if they size the thumb identically; the formula was written out twice.
 */
function thumbWidth(viewportWidth: number, contentWidth: number, trackWidth: number): number {
  return Math.min(
    trackWidth,
    Math.max(MIN_SCROLL_THUMB_WIDTH, (viewportWidth / contentWidth) * trackWidth),
  );
}

export function timelineScrollbar(opts: {
  scrollPx: number;
  maxScrollPx: number;
  viewportWidth: number;
  contentWidth: number;
  trackWidth: number;
}): TimelineScrollbar | null {
  const { scrollPx, maxScrollPx, viewportWidth, contentWidth, trackWidth } = opts;
  if (maxScrollPx <= 0 || trackWidth <= 0 || contentWidth <= 0) return null;

  const width = thumbWidth(viewportWidth, contentWidth, trackWidth);
  const travel = Math.max(0, trackWidth - width);
  // 1 at scrollPx 0 (newest, hard right), 0 at maxScrollPx (oldest, hard left).
  const progress = (maxScrollPx - clamp(scrollPx, 0, maxScrollPx)) / maxScrollPx;
  return { x: progress * travel, width };
}

/**
 * The scroll position a pointer at `trackX` selects — for dragging the thumb and clicking the track.
 *
 * `trackX` is read as where the **centre** of the thumb wants to be, which is what makes a click on
 * bare track jump the thumb *to the cursor* rather than to a position half a thumb-width off.
 *
 * ⚠ **No longer rounded to a whole day.** The scale is fixed and the viewport crops mid-day on
 * purpose, so snapping here would fight the drag it is meant to mirror — the thumb would stutter
 * between day boundaries while the chart under it moved smoothly.
 */
export function scrollPxAtTrackX(
  trackX: number,
  opts: {
    maxScrollPx: number;
    viewportWidth: number;
    contentWidth: number;
    trackWidth: number;
  },
): number {
  const { maxScrollPx, viewportWidth, contentWidth, trackWidth } = opts;
  if (maxScrollPx <= 0 || trackWidth <= 0 || contentWidth <= 0) return 0;
  const width = thumbWidth(viewportWidth, contentWidth, trackWidth);
  const travel = trackWidth - width;
  // A track with no travel (thumb fills it) can only mean the newest view; dividing would be NaN.
  if (travel <= 0) return 0;
  const progress = clamp((trackX - width / 2) / travel, 0, 1);
  return maxScrollPx * (1 - progress);
}

/** Total drawn width of `dayCount` days at a scale, and how far it can scroll in `viewportWidth`. */
export function timelineExtent(
  dayCount: number,
  viewportWidth: number,
  pxPerHour: number = PX_PER_HOUR,
): { contentWidth: number; maxScrollPx: number } {
  const contentWidth = Math.max(0, dayCount) * 24 * pxPerHour;
  return { contentWidth, maxScrollPx: Math.max(0, contentWidth - viewportWidth) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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
  /**
   * Open-Meteo `wind_direction_10m` — degrees **meteorological**, i.e. the direction wind blows
   * *from*, which is the convention every compass label in this app already uses.
   *
   * ⚠ Read it with `windSectorOf` rather than dividing by 22.5: the sectors are centred on the
   * compass points, so N spans 348.75°–11.25° and a naive floor puts half of north into NNE.
   */
  windDirectionDeg?: number;
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
  /**
   * The body's 16-sector fetch profile, in metres — how far the lake runs from each bearing.
   *
   * Optional, and absent simply leaves the wind fill flat. See {@link fetchIntensityAt} for why it is
   * also ignored on lakes under a kilometre of reach, which is most of them.
   */
  fetchProfileM?: readonly number[] | null;
  /** Scale. Defaults to {@link PX_PER_HOUR}; raise it to zoom in. */
  pxPerHour?: number;
  /**
   * How far the viewport has scrolled back from *now*, in px. 0 shows the most recent days.
   *
   * In pixels rather than days because the scale is fixed and the edges are allowed to crop: a
   * whole-day offset could not express "half a day back", which is most of the positions a drag
   * passes through.
   */
  scrollPx?: number;
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
  /**
   * Whether this column's date label should be drawn — see {@link MIN_DAY_LABEL_WIDTH}.
   *
   * ⚠ **Decided here rather than in each renderer**, so the two clients thin the axis identically.
   * A renderer that ignored this would draw thirty overlapping labels; one that invented its own
   * threshold would disagree with the other about which dates the chart names.
   */
  showLabel: boolean;
  /**
   * Where to centre this column's label — **the column centre, pulled inside the viewport at the
   * ends.**
   *
   * ⚠ A centred label on the first column overhangs the left edge and gets clipped: at 30 days the
   * column is ~12px wide and `Mon 12` is ~34px, so two thirds of it hangs off. Clamping is not a
   * cosmetic nicety here — the leftmost label is the one that says *where the window starts*, which
   * is exactly what a reader who has just panned needs to read.
   */
  labelX: number;
}

/** Half the width of a rendered `Wed 14` at 9px — how far a label must stay from either edge. */
const LABEL_HALF_WIDTH = 18;

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

/**
 * Height of the emphasis rail, in px — the bar drawn along an auxiliary lane's baseline.
 *
 * ⚠ **A rail rather than a full-height shaded region, and rendering it settled the question.** In a
 * 24px lane a full-height highlight is indistinguishable from a tall value: a week that was calm and
 * freezing throughout drew a block reaching the top of the wind lane, which reads as *high wind* —
 * the exact opposite of what the emphasis means. A rail sits below the trace, cannot be mistaken for
 * magnitude, and still answers "when".
 */
export const EMPHASIS_RAIL_HEIGHT = 3;

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
  /**
   * The same area cut into runs of equal **secondary magnitude**, for filling at varying density.
   *
   * Only the wind lane populates it, with fetch — the line's height is how hard it blew, the fill's
   * opacity how much open water that bearing had behind it. Empty means the lane has no second
   * measure (or the lake is too small for fetch to mean anything), and the renderer draws `area` at
   * one flat opacity instead.
   */
  areaSegments: { d: string; intensity: number }[];
  /**
   * The same shape's **top edge only**, for stroking over the fill.
   *
   * ⚠ **Not decoration — it is what keeps the series readable inside its own emphasis.** The emphasis
   * spans are filled blocks behind the trace, and against them a low-opacity area alone disappears:
   * a week that was calm and freezing throughout renders as one featureless slab, which is precisely
   * the reading where the wind detail matters most.
   */
  line: string;
  /**
   * The same edge, cut into runs by whether the lane's measure was **actually happening**.
   *
   * Only the sun lane uses the distinction today: its trace is yellow while the sun is up and neutral
   * when it is not, so a glance reads daylight without reading values. A lane with no `active`
   * predicate returns one run with `active: true`, which renderers draw in a single color — so
   * consuming `segments` instead of `line` is always correct and never lane-specific.
   *
   * ⚠ **A separate split from the gap split, and both apply.** A run ends at a data hole *or* at the
   * moment the measure crosses into or out of being active, because a path that spans either one
   * would be drawn in a single color that is wrong for half its length.
   */
  segments: { d: string; active: boolean }[];
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

/**
 * Lay the visible lanes down the viewport.
 *
 * ⚠ **A hidden lane gives its height back rather than leaving a hole**, which is the whole point of
 * hiding one: the remaining lanes rescale into the space and the chart keeps its stated height. A
 * hidden lane still gets a box — a degenerate one at the bottom edge — so a renderer that reads
 * `boxes.wind` without checking never lands on `undefined` and draws a mark at NaN.
 */
function laneBoxes(
  height: number,
  overrides: Partial<Record<TimelineLane, number>> | undefined,
  hidden: ReadonlySet<TimelineLane>,
): Record<TimelineLane, LaneBox> {
  const shown = TIMELINE_LANES.filter((lane) => !hidden.has(lane));
  const requested = shown.map((lane) => ({
    lane,
    h: Math.max(1, overrides?.[lane] ?? DEFAULT_LANE_HEIGHTS[lane]),
  }));
  const chrome = DAY_LABEL_HEIGHT + LANE_GAP * Math.max(0, shown.length - 1);
  const available = Math.max(Math.max(1, shown.length), height - chrome);
  const requestedTotal = requested.reduce((sum, r) => sum + r.h, 0) || 1;
  // Rescaled rather than clipped: a caller asking for 180px gets proportionally shorter lanes
  // instead of a snow-depth lane hanging off the bottom of its own viewport.
  const scale = available / requestedTotal;

  const boxes = {} as Record<TimelineLane, LaneBox>;
  let top = DAY_LABEL_HEIGHT;
  for (const { lane, h } of requested) {
    const laneHeight = h * scale;
    boxes[lane] = { top, bottom: top + laneHeight, height: laneHeight };
    top += laneHeight + LANE_GAP;
  }
  for (const lane of TIMELINE_LANES) {
    if (!boxes[lane]) boxes[lane] = { top: height, bottom: height, height: 0 };
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

/**
 * Runs of consecutive hours where a condition held, as drawable spans.
 *
 * ⚠ **A gap ends a span, exactly as it breaks a path — and getting this wrong is worse here than on
 * the line.** The first version only asked whether each *observed* hour qualified, so a cell that was
 * calm and freezing on Wednesday and again on Friday drew **one continuous emphasis straight across a
 * missing Thursday** — a solid block asserting a 72-hour black-ice window over a day nobody has any
 * data for. A broken line is visibly absent; a filled span is a positive claim, so smoothing one over
 * a hole invents evidence rather than merely hiding its absence. Caught by rendering it.
 */
function emphasisSpans(
  positioned: readonly PositionedHour[],
  hourWidth: number,
  holds: (hour: TimelineHour) => boolean,
): EmphasisSpan[] {
  const spans: EmphasisSpan[] = [];
  let start: number | null = null;
  let end = 0;
  let previousX: number | null = null;
  for (const p of positioned) {
    const broken = previousX !== null && p.x - previousX > hourWidth * MAX_INTERPOLATED_SLOTS;
    if (broken && start !== null) {
      spans.push({ x: start, width: end - start });
      start = null;
    }
    previousX = p.x;
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
  options: {
    /**
     * Whether the measure was *happening* at this hour, for lanes whose trace changes color when it
     * is. Absent means always — the lane draws in one color, right for wind and snow depth.
     */
    active?: (hour: TimelineHour, value: number) => boolean;
    /**
     * A **second** magnitude for this hour, in `[0, 1]`, rendered as the fill's density.
     *
     * The wind lane's fetch: the line's height is how hard it blew, and the fill's opacity is how
     * much open water that bearing had behind it. Two measures, two channels, one lane — and the
     * fill was inert decoration before, so nothing was displaced. Absent leaves `areaSegments` empty
     * and the renderer draws `area` at one flat opacity.
     */
    intensity?: (hour: TimelineHour) => number | null;
  } = {},
): AuxLayer | null {
  const { active, intensity } = options;
  const values: { x: number; v: number; active: boolean; intensity: number | null }[] = [];
  for (const p of positioned) {
    const v = measure(p.hour);
    if (v !== null && Number.isFinite(v)) {
      values.push({
        x: p.x,
        v,
        active: active ? active(p.hour, v) : true,
        intensity: intensity ? intensity(p.hour) : null,
      });
    }
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

  const line = runs
    .map((run) => linePath(run.map((p) => ({ x: p.x, y: y(p.v) }))))
    .filter((d) => d.length > 0)
    .join(' ');

  // Split again on the active flag, *within* each gap-run. ⚠ The two splits compose rather than
  // replace each other: a run must end at a data hole and also at every crossing into or out of
  // activity, or one path gets stroked in a single color that is wrong for half its length.
  //
  // Each active run is extended by one point into its neighbour so consecutive segments meet instead
  // of leaving a one-hour hole at every sunrise and sunset — without it the sun trace is visibly
  // dashed at exactly the two moments a reader looks for.
  const segments: { d: string; active: boolean }[] = [];
  for (const run of runs) {
    // ⚠ The offset is carried rather than recovered with `indexOf`: the stretches partition the run
    // in order, so the start of each is the sum of the lengths before it. `indexOf` made this a
    // linear scan per stretch, on a model that is rebuilt on every scrolled pixel.
    let startIndex = 0;
    for (const stretch of runsOf(run, (prev, next) => prev.active !== next.active)) {
      const first = stretch[0];
      if (first) {
        const points = run
          .slice(startIndex, startIndex + stretch.length + 1)
          .map((p) => ({ x: p.x, y: y(p.v) }));
        const d = linePath(points);
        if (d.length > 0) segments.push({ d, active: first.active });
      }
      startIndex += stretch.length;
    }
  }

  // The area again, but cut into runs of equal fetch band so each can be filled at its own opacity.
  // Bucketed rather than per-hour: wind direction turns slowly, so runs are long and a week costs a
  // handful of paths instead of 168 — and the eye cannot read more than a few density steps anyway.
  const areaSegments: { d: string; intensity: number }[] = [];
  // ⚠ Nothing is banded unless *something* has a second measure. A lake under `MIN_FETCH_CLAUSE_M`
  // returns null for every hour, and it must keep falling through to the flat `area` — emitting
  // floor-intensity bands for it would repaint the whole lane in the density channel's colour to say
  // nothing at all.
  if (intensity && values.some((v) => v.intensity !== null)) {
    const bucket = (i: number | null) =>
      i === null
        ? -1
        : Math.min(FETCH_INTENSITY_LEVELS - 1, Math.floor(i * FETCH_INTENSITY_LEVELS));
    for (const run of runs) {
      let startIndex = 0;
      for (const stretch of runsOf(run, (a, b) => bucket(a.intensity) !== bucket(b.intensity))) {
        const first = stretch[0];
        // Extended one point into the next run, or every band change leaves a vertical seam of bare
        // background through the fill.
        const points = run.slice(startIndex, startIndex + stretch.length + 1);
        startIndex += stretch.length;
        const head = points[0];
        const tail = points[points.length - 1];
        if (!first || !head || !tail) continue;
        const top = points.map((p) => `L ${p.x.toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ');
        areaSegments.push({
          d:
            `M ${head.x.toFixed(2)} ${box.bottom.toFixed(2)} ${top} ` +
            `L ${tail.x.toFixed(2)} ${box.bottom.toFixed(2)} Z`,
          // ⚠ **A stretch with no second measure is drawn at the floor, never skipped.** Skipping it
          // punched a hole in the fill: the renderer only falls back to the flat `area` when
          // `areaSegments` is *entirely* empty, so one hour missing `wind_direction_10m` in the
          // middle of an otherwise-banded week left bare background where the lane should be. The
          // floor is the honest reading of "no reach information here", and it keeps the shape whole.
          //
          // Otherwise reported as the band's own centre rather than the raw value, so the renderer's
          // opacity steps line up with the runs the geometry actually cut.
          intensity:
            first.intensity === null ? 0 : (bucket(first.intensity) + 0.5) / FETCH_INTENSITY_LEVELS,
        });
      }
    }
  }

  return {
    box,
    area,
    areaSegments,
    line,
    segments,
    emphasis: emphasisSpans(positioned, hourWidth, holds),
    max,
  };
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

  // **Fixed scale, scrolled viewport** — the founder's call, 2026-09-04. Until now the window was
  // exactly N whole days stretched to fill whatever width the container gave, so an hour was 2.29 px
  // in the sidebar, 2.13 on a phone and 1.94 on an SE: the same weather drew a different shape on
  // every screen, and nothing could be designed against it.
  //
  // Now an hour is always `pxPerHour` and the *viewport* is whatever fits. A day that only half fits
  // is drawn half — deliberately, because a cropped column at the edge is the cheapest possible hint
  // that there is more to scroll to.
  const hourWidth = input.pxPerHour ?? PX_PER_HOUR;
  const dayWidth = hourWidth * 24;
  const contentWidth = ordered.length * dayWidth;
  const maxScrollPx = Math.max(0, contentWidth - width);
  // `scrollPx` counts backwards from the newest edge, matching the offset convention the scrollbar
  // and the keyboard already use: 0 is "showing the most recent", growing as you travel back.
  const scrollPx = Math.min(Math.max(input.scrollPx ?? 0, 0), maxScrollPx);
  const viewportLeft = maxScrollPx - scrollPx;

  // ⚠ **The wind lane is kept whenever there is wind data, whatever the fetch — reversed 2026-09-04,
  // the day after it briefly worked the other way.** Hiding it below `MIN_FETCH_CLAUSE_M` bought 24px
  // and cost the two things the lane is actually for: the *line* is wind speed, and the rail is the
  // calm-while-freezing span that `weatherDay.ts` calls "the single most useful number in this
  // record". Both are measured on every lake regardless of its shape. **Only the fill's density needs
  // a kilometre of reach** — so a small lake now draws a normal wind lane with a flat fill, which is
  // one missing channel rather than a missing measurement.
  //
  // `hiddenLanes` stays because `laneBoxes` needs the concept: a lane with no data at all (an archive
  // row predating `shortwave_radiation`, say) still returns `null` from `auxLayer` below.
  const hiddenLanes = new Set<TimelineLane>();
  const boxes = laneBoxes(height, input.laneHeights, hiddenLanes);

  const days: TimelineDayColumn[] = [];
  const positioned: PositionedHour[] = [];

  // Every Nth column carries a label once they get too narrow to each hold one. Anchored on index 0
  // so the labelled set is stable as the window pans — labels that reshuffle under a drag read as the
  // chart jumping rather than sliding.
  const labelEvery = Math.max(1, Math.ceil(MIN_DAY_LABEL_WIDTH / dayWidth));

  ordered.forEach((day, index) => {
    // ⚠ Off-viewport columns are still emitted, at negative or overflowing `x`. The SVG viewBox clips
    // them, and keeping them is what lets a path run continuously *through* the edge instead of
    // stopping dead at it — a line that ended at x=0 would read as a data gap at every scroll offset.
    const x = index * dayWidth - viewportLeft;
    const visibleLeft = Math.max(x, 0);
    const visibleRight = Math.min(x + dayWidth, width);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const hasHours = (day.hours?.length ?? 0) > 0;
    days.push({
      dayMs: day.dayMs,
      localDate: day.localDate,
      x,
      width: dayWidth,
      missing: day.missing === true || !hasHours,
      partial: day.partial === true,
      // ⚠ Both of these read the column's **visible** width, not its full one. A day cropped to 9px
      // at the edge has no room to be named — labelling it would overprint its neighbour — and a
      // fully off-screen column must not have its label dragged into the viewport, which is what
      // clamping against the viewport alone used to do: every off-screen day piled its label on the
      // same pixel.
      showLabel: visibleWidth >= MIN_DAY_LABEL_WIDTH && index % labelEvery === 0,
      labelX: clamp(
        x + dayWidth / 2,
        visibleLeft + Math.min(LABEL_HALF_WIDTH, visibleWidth / 2),
        visibleRight - Math.min(LABEL_HALF_WIDTH, visibleWidth / 2),
      ),
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

    // ⚠ **Split on `partial`, never filtered by it.** Dropping the partial points out of a run and
    // pathing what remained joined the hours on either side of them with a straight line — the exact
    // "one confident line across weather nobody observed" the gap rule above exists to prevent, now
    // arriving through the provisional flag instead of through a hole. It also left a one-hour break
    // between the settled trace and the dashed one at every boundary, because the two never shared a
    // point. Each stretch is extended one point into its neighbour so they meet, the same way the
    // auxiliary lanes' active/inactive split does.
    const settled: string[] = [];
    const provisional: string[] = [];
    for (const run of runs) {
      let startIndex = 0;
      for (const stretch of runsOf(run, (prev, next) => prev.partial !== next.partial)) {
        const first = stretch[0];
        const points = run.slice(startIndex, startIndex + stretch.length + 1);
        startIndex += stretch.length;
        if (!first) continue;
        const d = linePath(points);
        if (d === '') continue;
        (first.partial ? provisional : settled).push(d);
      }
    }

    temperature = {
      box,
      segments: settled,
      partialSegments: provisional,
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
    // The second channel: the line's height is how hard it blew, the fill's density how much open
    // water that bearing had behind it. Returns null — and so draws flat — on any lake under a
    // kilometre of fetch, which is most of them.
    { intensity: (h) => fetchIntensityAt(input.fetchProfileM, h.windDirectionDeg) },
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
    // **Any** shortwave at all, not the `SUNLIT_WM2` threshold — the trace turns yellow when the sun
    // is up, which is a fact about the sky rather than about intensity. A dim overcast morning is
    // still daytime, and drawing it as night would make the lane disagree with the reader's own
    // memory of the day. The stronger threshold still governs the emphasis rail above.
    { active: (_h, value) => value > 0 },
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
/**
 * The archive payload's shape, as `getWeatherDaysForBody` returns it.
 *
 * ⚠ **Every list is optional, and that is not defensive padding.** `hours` was added in N6h
 * Workstream D, so a client running a cached bundle against a newer backend — or any caller
 * constructing this by hand — legitimately arrives without it. Treating a missing list as a hard
 * error meant the *whole panel* vanished: the adapter threw, the fetch's own `.catch` swallowed it,
 * and the sentences that had nothing to do with the chart disappeared along with it. An absent list
 * is an empty one.
 */
export interface ArchiveTimelineInput {
  days?: readonly { dayMs: number; localDate: string; hours?: number }[];
  hours?: readonly {
    dayMs: number;
    localDate: string;
    hours: readonly { localHour: number; temperatureC: number; [measure: string]: number }[];
  }[];
  missingDayMs?: readonly number[];
  /**
   * The **lake's** current local day — `localDayMsAt(Date.now(), cellOffsetSeconds)`.
   *
   * Required so the current column can be drawn as partial. Today's row arrives holding all 24 hours
   * with the un-elapsed ones forecast, so it cannot be recognised by hour count alone.
   */
  todayLocalDayMs: number;
}

/**
 * Turn the archive's two parallel lists into the day series the model consumes.
 *
 * **Shared rather than written twice**, for the reason the geometry is: two clients reconciling the
 * same three lists by hand is two chances to decide differently which days count as holes.
 *
 * Three rules it enforces:
 *
 * 1. **`missingDayMs` wins over silence.** A day the archive explicitly could not get and a day that
 *    simply produced no row are both holes, but only the first is *known* to be one — both are
 *    emitted, so neither is quietly dropped from the axis and the window keeps its true width.
 * 2. **A day with a summary but no hours is still a column.** It draws its label, its divider and its
 *    gap; it just contributes no line. This is the normal state for cells whose daily rows predate
 *    the hourly table, and it must not collapse the axis.
 * 3. **Partial is a question about the date, not only about `hours`.** This used to read "derived
 *    from `hours`, not guessed from the date", on the grounds that the archive records how many hours
 *    it observed. That was wrong, and confidently so: Open-Meteo returns whole calendar days and
 *    nothing trims them, so today's row holds 24 hours — the un-elapsed ones forecast — from the
 *    first fetch of the morning. Today was never drawn as partial, because by hour count it never
 *    looked it. `todayLocalDayMs` is what makes the current column honest.
 */
export function timelineDaysFromArchive(input: ArchiveTimelineInput): TimelineDayInput[] {
  const inputDays = input.days ?? [];
  const inputHours = input.hours ?? [];
  const inputMissing = input.missingDayMs ?? [];
  const hoursByDay = new Map(inputHours.map((h) => [h.dayMs, h]));
  const summaryByDay = new Map(inputDays.map((d) => [d.dayMs, d]));
  const keys = new Set<number>([
    ...inputDays.map((d) => d.dayMs),
    ...inputHours.map((h) => h.dayMs),
    ...inputMissing,
  ]);
  const known = new Set(inputMissing);

  return [...keys]
    .sort((a, b) => a - b)
    .map((dayMs) => {
      const hourRow = hoursByDay.get(dayMs);
      const summary = summaryByDay.get(dayMs);
      const localDate = hourRow?.localDate ?? summary?.localDate ?? dayMsToLocalDate(dayMs);
      const observed = summary?.hours;
      return {
        dayMs,
        localDate,
        ...(hourRow ? { hours: hourRow.hours.map(toTimelineHour) } : {}),
        ...(known.has(dayMs) || (!hourRow && !summary) ? { missing: true } : {}),
        // Two ways to be partial: too few hours for even a spring-forward day (23, not 24 — calling
        // that partial would grey out a settled day once a year), or being today.
        ...(typeof observed === 'number' && !isCompleteDay(observed, dayMs, input.todayLocalDayMs)
          ? { partial: true }
          : {}),
      };
    });
}

/** Widen a stored hour (an open record of numbers) into the model's input type. */
function toTimelineHour(h: {
  localHour: number;
  temperatureC: number;
  [measure: string]: number;
}): TimelineHour {
  // Spelled out rather than looped over a key list: a loop needs a cast through `Record<string,
  // unknown>` to satisfy `exactOptionalPropertyTypes`, and a cast here would silently accept a
  // renamed stored field as `undefined` — which the chart would draw as "no wind" rather than fail on.
  const num = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    localDate: '', // unused by the model, which buckets by the day that owns the hour
    localHour: h.localHour,
    temperatureC: h.temperatureC,
    ...(num(h.precipitationMm) === undefined ? {} : { precipitationMm: h.precipitationMm }),
    ...(num(h.rainMm) === undefined ? {} : { rainMm: h.rainMm }),
    ...(num(h.snowfallCm) === undefined ? {} : { snowfallCm: h.snowfallCm }),
    ...(num(h.snowDepthM) === undefined ? {} : { snowDepthM: h.snowDepthM }),
    ...(num(h.windSpeedKph) === undefined ? {} : { windSpeedKph: h.windSpeedKph }),
    ...(num(h.windDirectionDeg) === undefined ? {} : { windDirectionDeg: h.windDirectionDeg }),
    ...(num(h.shortwaveWm2) === undefined ? {} : { shortwaveWm2: h.shortwaveWm2 }),
    ...(num(h.weatherCode) === undefined ? {} : { weatherCode: h.weatherCode }),
  };
}

// `dayMs` → `YYYY-MM-DD` for a hole with neither a summary nor hours to name it comes from
// `weatherDay.dayMsToLocalDate`, which owns the encoding. A second local copy lived here and was a
// character-for-character duplicate of it.

/**
 * The scrub readout, as a list of fields — **shared, because it is a sentence and sentences live
 * here.**
 *
 * ⚠ **It was written twice and the two copies had already drifted**: web said `2.1″ on the ground`
 * where native said `2.1″ down`, on the same measurement, from the same model. `weatherPanel.ts`
 * states the rule this restores — every phrase the two clients render verbatim belongs in one tested
 * module, because "observation, never counsel" (D3 / D150) is only enforceable where it can be
 * tested, and mobile has no RN-under-Vitest harness at all.
 *
 * Returned as parts rather than a joined string so a renderer can lay them out however its platform
 * wants; both clients happen to join on ` · `.
 */
export function timelineReadoutParts(
  hour: TimelineHour,
  fetchProfileM?: readonly number[] | null,
): string[] {
  const parts = [formatLocalHour(hour.localHour), formatTemperatureF(hour.temperatureC)];

  const precip = precipitationKind(hour);
  if (precip) {
    const amount =
      typeof hour.snowfallCm === 'number' && hour.snowfallCm > 0
        ? `${roundTo(cmToInches(hour.snowfallCm), 1)}″`
        : `${roundTo(mmToInches(hour.precipitationMm ?? hour.rainMm ?? 0), 2)}″`;
    parts.push(`${precip.label} ${amount}`);
  }

  if (typeof hour.windSpeedKph === 'number') {
    // Direction reads as "from the NW", the meteorological convention every compass label in this
    // app already uses — and the half of wind that a speed alone cannot tell you.
    const from =
      typeof hour.windDirectionDeg === 'number'
        ? ` ${COMPASS_LABELS[windSectorOf(hour.windDirectionDeg)] ?? ''}`
        : '';
    parts.push(`${Math.round(kphToMph(hour.windSpeedKph))} mph${from}`);
    // ⚠ **"across the lake", never "of open water".** The app already uses *open water* as a hazard
    // type — the on-ice alert says "⚠ open water ~45 s ahead", meaning unfrozen water you are about
    // to skate into. Reusing it for fetch would make the same two words mean "the lake is not
    // frozen" in one place and "the wind had a long run" in another, on a page about frozen lakes.
    //
    // Gated where the lake's geometry supports the claim: `fetchAlong` returns null below
    // `MIN_FETCH_CLAUSE_M`, which is ~95% of the corpus.
    const acrossM = fetchAlong(fetchProfileM, hour.windDirectionDeg);
    if (acrossM !== null) parts.push(`${roundTo(acrossM / 1000, 1)} km across the lake`);
  }

  if (typeof hour.snowDepthM === 'number' && hour.snowDepthM > 0) {
    parts.push(`${roundTo(cmToInches(hour.snowDepthM * 100), 1)}″ on the ground`);
  }
  return parts;
}

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
