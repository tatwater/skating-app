import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  buildPastWeatherPanel,
  type ColdChain,
  dayMsToLocalDate,
  type PanelDay,
  shortDayLabel,
  type TimelineDayInput,
  timelineDaysFromArchive,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { Paragraph, Text, XStack, YStack } from 'tamagui';
import { Section } from './detailUi';
import { WeatherTimeline } from './WeatherTimeline';

/** Days the timeline can be dragged back through — the web panel's `TIMELINE_DAYS`, same reasoning. */
const TIMELINE_DAYS = 30;

/**
 * What the ice has been through — the mobile half of the web `PastWeatherPanel` (N6h / **D153**).
 *
 * ## It draws the same chart as the web app, and did not need a charting library to
 *
 * This panel was text-first through Workstream C, on the reasoning that `apps/mobile` had no charting
 * library and Phase 7b's Recharts kit is web-and-admin-only. Workstream D showed that framing was
 * wrong: the missing thing was never a *library*, it was shared **geometry**. `weatherTimelineModel`
 * in core returns coordinates and semantic band names, `react-native-svg` was already a dependency
 * (`WindExposure` had been drawing a wind rose with it since N7-3), and the native chart is the same
 * numbers through different primitives. No new dependency, no EAS rebuild.
 *
 * The sentences still come from `buildPastWeatherPanel` in core, for the reason they always did:
 * mobile has no RN-under-Vitest harness, so anything living in a component here cannot be tested at
 * all. That is also why this file holds no arithmetic.
 *
 * Same three rules as the web half: observation never counsel (D3 / D150), a gap is drawn rather than
 * smoothed, and it never renders above `AlertStrip`.
 */
type PanelState = {
  days: PanelDay[];
  timeline: TimelineDayInput[];
  fetchProfileM?: number[] | undefined;
  coarse: boolean;
  largeBody: boolean;
  todayLocalDayMs: number;
  /** The served cold chain (D164) — over `DIGEST_WINDOW_DAYS`, wider than the sentences. */
  chain: ColdChain | undefined;
  loading: boolean;
  /** The lake the held data belongs to, so a bay switch can keep it and a lake switch cannot. */
  forBody: string | null;
};

/** Nothing held: a first mount, a new lake, a refused read, or a failed one. */
function emptyPanel(forBody: string | null, loading: boolean): PanelState {
  return {
    days: [],
    timeline: [],
    coarse: false,
    largeBody: false,
    todayLocalDayMs: 0,
    chain: undefined,
    loading,
    forBody,
  };
}

