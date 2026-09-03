import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { buildPastWeatherPanel, type PanelDay, shortDayLabel } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

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
    loading: boolean;
  }>({ days: [], coarse: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    getDays({ waterBodyId, days })
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ days: [], coarse: false, loading: false });
          return;
        }
        // A recorded gap and a day that produced no row at all are both holes to a reader, so they
        // arrive as one list. The panel builder is what knows the difference matters upstream.
        const holes: PanelDay[] = result.missingDayMs.map((dayMs) => ({
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
        }));
        setState({
          days: [...(result.days as PanelDay[]), ...holes],
          coarse: result.anyBorrowed,
          loading: false,
        });
      })
      .catch(() => {
        // Fail open and quiet, like every other weather surface: nothing cached means the next
        // drawer-open retries, and a missing history is not an error a skater can act on.
        if (!cancelled) setState({ days: [], coarse: false, loading: false });
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

      {/* The per-day strip. Deliberately a table of numbers with a freezing-line reference rather
          than a chart library: the span is seven points, the interesting comparison is against 32°F,
          and a bar that crosses a labelled line reads faster than an axis. */}
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
}: {
  highF: number | null;
  lowF: number | null;
  rangeLowF: number;
  rangeHighF: number;
  missing: boolean;
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
    <div className="relative h-16 w-2 rounded-full bg-background-subtle">
      <div
        className="absolute right-0 left-0 border-border border-t border-dashed"
        style={{ bottom: `${Math.min(100, Math.max(0, freezePct))}%` }}
      />
      <div
        className={`absolute right-0 left-0 rounded-full ${frozen ? 'bg-accent' : 'bg-foreground-muted'}`}
        style={{
          bottom: `${Math.max(0, pct(lowF))}%`,
          height: `${Math.max(4, pct(highF) - pct(lowF))}%`,
        }}
      />
    </div>
  );
}
