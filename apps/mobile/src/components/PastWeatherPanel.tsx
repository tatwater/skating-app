import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  buildPastWeatherPanel,
  dayMsToLocalDate,
  type PanelDay,
  shortDayLabel,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { Paragraph, Text, XStack, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * What the ice has been through — the mobile half of the web `PastWeatherPanel` (N6h / **D153**).
 *
 * ## Text-first on purpose, not as a shortcut
 *
 * As of N6h `apps/mobile` has **no charting library at all** — Phase 7b's dataviz-validated Recharts
 * kit is web-and-admin-only. Rather than add a charting dependency for one panel, this renders the
 * same sentences the web panel leads with plus a compact per-day row, and the *reasoning* lives in
 * `buildPastWeatherPanel` in core where both platforms read it from one tested place.
 *
 * That split also matters for a second reason: mobile has no RN-under-Vitest harness, so logic that
 * lives in a component here cannot be tested at all. Keeping it in core is what makes this panel
 * covered rather than hoped-for.
 *
 * Same three rules as the web half: observation never counsel (D3 / D150), a gap is drawn rather than
 * smoothed, and it never renders above `AlertStrip`.
 */
export function PastWeatherPanel({
  waterBodyId,
  days = 7,
}: {
  waterBodyId: Id<'waterBodies'>;
  days?: number;
}) {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [state, setState] = useState<{
    days: PanelDay[];
    coarse: boolean;
    largeBody: boolean;
    loading: boolean;
  }>({ days: [], coarse: false, largeBody: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    getDays({ waterBodyId, days })
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ days: [], coarse: false, largeBody: false, loading: false });
          return;
        }
        // Core owns the `dayMs` encoding (UTC midnight of a *local* date); reversing it by hand in
        // each client is two chances to get it slightly differently wrong.
        const holes: PanelDay[] = result.missingDayMs.map((dayMs) => ({
          dayMs,
          localDate: dayMsToLocalDate(dayMs),
        }));
        setState({
          days: [...(result.days as PanelDay[]), ...holes],
          coarse: result.anyBorrowed,
          largeBody: result.oneSampleForALargeBody,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ days: [], coarse: false, largeBody: false, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, days]);

  const panel = useMemo(
    () => buildPastWeatherPanel(state.days, { coarse: state.coarse }),
    [state.days, state.coarse],
  );

  if (state.loading) {
    return (
      <Section label="What it's been through">
        <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
          Reading the last {days} days…
        </Paragraph>
      </Section>
    );
  }

  if (panel.rows.length === 0) return null;

  return (
    <Section label="What it's been through">
      {panel.headline.map((line) => (
        <Paragraph color="$foreground" fontSize={14} key={line}>
          {line}
        </Paragraph>
      ))}

      {/* One column per day. A dash rather than a zero for a day we could not get — the whole point
          of carrying `missing` through from the archive. */}
      <XStack gap="$2" marginTop="$2">
        {panel.rows.map((row) => (
          <YStack alignItems="center" flex={1} gap="$1" key={row.dayMs}>
            <Text color="$foregroundMuted" fontSize={10} textTransform="uppercase">
              {shortDayLabel(row.localDate)}
            </Text>
            <Text color="$foreground" fontSize={12}>
              {row.highF === null ? '—' : `${row.highF}°`}
            </Text>
            <Text color="$foregroundMuted" fontSize={12}>
              {row.lowF === null ? '—' : `${row.lowF}°`}
            </Text>
            {row.snowfallIn !== null && row.snowfallIn >= 0.1 ? (
              <Text color="$foregroundMuted" fontSize={10}>
                {row.snowfallIn}″
              </Text>
            ) : null}
          </YStack>
        ))}
      </XStack>

      {state.largeBody ? (
        <Text color="$foregroundMuted" fontSize={11} fontStyle="italic">
          This lake is large enough that weather differs across it — these readings are from one
          point near the middle.
        </Text>
      ) : null}
      {panel.coarse ? (
        <Text color="$foregroundMuted" fontSize={11} fontStyle="italic">
          Some days are from a wider area than usual.
        </Text>
      ) : null}
      <Text color="$foregroundMuted" fontSize={11}>
        Past weather: Open-Meteo
      </Text>
    </Section>
  );
}
