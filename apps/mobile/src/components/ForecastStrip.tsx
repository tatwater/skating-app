import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type ForecastSummary, formatForecastStrip, revealPlaceholder } from '@skating/core';
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
  const [summary, setSummary] = useState<ForecastSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (pending) return;
    getForecast({
      waterBodyId,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
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
  }, [getForecast, waterBodyId, subAreaId, pending]);

  const line = formatForecastStrip(summary);
  if (!line && !reveal) return null;

  return (
    <Section label="What's coming">
      {line ? (
        <Paragraph color="$foreground" fontSize={14}>
          {line}
        </Paragraph>
      ) : (
        <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
          {revealPlaceholder('forecast')}
        </Paragraph>
      )}
      <Text color="$foregroundMuted" fontSize={11}>
        Forecast: Open-Meteo
      </Text>
    </Section>
  );
}
