import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatWeatherSinceStrip, type WeatherSinceSummary } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';
import { Paragraph, Text } from 'tamagui';
import { Section } from './detailUi';

/**
 * The weather-since strip (Phase 10 / §3 / D19). Fetches on mount via the `getWeatherSinceForBody`
 * **action** (a query can't fetch Open-Meteo) and renders a **plain-text, verdict-free** line (D3) —
 * descriptive only, never a safety claim, Open-Meteo-attributed (legal L13). The parent picks the window
 * mode: a **report** passes the skate time (`startMs`, a fixed instant, gated by `reportStripState`); a
 * **hazard** passes `sinceLastConfirmedAt` and the action derives the rolling recent window server-side
 * (one clock, matching the decay — §3). `caveat` carries a hazard's "possibly snow-hidden".
 */
export type WeatherStripProps = {
  waterBodyId: string;
  label?: string;
  caveat?: string;
  /** The hazard/report location, so the strip samples the same point the decay does (§5). */
  near?: { lat: number; lng: number };
} & ({ startMs: number } | { sinceLastConfirmedAt: number });

export function WeatherStrip(props: WeatherStripProps) {
  const { waterBodyId, label = 'Weather since', caveat, near } = props;
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);
  const nearLat = near?.lat;
  const nearLng = near?.lng;
  const startMs = 'startMs' in props ? props.startMs : undefined;
  const sinceLastConfirmedAt =
    'sinceLastConfirmedAt' in props ? props.sinceLastConfirmedAt : undefined;

  useEffect(() => {
    let cancelled = false;
    getWeather({
      waterBodyId: waterBodyId as Id<'waterBodies'>,
      ...(startMs !== undefined ? { startMs } : {}),
      ...(sinceLastConfirmedAt !== undefined ? { sinceLastConfirmedAt } : {}),
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
  }, [getWeather, waterBodyId, startMs, sinceLastConfirmedAt, nearLat, nearLng]);

  const line = summary ? formatWeatherSinceStrip(summary) : null;
  if (!line && !caveat) return null;

  return (
    <Section label={label}>
      {line ? (
        <Paragraph color="$foreground" fontSize={14}>
          {line}
        </Paragraph>
      ) : null}
      {caveat ? (
        <Paragraph color="$foregroundMuted" fontSize={14}>
          {caveat}
        </Paragraph>
      ) : null}
      <Text color="$foregroundMuted" fontSize={11}>
        Weather: Open-Meteo
      </Text>
    </Section>
  );
}
