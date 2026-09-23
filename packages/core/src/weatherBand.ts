/**
 * The weather band under the timeline (A10-6, founder call 2026-09-23): one card per archived hour
 * the skate touched — the same lockup as the drawer's hourly forecast (symbol, temperature, amount,
 * wind) — and one line for what the weather *did* over the skate: first-to-last temperature, the
 * wind's range and where it blew from, and any change in the sky with the hour it changed.
 *
 * The archive is hourly (Open-Meteo's hourly variables), so a skate touches one to a handful of
 * cards; the summary is ranges and changes, never a mean, because a skater remembers "it got windy".
 * Nothing here is a safety claim (D3 / D150): it is what the weather did, never what the ice is.
 */

import {
  CONDITION_LABEL,
  conditionGlyph,
  type ForecastCondition,
  type ForecastGlyph,
} from './forecastPlan';
import type { SunTimes } from './solar';
import { cmToInches, cToF, kphToMph, roundTo } from './units';
import { windDirToCompass } from './weatherConditions';
import { precipitationKind } from './weatherTimeline';
import type { WindowHour } from './weatherWindow';

export interface WeatherBandCell {
  startMs: number;
  /** "2 PM" */
  label: string;
  condition: ForecastCondition;
  glyph: ForecastGlyph;
  /** The condition as a word, for the symbol's accessible name. */
  conditionLabel: string;
  temperatureF: number;
  windMph?: number;
  windFrom?: string;
  /** Snow first, then rain, in inches — empty when neither clears a tenth / a hundredth. */
  amount?: string;
}

const PRECIP_LABEL_CONDITION: Record<string, ForecastCondition> = {
  Snow: 'snow',
  'Rain and snow': 'sleet',
  Sleet: 'sleet',
  'Freezing rain': 'freezing-rain',
  Rain: 'rain',
  Drizzle: 'drizzle',
  Thunder: 'thunder',
};

/**
 * An archived hour's condition: the precipitation rule the timeline already draws, else clear.
 * The archive carries no cloud cover, so a dry hour is drawn clear — the sentence beside it is
 * what says more.
 */
export function archivedHourCondition(hour: WindowHour): ForecastCondition {
  const precip = precipitationKind(hour);
  if (precip) return PRECIP_LABEL_CONDITION[precip.label] ?? 'rain';
  return 'clear';
}

function isNight(ms: number, sun: SunTimes | null | undefined): boolean {
  if (!sun) return false;
  return ms < sun.sunriseMs || ms >= sun.sunsetMs;
}

export function weatherCells(
  hours: readonly WindowHour[],
  timeZone: string,
  sun?: SunTimes | null,
): WeatherBandCell[] {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric' });
  return hours.map((hour) => {
    const condition = archivedHourCondition(hour);
    const snowIn = roundTo(cmToInches(hour.snowfallCm ?? 0), 1);
    const rainIn = roundTo((hour.rainMm ?? 0) / 25.4, 2);
    const amount = snowIn >= 0.1 ? `${snowIn}″` : rainIn >= 0.01 ? `${rainIn}″` : undefined;
    const windMph =
      hour.windSpeedKph === undefined ? undefined : roundTo(kphToMph(hour.windSpeedKph), 0);
    return {
      startMs: hour.startMs,
      label: fmt.format(hour.startMs).toUpperCase(),
      condition,
      glyph: conditionGlyph(condition, isNight(hour.startMs, sun)),
      conditionLabel: CONDITION_LABEL[condition],
      temperatureF: roundTo(cToF(hour.temperatureC), 0),
      ...(windMph !== undefined ? { windMph } : {}),
      ...(hour.windDirectionDeg !== undefined
        ? { windFrom: windDirToCompass(hour.windDirectionDeg) }
        : {}),
      ...(amount !== undefined ? { amount } : {}),
    };
  });
}

export interface WeatherRunSummary {
  /** "19→18 °F" (or "18 °F" when it held). */
  temperature: string;
  /** "wind NW 8→14 mph" — absent when no hour carries wind. */
  wind?: string;
  /** "clear" / "clear, snow after 4 PM" / "snow, then clear after 3 PM". */
  sky: string;
}

/** What the weather did over the cards, first to last. `null` for no cards. */
export function weatherRunSummary(cells: readonly WeatherBandCell[]): WeatherRunSummary | null {
  if (cells.length === 0) return null;
  const first = cells[0] as WeatherBandCell;
  const last = cells[cells.length - 1] as WeatherBandCell;
  const temperature =
    first.temperatureF === last.temperatureF
      ? `${first.temperatureF} °F`
      : `${first.temperatureF}→${last.temperatureF} °F`;

  const winds = cells.filter((c) => c.windMph !== undefined);
  let wind: string | undefined;
  if (winds.length > 0) {
    const speeds = winds.map((c) => c.windMph as number);
    const lo = Math.min(...speeds);
    const hi = Math.max(...speeds);
    const from = dominantFrom(winds);
    const range = lo === hi ? `${hi} mph` : `${lo}→${hi} mph`;
    wind = `wind ${from ? `${from} ` : ''}${range}`;
  }

  const skyWords: string[] = [];
  let current = first.conditionLabel.toLowerCase();
  skyWords.push(current);
  for (const cell of cells.slice(1)) {
    const word = cell.conditionLabel.toLowerCase();
    if (word === current) continue;
    skyWords.push(`${word} after ${cell.label.toLowerCase().replace(/^0/, '')}`);
    current = word;
  }
  return { temperature, ...(wind !== undefined ? { wind } : {}), sky: skyWords.join(', ') };
}

function dominantFrom(cells: readonly WeatherBandCell[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of cells) {
    if (c.windFrom === undefined) continue;
    counts.set(c.windFrom, (counts.get(c.windFrom) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [from, count] of counts) {
    if (count > n) {
      best = from;
      n = count;
    }
  }
  return best;
}
