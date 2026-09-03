import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  buildPastWeatherPanel,
  dayMsToLocalDate,
  type PanelDay,
  shortDayLabel,
  type TimelineDayInput,
  timelineDaysFromArchive,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { WeatherTimeline } from './WeatherTimeline';

/**
 * What the ice has been through — the past-weather panel (N6h Workstream C / **D153**).
 *
 * **The differentiated half of the weather block, and the reason the phase exists.** Every general
 * weather app tells you the high and the low; none of them tells you what happened to *this lake*.
 * So this sits above `ForecastStrip` in the Planning group and reads backwards where that one reads
 * forwards.
 *
 * ## Three rules it inherits
 *
 * - **Observation, never counsel (D3 / D150).** Every sentence comes from
 *   `buildPastWeatherPanel` in core, tested there, and names weather rather than ice. The
 *   freezing-degree integrals never appear — publishing one is a division away from a thickness
 *   estimate, which D160 confines to an operator surface.
 * - **A gap is drawn, not smoothed.** A day the archive could not get renders as `—`, because five
 *   of seven days is not less snow, it is less knowledge.
 * - **Authority ordering (Phase 10 §5).** An NWS alert outranks an observation, which outranks a
 *   forecast. This component never renders above `AlertStrip`.
 */
/**
 * Days the timeline can be dragged back through.
 *
 * **Wider than the panel's sentence window, deliberately, and it costs one request either way.** The
 * archive's first touch already pulls the 92-day ceiling, so these thirty days are almost always
 * already stored; asking for them here changes what is *read*, not what is fetched. The headline
 * still describes seven days — see `SENTENCE_DAYS` — because "3 nights below 20°F" means something
 * quite different over a month, and the founder's call was a 7-day default that pans to 30.
 */
const TIMELINE_DAYS = 30;

export function PastWeatherPanel({
  waterBodyId,
  days = 7,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** The window the *sentences* describe. The timeline always reads {@link TIMELINE_DAYS}. */
  days?: number;
}) {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [state, setState] = useState<{
    days: PanelDay[];
    timeline: TimelineDayInput[];
    coarse: boolean;
    largeBody: boolean;
    loading: boolean;
  }>({ days: [], timeline: [], coarse: false, largeBody: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    getDays({ waterBodyId, days: TIMELINE_DAYS })
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ days: [], timeline: [], coarse: false, largeBody: false, loading: false });
          return;
        }
        // A recorded gap and a day that produced no row at all are both holes to a reader, so they
        // arrive as one list. The panel builder is what knows the difference matters upstream.
        // `dayMsToLocalDate` rather than a hand-rolled `toISOString().slice(0, 10)`: the encoding
        // (UTC midnight of a *local* date) is core's to own, and both clients drawing holes means
        // two chances to reverse it slightly differently.
        const holes: PanelDay[] = result.missingDayMs.map((dayMs) => ({
          dayMs,
          localDate: dayMsToLocalDate(dayMs),
        }));
        // ⚠ **The sentences get the last `days` days; the chart gets all thirty.** Feeding the whole
        // range to `buildPastWeatherPanel` would silently restate every headline over a month — "no
        // snow in the last 30 days" is a different and much rarer claim than the seven-day one, and
        // nothing in the copy would show that the window had changed.
        // `PanelDay` admits `null` (a hole the builder draws as a gap), so the sort has to survive
        // one rather than assume the list is dense.
        const all = [...(result.days as PanelDay[]), ...holes].sort(
          (a, b) => (a?.dayMs ?? 0) - (b?.dayMs ?? 0),
        );
        setState({
          days: all.slice(-days),
          timeline: timelineDaysFromArchive(result),
          coarse: result.anyBorrowed,
          largeBody: result.oneSampleForALargeBody,
          loading: false,
        });
      })
      .catch(() => {
        // Fail open and quiet, like every other weather surface: nothing cached means the next
        // drawer-open retries, and a missing history is not an error a skater can act on.
        if (!cancelled) {
          setState({ days: [], timeline: [], coarse: false, largeBody: false, loading: false });
        }
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
      <div className="flex flex-col gap-1">
        <PanelHeading />
        <p className="text-foreground-muted text-sm italic">Reading the last {days} days…</p>
      </div>
    );
  }

  if (panel.rows.length === 0) return null;

  const lowest = Math.min(
    ...panel.rows.map((r) => r.lowF).filter((v): v is number => v !== null),
    32,
  );
  const highest = Math.max(
    ...panel.rows.map((r) => r.highF).filter((v): v is number => v !== null),
    32,
  );

  // At least one day with real hours. A cell can legitimately have thirty daily summaries and no
  // hourly rows — every lake opened before N6h Workstream D is in that state until its next visit.
  const hasHourly = state.timeline.some((d) => (d.hours?.length ?? 0) > 0);

  return (
    <div className="flex flex-col gap-2">
      <PanelHeading />

      {panel.headline.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {panel.headline.map((line) => (
            <li className="text-foreground text-sm" key={line}>
              {line}
            </li>
          ))}
        </ul>
      )}

      {/* The timeline, when the archive has hours for this cell. **The columns below are the
          fallback, not dead code** — a cell whose daily rows predate the hourly table serves no hours
          until its next drawer-open, and on a slow connection that is the state a reader sees first.
          The strip is also the honest answer when a lake has summaries but no hourly history at all. */}
      {hasHourly ? (
        <WeatherTimeline days={state.timeline} windowDays={days} />
      ) : (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {panel.rows.map((row) => (
            <div className="flex min-w-11 flex-1 flex-col items-center gap-1" key={row.dayMs}>
              <span className="font-mono text-[10px] text-foreground-muted uppercase">
                {shortDayLabel(row.localDate)}
              </span>
              <TempBar
                highF={row.highF}
                lowF={row.lowF}
                rangeLowF={lowest}
                rangeHighF={highest}
                missing={row.missing}
                partial={row.partial}
              />
              <span className="text-[10px] text-foreground tabular-nums">
                {row.highF === null ? '—' : `${row.highF}°`}
              </span>
              <span className="text-[10px] text-foreground-muted tabular-nums">
                {row.lowF === null ? '—' : `${row.lowF}°`}
              </span>
              {row.snowfallIn !== null && row.snowfallIn >= 0.1 && (
                <span className="text-[10px] text-foreground-muted">{row.snowfallIn}″</span>
              )}
            </div>
          ))}
        </div>
      )}

      {state.largeBody && (
        // D151's grammar, one sensor over: say what WE measured, not what the lake did. This lake is
        // bigger than one reading can describe and nobody has placed a sample grid on it yet.
        <p className="text-foreground-muted text-xs italic">
          This lake is large enough that weather differs across it — these readings are from one
          point near the middle.
        </p>
      )}
      {panel.coarse && (
        <p className="text-foreground-muted text-xs italic">
          Some days are from a wider area than usual.
        </p>
      )}
      <p className="text-foreground-muted text-xs">Past weather: Open-Meteo</p>
    </div>
  );
}

