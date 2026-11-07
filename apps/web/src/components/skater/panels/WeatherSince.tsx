import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatWeatherSinceStrip, type WeatherSinceSummary } from '@skating/core';
import { useAction } from 'convex/react';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * The weather since a report, or around a hazard (Phase 10 / D19; boards 2.1, 2.4): a ruled box with
 * its kicker, when it runs from, one plain line, and the source. Descriptive only — it never says
 * what the weather did to the ice (D3). The attribution is required (L13).
 */
export function WeatherSinceView({
  label,
  since,
  line,
  caveat,
}: {
  label: string;
  /** "Since 11:40 AM", on the kicker's line. */
  since?: ReactNode;
  line: string | null;
  /** "Possibly snow-hidden." */
  caveat?: string;
}) {
  if (line === null && caveat === undefined) return null;
  return (
    <section
      data-slot="weather-since"
      className="flex flex-col gap-(--space-2) border border-solid border-line px-(--space-3_5) py-(--space-3)"
    >
      <div className="flex items-baseline gap-(--space-2)">
        <h3 className="m-0 text-[0.625rem] leading-none font-medium tracking-head text-fg3 uppercase">
          {label}
        </h3>
        {since !== undefined && (
          <span className="ml-auto font-(family-name:--family-mono) text-mono-sm text-fg2">
            {since}
          </span>
        )}
      </div>
      {line !== null && <p className="m-0 text-assist text-fg1">{line}</p>}
      {caveat !== undefined && <p className="m-0 text-assist text-fg2 italic">{caveat}</p>}
      <p className="m-0 text-[0.6875rem] text-fg3">Weather: Open-Meteo</p>
    </section>
  );
}

/**
 * The live strip: `weather.getWeatherSinceForBody` is an action (a query can't reach Open-Meteo), so
 * it runs once on mount. The server derives the window from the id; the client sends no time.
 */
export function WeatherSince(
  props: { label: string; since?: ReactNode; caveat?: string } & (
    | { reportId: string }
    | { hazardId: string }
  ),
) {
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);
  const reportId = 'reportId' in props ? props.reportId : undefined;
  const hazardId = 'hazardId' in props ? props.hazardId : undefined;

  useEffect(() => {
    let live = true;
    getWeather({
      ...(reportId !== undefined ? { reportId: reportId as Id<'reports'> } : {}),
      ...(hazardId !== undefined ? { hazardId: hazardId as Id<'hazards'> } : {}),
    })
      .then((s) => {
        if (live) setSummary(s);
      })
      .catch(() => {
        if (live) setSummary(null);
      });
    return () => {
      live = false;
    };
  }, [getWeather, reportId, hazardId]);

  return (
    <WeatherSinceView
      label={props.label}
      since={props.since}
      line={summary ? formatWeatherSinceStrip(summary) : null}
      {...(props.caveat !== undefined ? { caveat: props.caveat } : {})}
    />
  );
}
