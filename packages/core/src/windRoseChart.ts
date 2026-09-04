/**
 * Geometry for the wind-exposure rose — **pure, and deliberately not a component** (N7-3).
 *
 * The same picture ships on the web app (SVG) and in the native app (`react-native-svg`), and those
 * two renderers share no element types at all. What they *can* share is the arithmetic, so this
 * module returns plain coordinates and the renderers do nothing but map them onto their own
 * primitives. A polar chart is mostly trigonometry with a lot of places to be subtly wrong; doing it
 * twice would mean two subtly different charts.
 *
 * ## What the picture encodes
 *
 * Two measurements, two channels, one hue — matching the founder's mockup:
 *
 * - **Frequency** (`windRose`) is the filled radial area. How *often* wind comes from a direction.
 * - **Mean speed** (`meanWindMps`) sizes the arrows around the rim. How *hard* it blows when it does.
 *
 * They are genuinely different questions and routinely disagree. At Willoughby the commonest wind is
 * northwesterly (19.2% of winter hours) while the hardest *average* wind comes from the **east** —
 * which is also the quadrant the ridges block, at 1.6% of hours. Rare and strong is a real pattern,
 * and a rose alone cannot say it: the frequency plot there is nearly empty.
 *
 * ## Why one hue, and no warm ramp
 *
 * The obvious design colors stronger wind red or amber. That would be a **safety signal**, and D145
 * settled that wind data on a lake page is context rather than counsel — the same call D82 made for
 * bathymetry. A reader must be able to see that one shore gets hit harder without the page implying
 * they will fall through the ice there. So intensity rides on *size*, which is a magnitude channel,
 * and color stays a single family. That also keeps the chart legible under every CVD type, because
 * nothing here is encoded by hue at all.
 */

import { COMPASS_POINTS_16, type CompassPoint16 } from './lakeGeometry';
import { WIND_ROSE_SECTORS } from './windRose';

/** Degrees per sector — 16 compass points around the circle. */
const DEGREES_PER_SECTOR = 360 / WIND_ROSE_SECTORS;

/**
 * The mean speed that draws a full-length arrow, in m/s.
 *
 * **Fixed rather than per-lake, on purpose.** Normalising each chart to its own maximum makes every
 * lake look equally windy — a sheltered pond and an exposed reservoir would both show one full-size
 * arrow — and two lakes could not be compared by eye, which is most of what a reader does with a
 * profile page. A shared reference means arrow size carries an absolute claim.
 *
 * **10 m/s (~22 mph) is set from the corpus distribution, not from its maximum.** Measured over
 * derived bodies: median peak sector **4.7 m/s**, p90 **6.8**, p95 **8.0**, p99 **11.1**, max
 * **14.54**. An earlier draft used 15 — the observed maximum — so that nothing would ever clamp, and
 * the result was a chart where the *median* lake's longest arrow reached 31% of the band and read as
 * a speck. Scaling to the outlier made the common case illegible.
 *
 * At 10 the median lake peaks near half the band and **1.3% of lakes clamp** at the ceiling. That is
 * a real loss — the windiest few draw identical full-length arrows — and it is the right trade,
 * because their exact figures are still in the blurb and the numbers table while the readability of
 * the other 98.7% is not recoverable any other way.
 *
 * Still deliberate: a sheltered pond averaging 2 m/s draws visibly short arrows. That *is* the
 * picture, and it is the whole reason the scale is shared rather than per-lake.
 */
export const WIND_ARROW_REFERENCE_MPS = 10;

/**
 * How the radius is divided, outward from the centre: frequency plot, gap, arrow band, label ring.
 *
 * Split explicitly because the first version allotted the arrows whatever was left after a single
 * `rimFraction` — about 12px of a 176px chart — and then drew the compass labels *into the same
 * band*. Arrows were both tiny and colliding with the letters.
 */
export const WIND_ROSE_LABEL_BAND = 0.14;
export const WIND_ROSE_ARROW_BAND = 0.3;
export const WIND_ROSE_ARROW_GAP = 0.03;

/** Arrow half-width as a share of its length — the triangle's proportions. */
const ARROW_HALF_WIDTH_RATIO = 0.42;

/** A point in the chart's own pixel space. */
export interface ChartPoint {
  x: number;
  y: number;
}

