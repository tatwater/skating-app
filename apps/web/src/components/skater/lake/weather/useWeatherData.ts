import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  buildForecastPlan,
  buildPastWeatherPanel,
  type ColdChain,
  dayMsToLocalDate,
  type ForecastPayload,
  type ForecastPlan,
  formatForecastStrip,
  type PanelDay,
  type PastWeatherPanel,
  summarizeForecast,
  type TimelineDayInput,
  timelineDaysFromArchive,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { SENTENCE_DAYS, sentenceRows } from './weatherModel';

/**
 * The Weather tab's two actions, as hooks. **Moved from the shipped `PastWeatherPanel` and
 * `ForecastPanel`, logic unchanged** — the fetch, the hold-across-a-bay-switch rule, and every
 * derivation, which all live in `@skating/core`. The only change is the sentence window
 * ({@link sentenceRows}). Neither hook does time arithmetic of its own: the archive's
 * `todayLocalDayMs` and the forecast's `utcOffsetMs` are the server's, and the hours are read on
 * the lake's clock by core (`startMs` is local-shifted; a local formatter would apply it twice).
 */

/**
 * Days the timeline can be dragged back through. Wider than the sentences' window deliberately, and
 * it costs one request either way: the archive's first touch already pulls the 92-day ceiling, so
 * this changes what is *read*, not what is fetched.
 */
export const TIMELINE_DAYS = 30;

export interface PastWeatherState {
  days: PanelDay[];
  timeline: TimelineDayInput[];
  fetchProfileM?: number[] | undefined;
  coarse: boolean;
  largeBody: boolean;
  todayLocalDayMs: number;
  /** The served cold chain (D164) — over a wider window than the sentences. */
  chain: ColdChain | undefined;
  loading: boolean;
  /** The lake the held data belongs to, so a bay switch can keep it and a lake switch cannot. */
  forBody: string | null;
}

/** Nothing held: a first mount, a new lake, a refused read, or a failed one. */
function emptyPast(forBody: string | null, loading: boolean): PastWeatherState {
  return {
    days: [],
    timeline: [],
    coarse: false,
    largeBody: false,
    todayLocalDayMs: 0,
    chain: undefined,
    loading,
    forBody,
  };
}

/** What it's been through: the archive's days, the sentences over them, the chart's hours. */
export function usePastWeather(
  waterBodyId: string,
  subAreaId: string | undefined,
  days: number = SENTENCE_DAYS,
): { state: PastWeatherState; panel: PastWeatherPanel } {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [state, setState] = useState<PastWeatherState>(emptyPast(null, true));

  useEffect(() => {
    let canceled = false;
    // ⚠ Keep the held data across a *bay* switch; drop it across a *lake* switch. A bay switch is a
    // refinement of the same page, so the old reading stays up, dimmed, until the new one replaces
    // it — nothing under the reader's scroll position moves. A different lake is a different page,
    // and a stale panel there would lie.
    setState((s) =>
      s.forBody === waterBodyId ? { ...s, loading: true } : emptyPast(waterBodyId, true),
    );
    getDays({
      waterBodyId: waterBodyId as Id<'waterBodies'>,
      days: TIMELINE_DAYS,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
    })
      .then((result) => {
        if (canceled) return;
        if (!result) {
          setState(emptyPast(waterBodyId, false));
          return;
        }
        // A recorded gap and a day that produced no row at all are both holes to a reader, so they
        // arrive as one list. `dayMsToLocalDate` owns the encoding (UTC midnight of a *local* date).
        const holes: PanelDay[] = result.missingDayMs.map((dayMs) => ({
          dayMs,
          localDate: dayMsToLocalDate(dayMs),
        }));
        // ⚠ The sentences get the last `days` days; the chart gets all thirty. Feeding the whole
        // range to `buildPastWeatherPanel` would silently restate every headline over a month.
        const all = [...(result.days as PanelDay[]), ...holes].sort(
          (a, b) => (a?.dayMs ?? 0) - (b?.dayMs ?? 0),
        );
        setState({
          days: sentenceRows(all, result.todayLocalDayMs, days),
          timeline: timelineDaysFromArchive(result),
          todayLocalDayMs: result.todayLocalDayMs,
          fetchProfileM: result.fetchProfileM,
          coarse: result.anyBorrowed,
          largeBody: result.oneSampleForALargeBody,
          chain: result.chain,
          loading: false,
          forBody: waterBodyId,
        });
      })
      .catch(() => {
        // Fail open and quiet, like every other weather surface: nothing cached means the next
        // open retries, and a missing history is not an error a skater can act on.
        if (!canceled) setState(emptyPast(waterBodyId, false));
      });
    return () => {
      canceled = true;
    };
  }, [getDays, waterBodyId, subAreaId, days]);

  // ⚠ The lake's today, from the server — never `Date.now()` here. Today's row arrives holding 24
  // hours with the un-elapsed ones forecast, so without it the headline would state tonight's
  // predicted low as an observed one.
  const panel = useMemo(
    () =>
      buildPastWeatherPanel(state.days, {
        coarse: state.coarse,
        todayLocalDayMs: state.todayLocalDayMs,
        ...(state.chain ? { chain: state.chain } : {}),
      }),
    [state.days, state.coarse, state.todayLocalDayMs, state.chain],
  );
  return { state, panel };
}