export function PastWeatherPanel({
  waterBodyId,
  subAreaId,
  pending = false,
  days = 7,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** The bay this panel is about (N6h / open question 5), resolved by the caller. Absent on the lake itself. */
  subAreaId?: string | undefined;
  /**
   * True while the caller does not yet know which bay this is about. Load-bearing: the panel holds
   * instead of fetching the lake's cell and then the bay's — two calls for one open on a giant.
   */
  pending?: boolean;
  /** The window the *sentences* describe. The timeline always reads {@link TIMELINE_DAYS}. */
  days?: number;
}) {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [state, setState] = useState<PanelState>(emptyPanel(null, true));

  useEffect(() => {
    let cancelled = false;
    // ⚠ Keep the held data across a *bay* switch; drop it across a *lake* switch. Blanking the
    // panel to its one-line "Reading…" state while a bay loads removed ~400 px from under the
    // reader's scroll position, the scroll view clamped upward, and when the timeline came back they
    // were looking at the buttons at the top of the drawer. A bay switch is a refinement of the same
    // page, so the old reading stays up, dimmed, until the new one replaces it — nothing under the
    // finger moves. A different lake is a different page, and a stale panel there would lie.
    setState((s) =>
      s.forBody === waterBodyId ? { ...s, loading: true } : emptyPanel(waterBodyId, true),
    );
    if (pending) return;
    getDays({
      waterBodyId,
      days: TIMELINE_DAYS,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState(emptyPanel(waterBodyId, false));
          return;
        }
        // Core owns the `dayMs` encoding (UTC midnight of a *local* date); reversing it by hand in
        // each client is two chances to get it slightly differently wrong.
        const holes: PanelDay[] = result.missingDayMs.map((dayMs) => ({
          dayMs,
          localDate: dayMsToLocalDate(dayMs),
        }));
        // The sentences describe `days` days; the chart pans across all thirty. Feeding the whole
        // range to the panel builder would restate every headline over a month without any copy
        // showing that the window had moved.
        const all = [...(result.days as PanelDay[]), ...holes].sort(
          (a, b) => (a?.dayMs ?? 0) - (b?.dayMs ?? 0),
        );
        setState({
          days: all.slice(-days),
          timeline: timelineDaysFromArchive(result),
          todayLocalDayMs: result.todayLocalDayMs,
          fetchProfileM: result.fetchProfileM,
          coarse: result.anyBorrowed,
          largeBody: result.oneSampleForALargeBody,
          // The chain over a wider window than the sentences (D164), so a three-week-old chain
          // does not read "7+ nights" for the rest of the winter.
          chain: result.chain,
          loading: false,
          forBody: waterBodyId,
        });
      })
      .catch(() => {
        if (!cancelled) setState(emptyPanel(waterBodyId, false));
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, subAreaId, pending, days]);

  const panel = useMemo(
    // ⚠ The lake's today, from the server — never `Date.now()` here. Today's row arrives holding 24
    // hours with the un-elapsed ones forecast, so without this the headline states tonight's
    // predicted low as an observed one, and a reader in another timezone gets a different answer
    // again. See `isCompleteDay` in core.
    () =>
      buildPastWeatherPanel(state.days, {
        coarse: state.coarse,
        todayLocalDayMs: state.todayLocalDayMs,
        ...(state.chain ? { chain: state.chain } : {}),
      }),
    [state.days, state.coarse, state.todayLocalDayMs, state.chain],
  );

  // Nothing held yet — a first open, or a new lake. A bay switch keeps the previous reading up.
  if (state.loading && state.days.length === 0) {
    return (
      <Section label="What it's been through">
        <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
          Reading the last {days} days…
        </Paragraph>
      </Section>
    );
  }

  if (panel.rows.length === 0) return null;

  // At least one day with real hours. A cell can legitimately hold thirty daily summaries and no
  // hourly rows — every lake opened before N6h Workstream D is in that state until its next visit.
  const hasHourly = state.timeline.some((d) => (d.hours?.length ?? 0) > 0);

  return (
    // Dimmed while a bay's reading is on its way: the previous bay's stays up so the layout holds.
    <YStack opacity={state.loading ? 0.5 : 1} accessibilityState={{ busy: state.loading }}>
      <Section label="What it's been through">
        {panel.headline.map((line) => (
          <Paragraph color="$foreground" fontSize={14} key={line}>
            {line}
          </Paragraph>
        ))}

        {/* The timeline when the archive has hours for this cell; the per-day columns otherwise.
          **The columns are the fallback, not dead code** — a cell whose daily rows predate the hourly
          table serves no hours until its next drawer-open. A dash rather than a zero for a day we
          could not get, which is the whole point of carrying `missing` through from the archive. */}
        {hasHourly ? (
          <YStack marginTop="$2">
            {/* No window prop since the 2026-09-04 scale change — the container decides how many days
              fit at 2px/hour, and `days` still scopes only the sentences above. */}
            <WeatherTimeline days={state.timeline} fetchProfileM={state.fetchProfileM} />
          </YStack>
        ) : (
          <XStack gap="$2" marginTop="$2">
            {panel.rows.map((row) => (
              // A partial day (today, so far) is drawn at reduced opacity rather than hidden: what is
              // happening right now is exactly what a skater wants to see, but it must not read as a
              // settled high and low. The headline leaves it out of every integral.
              <YStack
                alignItems="center"
                flex={1}
                gap="$1"
                key={row.dayMs}
                opacity={row.partial ? 0.5 : 1}
              >
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
        )}

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
    </YStack>
  );
}
