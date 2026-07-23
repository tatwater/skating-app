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
 * descriptive only, never a safety claim, Open-Meteo-attributed (legal L13). The parent identifies the
 * entity by **id** — `reportId` for a report strip, `hazardId` for a hazard strip — and the action derives
 * the body, sample point and window start from it server-side (one clock, matching the decay — §3; and a
 * resource guard, §3: the client can't supply a raw window to amplify fetches). `caveat` carries a hazard's
 * "possibly snow-hidden".
 */
export type WeatherStripProps = {
  label?: string;
  caveat?: string;
} & ({ reportId: string } | { hazardId: string });

export function WeatherStrip(props: WeatherStripProps) {
  const { label = 'Weather since', caveat } = props;
  const getWeather = useAction(api.weather.getWeatherSinceForBody);
  const [summary, setSummary] = useState<WeatherSinceSummary | null>(null);
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
