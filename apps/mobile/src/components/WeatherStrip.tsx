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
 * descriptive only, never a safety claim, Open-Meteo-attributed (legal L13). The parent picks the window:
 * reports pass the skate time (gated by `reportStripState`); hazards pass a rolling recent start. `caveat`
 * carries a hazard's "possibly snow-hidden".
 */
export function WeatherStrip({
  waterBodyId,
  startMs,
  label = 'Weather since',
  caveat,
}: {
  waterBodyId: string;
  startMs: number;
  label?: string;
  caveat?: string;
}) {
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWeather({ waterBodyId: waterBodyId as Id<'waterBodies'>, startMs })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getWeather, waterBodyId, startMs]);

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