export interface ForecastState {
  payload: ForecastPayload | null;
  forBody: string | null;
  loading: boolean;
}

/** The strip's line and the planner, derived from one payload (or `null` while there is none). */
export interface ForecastDerived {
  line: string | null;
  plan: ForecastPlan;
}

/**
 * `now` on the lake's clock, then both derivations. The hours' timestamps are local-shifted, so
 * the client's own clock is shifted the same way — never the reverse. Moved verbatim from
 * `ForecastPanel`; `now` is a parameter so a test can hold it.
 */
export function deriveForecast(payload: ForecastPayload, nowMs: number): ForecastDerived {
  const nowLocalMs = nowMs + payload.utcOffsetMs;
  return {
    line: formatForecastStrip(summarizeForecast(payload.hours, nowLocalMs)),
    plan: buildForecastPlan(payload.hours, nowLocalMs, {
      arrivalBandMinutes: payload.arrivalBandMinutes,
    }),
  };
}

/** What's coming: the forecast action for the lake or its bay. */
export function useForecast(
  waterBodyId: string,
  subAreaId: string | undefined,
): { state: ForecastState; derived: ForecastDerived | null } {
  const getForecast = useAction(api.weather.getForecastForBody);
  // A forecast is a claim about a *place*: across a bay switch the previous one stays up, dimmed
  // and marked busy; across a lake switch it is dropped (a stale forecast would describe another
  // lake under this one's name).
  const [state, setState] = useState<ForecastState>({
    payload: null,
    forBody: null,
    loading: true,
  });

  useEffect(() => {
    let canceled = false;
    setState((s) =>
      s.forBody === waterBodyId
        ? { ...s, loading: true }
        : { payload: null, forBody: waterBodyId, loading: true },
    );
    getForecast({
      waterBodyId: waterBodyId as Id<'waterBodies'>,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
    })
      .then((p) => {
        if (!canceled) setState({ payload: p, forBody: waterBodyId, loading: false });
      })
      .catch(() => {
        // Fail open and silently: a missing forecast is not an error a skater can act on.
        if (!canceled) setState({ payload: null, forBody: waterBodyId, loading: false });
      });
    return () => {
      canceled = true;
    };
  }, [getForecast, waterBodyId, subAreaId]);

  const derived = useMemo(
    () => (state.payload ? deriveForecast(state.payload, Date.now()) : null),
    [state.payload],
  );
  return { state, derived };
}
