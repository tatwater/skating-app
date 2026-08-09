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
  reveal = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** N6c-2's reveal flag — states the absence instead of hiding the strip. */
  reveal?: boolean;
}) {
  const getForecast = useAction(api.weather.getForecastForBody);
  const [summary, setSummary] = useState<ForecastSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    getForecast({ waterBodyId })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        // Fail open and silently: a missing forecast is not an error a skater can act on, and the
        // next drawer-open retries because nothing was cached.
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId]);

  const line = formatForecastStrip(summary);
  if (!line && !reveal) return null;

  return (
    <div className="flex flex-col gap-1">
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
