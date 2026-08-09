import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type ForecastSummary, formatForecastStrip } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';
import { Paragraph, Text } from 'tamagui';
import { Section } from './detailUi';

/**
 * The short forward forecast on a lake sheet (N6c B5b) — the mobile half of the web `ForecastStrip`.
 *
 * Mirrors `WeatherStrip` on purpose: the two are one timeline read in opposite directions, *what
 * happened to this ice* then *what is coming for it*, and rendering them differently would make that
 * read harder for no gain. Same fetch-on-mount shape, same attribution, same render-nothing rule.
 *
 * D3 holds at the copy: the line names weather and a clock, never the ice.
 */
export function ForecastStrip({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const getForecast = useAction(api.weather.getForecastForBody);
  const [summary, setSummary] = useState<ForecastSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    getForecast({ waterBodyId })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId]);

  const line = formatForecastStrip(summary);
  if (!line) return null;

  return (
    <Section label="What's coming">
      <Paragraph color="$foreground" fontSize={14}>
        {line}
      </Paragraph>
      <Text color="$foregroundMuted" fontSize={11}>
        Forecast: Open-Meteo
      </Text>
    </Section>
  );
}