export interface WindRoseArrow {
  /** Index into the 16 compass points — the direction wind blows FROM. */
  sector: number;
  label: CompassPoint16;
  /** Mean winter speed from this sector, m/s. */
  meanMps: number;
  /** `meanMps / WIND_ARROW_REFERENCE_MPS`, clamped to `[0, 1]` — what sizes the glyph. */
  intensity: number;
  /** The arrow as a closed triangle, already positioned and rotated. Points inward. */
  points: [ChartPoint, ChartPoint, ChartPoint];
  /** The most-exposed sector, drawn solid. At most one arrow carries this. */
  emphasized: boolean;
}

export interface WindRoseRing {
  radius: number;
  /** The frequency this ring stands for, in `[0, 1]`. */
  frequency: number;
}

export interface WindRoseChartModel {
  size: number;
  center: ChartPoint;
  /** Outer radius of the frequency area — the arrows live beyond it. */
  plotRadius: number;
  /** Closed polygon of the frequency area, one vertex per sector. */
  areaPoints: ChartPoint[];
  /** Hairline reference circles, largest last. */
  rings: WindRoseRing[];
  /** Sector dividers, drawn from centre to `plotRadius`. */
  spokes: { from: ChartPoint; to: ChartPoint }[];
  /** Sized speed glyphs. Sectors with no speed reading are **absent**, not zero-length. */
  arrows: WindRoseArrow[];
  /** N/E/S/W placements for the outer labels. */
  cardinals: { label: string; at: ChartPoint }[];
  /** The largest frequency in the rose — what the outermost ring represents. */
  maxFrequency: number;
  /** Present only when a sector was emphasised. */
  emphasizedSector: number | null;
}

