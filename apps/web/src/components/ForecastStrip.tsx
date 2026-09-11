import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type ForecastSummary, formatForecastStrip, revealPlaceholder } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';

/**
 * The short forward forecast on a lake drawer (N6c B5b).
 *
 * Mirrors `WeatherStrip` deliberately — same fetch-on-mount shape, same attribution line, same
 * "render nothing when there is nothing to say" rule — because the two are one timeline read in
 * opposite directions: *what happened to this ice* then *what is coming for it*. Two components that
 * look different would make that read harder for no gain.
 *
 * **It renders below the weather-since strip and below any NWS alert**, and the ordering is a claim
 * about authority rather than layout: an official warning outranks an hourly forecast, and an
 * observation outranks a prediction.
 *
 * Keyed on the **body**, not on a report or hazard, because the question "will it be snowing when I
 * get there" is about the lake — and it is asked most on the lakes that have no reports at all.
 */
export function ForecastStrip({
  waterBodyId,
  subAreaId,
  pending = false,
  reveal = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** The bay this strip is about (N6h / open question 5) — the same one `PastWeatherPanel` reads. */
  subAreaId?: string | undefined;
  /** True while the caller has not resolved the bay yet; holds rather than fetching twice. */
  pending?: boolean;
  /** N6c-2's reveal flag — states the absence instead of hiding the strip. */
  reveal?: boolean;
}) {
  const getForecast = useAction(api.weather.getForecastForBody);
  // `forBody` and `loading` exist for one reason: a forecast is a claim about a *place*, and this
  // strip's place can change under it. The same rule as `PastWeatherPanel`: across a *bay* switch the
  // previous bay's forecast stays up — dimmed and marked busy, so it is visibly held rather than
  // silently attributed to the newly named bay — because blanking it moved the drawer's content out
  // from under the reader's scroll position. Across a *lake* switch it is dropped, since a stale
  // forecast there would describe another lake under this one's name.
  const [state, setState] = useState<{
    summary: ForecastSummary | null;
    forBody: string | null;
    loading: boolean;
  }>({ summary: null, forBody: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) =>
      s.forBody === waterBodyId
        ? { ...s, loading: true }
        : { summary: null, forBody: waterBodyId, loading: true },
    );
    if (pending) return;
    getForecast({
      waterBodyId,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
    })
      .then((s) => {
        if (!cancelled) setState({ summary: s, forBody: waterBodyId, loading: false });
      })
      .catch(() => {
        // Fail open and silently: a missing forecast is not an error a skater can act on, and the
        // next drawer-open retries because nothing was cached.
        if (!cancelled) setState({ summary: null, forBody: waterBodyId, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId, subAreaId, pending]);

  const line = formatForecastStrip(state.summary);
  if (!line && !reveal) return null;

  return (
    <div
      className={`flex flex-col gap-1 transition-opacity ${state.loading ? 'opacity-50' : ''}`}
      aria-busy={state.loading}
    >
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        What's coming
      </h3>
      {line ? (
        <p className="text-foreground text-sm">{line}</p>
      ) : (
        <p className="text-foreground-muted text-sm italic">{revealPlaceholder('forecast')}</p>
      )}
      <p className="text-foreground-muted text-xs">Forecast: Open-Meteo</p>
    </div>
  );
}
