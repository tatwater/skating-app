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
 * The parent decides the window: reports pass the skate time (gated by `reportStripState`); hazards pass a
 * rolling recent start (`hazardStripWindowStartMs`). `caveat` carries a hazard's "possibly snow-hidden".
 */
export function WeatherStrip({
  waterBodyId,
  startMs,
  label = 'Weather since',
  caveat,
  near,
}: {
  waterBodyId: string;
  startMs: number;
  label?: string;
  caveat?: string;
  /** The hazard/report location, so the strip samples the same point the decay does (§5). */
  near?: { lat: number; lng: number };
}) {
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);
  const nearLat = near?.lat;
  const nearLng = near?.lng;

  useEffect(() => {
    let cancelled = false;
    getWeather({
      waterBodyId: waterBodyId as Id<'waterBodies'>,
      startMs,
      ...(nearLat !== undefined && nearLng !== undefined
        ? { near: { lat: nearLat, lng: nearLng } }
        : {}),
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
  }, [getWeather, waterBodyId, startMs, nearLat, nearLng]);

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
