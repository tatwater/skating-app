import {
  BAND_EDGE_DEEP_COLD_F,
  BAND_EDGE_FREEZING_F,
  BAND_EDGE_THAW_F,
  bodyWeatherAnchor,
  COMPASS_LABELS,
  type ForecastPlanDay,
  type ForecastPlanHour,
  type PanelDay,
  subAreaWeatherPoint,
  type TemperatureLayer,
  windSectorOf,
} from '@skating/core';

import type { MapOverlay } from '../../map/mapSpec';

/**
 * The Weather tab's pure rules — what the tab shows, never how the weather is computed. Every
 * number on the tab comes from `@skating/core` (`buildPastWeatherPanel`, `buildForecastPlan`,
 * `weatherTimelineModel`, `buildSubAreaSpread`); this file only decides which places can be read,
 * which rows the sentences describe, and how a value already computed is worded on a card.
 */

// ── "Weather at" (Review 3, c-9vdox9) ──────────────────────────────────────────────────────────

/** One place the tab can read weather at: the whole lake (`id: null`) or one of its bays. */
export interface WeatherPlace {
  id: string | null;
  name: string;
}

/** The whole lake's own sample point — its interior point, read when no bay is chosen. */
export const WHOLE_LAKE: WeatherPlace = { id: null, name: 'Whole lake' };

/**
 * The places a lake's weather can be read at, in order: the whole lake, then each live bay (the
 * `subAreas.listForBody` order). Each one is its own sample point — the server reads the lake's
 * anchor without a `subAreaId` and a bay's own point with one (`sampleCoverage`).
 */
export function weatherPlaces(
  bays: readonly { _id: string; name: string; removed?: boolean }[] | undefined,
): WeatherPlace[] {
  return [
    WHOLE_LAKE,
    ...(bays ?? []).filter((b) => b.removed !== true).map((b) => ({ id: b._id, name: b.name })),
  ];
}

/**
 * **"Weather at" shows only when a lake has two or more weather sample points** (c-9vdox9). A lake
 * with one point has nothing to choose between, so the section starts at "What it's been through".
 */
export function showWeatherAt(places: readonly WeatherPlace[]): boolean {
  return places.length >= 2;
}

/** The place being read: the bay in view when it is one of the lake's, else the whole lake. */
export function selectedPlace(
  places: readonly WeatherPlace[],
  subAreaId: string | undefined,
): WeatherPlace {
  return places.find((p) => p.id !== null && p.id === subAreaId) ?? WHOLE_LAKE;
}

type LatLng = { lat: number; lng: number };

/**
 * The lake's weather sample points as a map overlay (board 1.7): the whole lake's at its weather
 * anchor and each live bay's at its own point — the same points the server reads (`bodyWeatherAnchor`,
 * `subAreaWeatherPoint`) — the one being read `lit`. Only when "Weather at" is offered: a lake with
 * one point has nothing to explain.
 */
export function weatherSamplesOverlay(
  lake: { _id: string; interiorPoint?: LatLng; representativePoint?: LatLng; centroid: LatLng },
  bays:
    | readonly {
        _id: string;
        name: string;
        removed?: boolean;
        representativePoint?: LatLng;
        centroid: LatLng;
      }[]
    | undefined,
  subAreaId: string | undefined,
): MapOverlay | null {
  const places = weatherPlaces(bays);
  if (!showWeatherAt(places)) return null;
  const lit = selectedPlace(places, subAreaId).id;
  const byId = new Map((bays ?? []).map((b) => [b._id, b]));
  const features = places.flatMap((place): GeoJSON.Feature[] => {
    const bay = place.id === null ? null : byId.get(place.id);
    // A row without a point (a partial read) is left off rather than drawn at the map's origin.
    const point: LatLng | undefined =
      place.id === null ? bodyWeatherAnchor(lake) : bay ? subAreaWeatherPoint(bay) : undefined;
    if (point === undefined) return [];
    return [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        properties: { name: place.name, lit: place.id === lit },
      },
    ];
  });
  return {
    key: `samples:${lake._id}:${places.map((p) => p.id ?? 'lake').join(',')}:${lit ?? 'lake'}`,
    data: { type: 'FeatureCollection', features },
  };
}

/** The select's tooltip — why "Weather at" is there at all (the board's words). */
export const WEATHER_AT_TIP =
  'This lake is large enough that its weather differs from bay to bay. Choose a bay to read its own sample point.';

// ── What it's been through ────────────────────────────────────────────────────────────────────

