import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatWeatherSinceStrip, type WeatherSinceSummary } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';

/**
 * The weather-since strip (Phase 10 / §3 / D19). Fetches on mount via the `getWeatherSinceForBody`
 * **action** (a query can't fetch Open-Meteo — see the module note in `convex/weather.ts`) and renders a
 * **plain-text, verdict-free** line (D3). Descriptive only; never a safety claim. Attribution required
 * (legal L13). Renders nothing until there's something to say — a fresh window has no weather-since.
 *
 * The parent picks the window mode: a **report** passes the skate time (`startMs`, a fixed instant, gated
 * by `reportStripState`); a **hazard** passes `sinceLastConfirmedAt` and the action derives the rolling
 * recent window server-side (one clock, matching the decay — §3). `caveat` carries "possibly snow-hidden".
 */
export type WeatherStripProps = {
  label?: string;
  caveat?: string;
} & ({ reportId: string } | { hazardId: string });

export function WeatherStrip(props: WeatherStripProps) {
  const { label = 'Weather since', caveat } = props;
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);
  // The window (body, sample point, start) is derived server-side from the entity id — the client never
  // supplies a raw timestamp, so it can't amplify weather fetches/cache keys (§3 resource guard).
  const reportId = 'reportId' in props ? props.reportId : undefined;
  const hazardId = 'hazardId' in props ? props.hazardId : undefined;

  useEffect(() => {
    let cancelled = false;
    getWeather({
      ...(reportId !== undefined ? { reportId: reportId as Id<'reports'> } : {}),
      ...(hazardId !== undefined ? { hazardId: hazardId as Id<'hazards'> } : {}),
    })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getWeather, reportId, hazardId]);

  const line = summary ? formatWeatherSinceStrip(summary) : null;
  if (!line && !caveat) return null;

  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">{label}</h3>
      {line ? <p className="text-foreground text-sm">{line}</p> : null}
      {caveat ? <p className="text-foreground-muted text-sm">{caveat}</p> : null}
      <p className="text-foreground-muted text-xs">Weather: Open-Meteo</p>
    </div>
  );
}