export interface WindRoseChartInput {
  /** 16 frequencies summing to 1. */
  rose: readonly number[];
  /** 16 mean speeds in m/s; `null` per sector with no reading. Absent hides every arrow. */
  meanWindMps?: readonly (number | null)[] | null | undefined;
  /**
   * Which sector to draw solid — normally `mostExposedSector().sector`, which is frequency × fetch.
   *
   * Passed in rather than computed here so the chart cannot disagree with the sentence beside it:
   * one function decides what "most exposed" means (D90) and both the copy and the picture read it.
   */
  emphasizedSector?: number | null | undefined;
  /** Square viewport edge in px. */
  size: number;
  /** Override the arrow band, as a share of the radius. Defaults to `WIND_ROSE_ARROW_BAND`. */
  arrowBandFraction?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Compass bearing → a point at `radius`, with north up and bearings running clockwise. */
export function polarPoint(center: ChartPoint, radius: number, bearingDeg: number): ChartPoint {
  // SVG's y axis points down, so north (0°) is -y and east (90°) is +x. Getting this backwards
  // mirrors the rose about the horizontal axis, which is invisible on a symmetric lake and wrong
  // on every other one.
  const radians = (bearingDeg * Math.PI) / 180;
  return {
    x: center.x + radius * Math.sin(radians),
    y: center.y - radius * Math.cos(radians),
  };
}

/**
 * Ring frequencies for the grid — at most three, at "nice" percentages.
 *
 * The rings are the chart's only quantitative scale, so they are chosen to land on numbers a reader
 * can say out loud (5%, 10%, 25%) rather than on an exact fraction of the maximum.
 */
export function ringFrequencies(maxFrequency: number): number[] {
  const candidates = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
  const rings = candidates.filter((c) => c < maxFrequency);
  // Keep the outermost three below the max, so the area never sits flush against a gridline.
  return rings.slice(-3);
}

/**
 * Build the whole chart model, or `null` when there is no rose to draw.
 *
 * Returns `null` rather than an empty model because "no wind data" must render **nothing** — an
 * empty rose is a circle of zeros, which reads as a measured calm rather than as an absence.
 */
export function windRoseChartModel(input: WindRoseChartInput): WindRoseChartModel | null {
  const { rose, meanWindMps, emphasizedSector, size } = input;
  if (!Array.isArray(rose) || rose.length !== WIND_ROSE_SECTORS) return null;
  if (!(size > 0)) return null;

  const maxFrequency = Math.max(...rose);
  if (!Number.isFinite(maxFrequency) || maxFrequency <= 0) return null;

  const center: ChartPoint = { x: size / 2, y: size / 2 };
  const outerRadius = size / 2;
  const arrowBand = outerRadius * (input.arrowBandFraction ?? WIND_ROSE_ARROW_BAND);
  const arrowGap = outerRadius * WIND_ROSE_ARROW_GAP;
  // Every band is subtracted explicitly, so the plot can never quietly eat the arrows' room.
  const plotRadius = outerRadius - arrowBand - arrowGap - outerRadius * WIND_ROSE_LABEL_BAND;

  // The area scale is anchored at zero and topped at the lake's own maximum, which is the one place
  // per-lake normalisation is right: the rose is a *shape*, and its shape is the claim. Absolute
  // frequency is carried by the ring labels and the sentence.
  const areaPoints = rose.map((frequency, sector) =>
    polarPoint(center, clamp01(frequency / maxFrequency) * plotRadius, sector * DEGREES_PER_SECTOR),
  );

  const rings = ringFrequencies(maxFrequency).map((frequency) => ({
    frequency,
    radius: (frequency / maxFrequency) * plotRadius,
  }));

  const spokes = Array.from({ length: WIND_ROSE_SECTORS }, (_, sector) => ({
    from: center,
    to: polarPoint(center, plotRadius, sector * DEGREES_PER_SECTOR),
  }));

  const arrows: WindRoseArrow[] = [];
  if (Array.isArray(meanWindMps) && meanWindMps.length === WIND_ROSE_SECTORS) {
    const tipRadius = plotRadius + arrowGap;
    // **The band has to bound the whole triangle, not its centreline.** A base corner sits half a
    // width off-axis, so its distance from the centre is `hypot(tipRadius + L, halfWidth)` — which
    // overshoots the band even when the back edge fits exactly. Solving
    //   (tipRadius + L)² + (w·L)² = limit²
    // for L gives the longest arrow whose corners still clear the label ring. Ignoring it let the
    // glyphs bulge into the compass letters by about a pixel at full intensity.
    const limit = outerRadius - outerRadius * WIND_ROSE_LABEL_BAND;
    const w2 = ARROW_HALF_WIDTH_RATIO * ARROW_HALF_WIDTH_RATIO;
    const discriminant = tipRadius * tipRadius - (1 + w2) * (tipRadius * tipRadius - limit * limit);
    const fitted = discriminant > 0 ? (-tipRadius + Math.sqrt(discriminant)) / (1 + w2) : 0;
    const maxLength = Math.max(0, Math.min(arrowBand, fitted));
    for (let sector = 0; sector < WIND_ROSE_SECTORS; sector++) {
      const mps = meanWindMps[sector];
      // `null` means no reading and draws nothing. A measured 0 would draw a degenerate arrow, which
      // is the honest picture of a calm: the absence of a glyph must not be confused with it, which
      // is why the data layer keeps those two cases apart in the first place.
      if (typeof mps !== 'number' || !Number.isFinite(mps) || mps < 0) continue;
      const intensity = clamp01(mps / WIND_ARROW_REFERENCE_MPS);
      const length = maxLength * intensity;
      if (length <= 0) continue;
      const bearing = sector * DEGREES_PER_SECTOR;
      const halfWidth = length * ARROW_HALF_WIDTH_RATIO;
      const tip = polarPoint(center, tipRadius, bearing);
      const backCenter = polarPoint(center, tipRadius + length, bearing);
      // The two base corners sit on the tangent at `backCenter`, which is the bearing rotated a
      // quarter turn — computed rather than approximated so the glyph stays symmetric at every angle.
      const left = polarPoint(center, tipRadius + length, bearing);
      const right = { ...left };
      const tangent = ((bearing + 90) * Math.PI) / 180;
      const dx = Math.sin(tangent) * halfWidth;
      const dy = -Math.cos(tangent) * halfWidth;
      left.x = backCenter.x - dx;
      left.y = backCenter.y - dy;
      right.x = backCenter.x + dx;
      right.y = backCenter.y + dy;
      arrows.push({
        sector,
        label: COMPASS_POINTS_16[sector] as CompassPoint16,
        meanMps: mps,
        intensity,
        points: [tip, left, right],
        emphasized: emphasizedSector === sector,
      });
    }
  }

  // Centred in the label ring, which the arrow band no longer reaches into.
  const cardinalRadius = outerRadius - (outerRadius * WIND_ROSE_LABEL_BAND) / 2;
  const cardinals = [
    { label: 'N', sector: 0 },
    { label: 'E', sector: 4 },
    { label: 'S', sector: 8 },
    { label: 'W', sector: 12 },
  ].map(({ label, sector }) => ({
    label,
    at: polarPoint(center, cardinalRadius, sector * DEGREES_PER_SECTOR),
  }));

  return {
    size,
    center,
    plotRadius,
    areaPoints,
    rings,
    spokes,
    arrows,
    cardinals,
    maxFrequency,
    emphasizedSector: typeof emphasizedSector === 'number' ? emphasizedSector : null,
  };
}

/** `areaPoints` as an SVG path — the one string both renderers need and neither should build. */
export function areaPath(model: WindRoseChartModel): string {
  const [first, ...rest] = model.areaPoints;
  if (!first) return '';
  const move = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  const lines = rest.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  return `${move} ${lines} Z`;
}

/** One arrow as an SVG polygon `points` string. */
export function arrowPoints(arrow: WindRoseArrow): string {
  return arrow.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// The sentences beside the picture
// ─────────────────────────────────────────────────────────────────────────────

/** m/s → mph. `STRONG_WIND_MIN_MPS` is 8.94 precisely because that is 20 mph. */
const MPS_TO_MPH = 2.23694;

/**
 * A sector is called out as blocked only below this share of winter hours.
 *
 * Some direction is always the quietest, and naming it on a lake with an even rose would be noise
 * dressed as insight. Below ~2% of a season the absence is a real feature of the place.
 */
export const WIND_BLOCKED_MAX_FREQUENCY = 0.02;

export interface WindSectorFact {
  sector: number;
  label: CompassPoint16;
}

export interface WindExposureSummary {
  /** Where wind blows from most often. Always present when there is a rose. */
  commonest: WindSectorFact & { frequency: number };
  /** Where the hardest average wind comes from. Absent without stored mean speed. */
  strongest: (WindSectorFact & { meanMps: number }) | null;
  /** Frequency × fetch, and only above `MIN_FETCH_CLAUSE_M`. */
  mostExposed: (WindSectorFact & { fetchM: number }) | null;
  /** A direction the wind essentially never comes from, when one stands out. */
  blocked: (WindSectorFact & { frequency: number }) | null;
  /** True when force and frequency disagree — the reason the chart has two channels. */
  strongestDiffersFromCommonest: boolean;
  /** Rendered prose, one string per sentence. */
  sentences: string[];
}

export interface WindExposureSummaryInput {
  rose: readonly number[];
  meanWindMps?: readonly (number | null)[] | null | undefined;
  /** Only used above `MIN_FETCH_CLAUSE_M`; below that a fetch claim is not worth making. */
  fetchProfileM?: readonly number[] | null | undefined;
  /** `mostExposedSector().sector`, so the prose and the emphasised arrow agree. */
  mostExposedSector?: number | null | undefined;
  minFetchClauseM: number;
  spokenDirection: (point: CompassPoint16) => string;
  formatMiles: (meters: number) => string;
}

/**
 * The blurb beside the rose.
 *
 * **Deliberately descriptive, never causal.** The founder's mockup closed with *"sheltered E and W
 * by terrain"*, and the terrain half is an inference this data cannot support: a rose says a
 * direction is rare, not why. At Willoughby it really is Pisgah and Hor, but asserting a mechanism
 * corpus-wide would be D90's original error running the other way — a claim about the landscape
 * dressed as a reading of the wind. So the sentence states the absence and stops.
 *
 * **Also never a warning.** Per D145 nothing here says a shore is dangerous, only what the record
 * says about it.
 */
export function windExposureSummary(input: WindExposureSummaryInput): WindExposureSummary | null {
  const { rose, meanWindMps, fetchProfileM, minFetchClauseM } = input;
  if (!Array.isArray(rose) || rose.length !== WIND_ROSE_SECTORS) return null;
  const maxFrequency = Math.max(...rose);
  if (!Number.isFinite(maxFrequency) || maxFrequency <= 0) return null;

  const at = (sector: number): WindSectorFact => ({
    sector,
    label: COMPASS_POINTS_16[sector] as CompassPoint16,
  });

  const commonestSector = rose.indexOf(maxFrequency);
  const commonest = { ...at(commonestSector), frequency: maxFrequency };

  let strongest: (WindSectorFact & { meanMps: number }) | null = null;
  if (Array.isArray(meanWindMps) && meanWindMps.length === WIND_ROSE_SECTORS) {
    let bestSector = -1;
    let best = -1;
    for (let k = 0; k < WIND_ROSE_SECTORS; k++) {
      const mps = meanWindMps[k];
      if (typeof mps !== 'number' || !Number.isFinite(mps)) continue;
      if (mps > best) {
        best = mps;
        bestSector = k;
      }
    }
    if (bestSector >= 0) strongest = { ...at(bestSector), meanMps: best };
  }

  let mostExposed: (WindSectorFact & { fetchM: number }) | null = null;
  const exposedSector = input.mostExposedSector;
  if (
    typeof exposedSector === 'number' &&
    Array.isArray(fetchProfileM) &&
    fetchProfileM.length === WIND_ROSE_SECTORS
  ) {
    const fetchM = fetchProfileM[exposedSector];
    if (typeof fetchM === 'number' && fetchM >= minFetchClauseM) {
      mostExposed = { ...at(exposedSector), fetchM };
    }
  }

  const minFrequency = Math.min(...rose);
  const blockedSector = rose.indexOf(minFrequency);
  const blocked =
    minFrequency <= WIND_BLOCKED_MAX_FREQUENCY
      ? { ...at(blockedSector), frequency: minFrequency }
      : null;

  const strongestDiffersFromCommonest = strongest !== null && strongest.sector !== commonest.sector;

  const sentences: string[] = [];
  sentences.push(
    `Winter wind comes most often from ${input.spokenDirection(commonest.label)}, about ` +
      `${Math.round(commonest.frequency * 100)}% of the time.`,
  );
  // Whether the hardest direction is itself a rare one. Willoughby is the case that made this worth
  // saying: its strongest average wind comes from the east, which is also the direction its ridges
  // block — a big arrow sitting on an almost-empty lobe. Without this sentence the picture looks
  // like a mistake.
  const strongestIsRare =
    strongest !== null && (rose[strongest.sector] as number) <= WIND_BLOCKED_MAX_FREQUENCY;
  if (strongest) {
    const mph = Math.round(strongest.meanMps * MPS_TO_MPH);
    const from = input.spokenDirection(strongest.label);
    sentences.push(
      !strongestDiffersFromCommonest
        ? `That is also where the hardest winds come from, averaging ${mph} mph.`
        : strongestIsRare
          ? `The hardest winds average ${mph} mph from ${from} — a direction the wind rarely takes.`
          : `The hardest winds average ${mph} mph and come from ${from} — a different direction.`,
    );
  }
  if (mostExposed) {
    // ⚠ **"of lake", not "of open water", and the reason is a collision rather than a preference.**
    // This app already uses *open water* as a **hazard type**: `hazardProjection.ts` drives the on-ice
    // alert that says "⚠ open water ~45 s ahead", meaning unfrozen water you are about to skate into.
    // Reusing the phrase for fetch made the same two words mean "this lake is not frozen" on one
    // surface and "the wind had a long run" on another, on pages about frozen lakes. The timeline's
    // scrub readout says "3.2 km across the lake" for the same measurement.
    sentences.push(
      `It is most exposed on ${input.spokenDirection(mostExposed.label)} shore, where ` +
        `${input.formatMiles(mostExposed.fetchM)} miles of lake line up with the wind.`,
    );
  }
  // Skipped once the rare-but-strong sentence has been said. The blocked sector and the rare-strong
  // one are usually *neighbours* — at Willoughby, ENE and E — so keeping both reads as two sentences
  // arguing about the same side of the lake. `blocked` stays populated either way; this drops the
  // sentence, not the fact.
  if (blocked && !strongestIsRare) {
    // No cause offered. See the docstring.
    sentences.push(`Wind almost never comes from ${input.spokenDirection(blocked.label)}.`);
  }

  return {
    commonest,
    strongest,
    mostExposed,
    blocked,
    strongestDiffersFromCommonest,
    sentences,
  };
}