/** The days the sentences describe (board 1.6: "Last 10 days"). The chart reads further back. */
export const SENTENCE_DAYS = 10;

/** The "Last 10 days" tooltip (1.7). True because of {@link sentenceRows}. */
export const SENTENCE_DAYS_TIP = `The ${SENTENCE_DAYS} full days before today. Today is still in progress and is not counted.`;

/**
 * The rows the sentences are built from: the last `days` days **before today**, plus today's row
 * when the archive holds one. `buildPastWeatherPanel` leaves an unfinished today out of every
 * headline (`isCompleteDay`), so without the extra row "the last 10 days" would describe nine.
 * The test for today is the server's own `todayLocalDayMs` — never this machine's clock.
 */
export function sentenceRows(
  sorted: readonly PanelDay[],
  todayLocalDayMs: number,
  days: number = SENTENCE_DAYS,
): PanelDay[] {
  const last = sorted.at(-1);
  const hasToday = last != null && last.dayMs === todayLocalDayMs;
  return sorted.slice(-(hasToday ? days + 1 : days));
}

// ── The chart's furniture ─────────────────────────────────────────────────────────────────────

/** The temperature rules drawn behind the line, with their labels (board: 40°, 32°, 20°, 0°). */
export const TEMPERATURE_TICKS_F = [
  BAND_EDGE_THAW_F,
  BAND_EDGE_FREEZING_F,
  BAND_EDGE_DEEP_COLD_F,
  0,
];

/**
 * Where a temperature rule sits in the lane — the same linear map `weatherTimelineModel` draws the
 * line with (pinned by a test against its own `freezeY`). `null` outside the lane's window.
 */
export function temperatureTickY(layer: TemperatureLayer, tempF: number): number | null {
  if (tempF < layer.minF || tempF > layer.maxF) return null;
  const span = layer.maxF - layer.minF;
  return layer.box.bottom - ((tempF - layer.minF) / span) * layer.box.height;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The month of a lake-local `YYYY-MM-DD` — read from the string, never through a `Date`. */
export function monthOf(localDate: string): string {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(localDate);
  return (m && MONTHS[Number(m[1]) - 1]) ?? '';
}

/** The day of the month of a lake-local `YYYY-MM-DD` ("16"), the chart's axis label. */
export function dayOfMonth(localDate: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(localDate);
  return m ? String(Number(m[1])) : localDate;
}

/** The axis' month line: one month, or the first and last ("December – January"). */
export function monthSpan(localDates: readonly string[]): string {
  const months = [...new Set(localDates.map(monthOf).filter(Boolean))];
  if (months.length <= 1) return months[0] ?? '';
  return `${months[0]} – ${months.at(-1)}`;
}

// ── What's coming: the cards' words ───────────────────────────────────────────────────────────

/**
 * One amount per hour card, snow first: an hour with both is a snow hour to a skater (the tie rule
 * `summarizeForecast` uses). Nothing when neither clears a tenth of an inch / a hundredth.
 * Moved verbatim from `ForecastPanel`'s `HourCard`.
 */
export function hourAmount(hour: ForecastPlanHour): { text: string; snow: boolean } | null {
  if (hour.snowfallIn >= 0.1) return { text: `${hour.snowfallIn}″`, snow: true };
  if (hour.rainIn >= 0.01) return { text: `${hour.rainIn}″`, snow: false };
  return null;
}

/** "NW 9" — where the wind comes from (a compass point), and how hard, mph. */
export function hourWind(hour: ForecastPlanHour): string {
  const from =
    typeof hour.windDirectionDeg === 'number'
      ? `${COMPASS_LABELS[windSectorOf(hour.windDirectionDeg)] ?? ''} `
      : '';
  return `${from}${hour.windMph}`;
}

/** The day card's totals — moved verbatim from `ForecastPanel`'s `DayCard`. */
export function dayTotals(day: ForecastPlanDay): string[] {
  const totals: string[] = [];
  if (day.snowfallIn >= 0.1) totals.push(`${day.snowfallIn}″ snow`);
  if (day.rainIn >= 0.01) totals.push(`${day.rainIn}″ rain`);
  totals.push(`wind ${day.maxWindMph} mph`);
  return totals;
}

/** The day card's short name — the weekday of its `dateLabel` ("Sat 16" → "Sat"). */
export function dayShortName(day: ForecastPlanDay): string {
  return day.dateLabel.split(' ')[0] ?? day.label;
}
