import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type ForecastSummary, formatForecastStrip, revealPlaceholder } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';
import { Paragraph, Text, YStack } from 'tamagui';
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
        if (!cancelled) setState({ summary: null, forBody: waterBodyId, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId, subAreaId, pending]);

  const line = formatForecastStrip(state.summary);
  if (!line && !reveal) return null;

  return (
    <YStack opacity={state.loading ? 0.5 : 1} accessibilityState={{ busy: state.loading }}>
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
    </YStack>
  );
}