function PanelHeading() {
  return (
    <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
      What it's been through
    </h3>
  );
}

/**
 * One day's high–low range as a vertical bar, with 32°F as the reference.
 *
 * The bar is positioned within the window's own min/max rather than a fixed scale, so a mild week
 * still shows shape. ⚠ The freezing line is drawn from the same scale, which is what makes "this bar
 * is entirely below the line" mean something.
 */
function TempBar({
  highF,
  lowF,
  rangeLowF,
  rangeHighF,
  missing,
  partial,
}: {
  highF: number | null;
  lowF: number | null;
  rangeLowF: number;
  rangeHighF: number;
  missing: boolean;
  /** Today, mid-afternoon: real data whose day has not finished. Drawn, but not drawn as settled. */
  partial: boolean;
}) {
  const span = Math.max(1, rangeHighF - rangeLowF);
  const pct = (v: number) => ((v - rangeLowF) / span) * 100;

  if (missing || highF === null || lowF === null) {
    return (
      <div
        className="relative h-16 w-2 rounded-full border border-border border-dashed"
        role="img"
        title="No weather recorded"
      />
    );
  }

  const freezePct = pct(32);
  const frozen = highF <= 32;

  return (
    <div
      className="relative h-16 w-2 rounded-full bg-background-subtle"
      {...(partial ? { title: 'Still in progress — today is not finished' } : {})}
    >
      <div
        className="absolute right-0 left-0 border-border border-t border-dashed"
        style={{ bottom: `${Math.min(100, Math.max(0, freezePct))}%` }}
      />
      <div
        // A partial day is drawn at reduced opacity: the reader can see what is happening now
        // without the bar claiming to be a settled high and low. The headline excludes it entirely.
        className={`absolute right-0 left-0 rounded-full ${frozen ? 'bg-accent' : 'bg-foreground-muted'}${partial ? ' opacity-50' : ''}`}
        style={{
          bottom: `${Math.max(0, pct(lowF))}%`,
          height: `${Math.max(4, pct(highF) - pct(lowF))}%`,
        }}
      />
    </div>
  );
}
