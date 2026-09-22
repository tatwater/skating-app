import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  conditionsFromWindowHour,
  describeWeatherHour,
  endTimeRow,
  formatSkateTime,
  hourAt,
  hoursInWindow,
  placeHours,
  precisionForChoice,
  resolveSkateWindow,
  sectionSummary,
  selectedValues,
  summarizeWeatherWindow,
  type WindowHour,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';
import { datetimeLocalToMs, toDatetimeLocal } from '../../lib/reportForm';
import { Input } from '../ui/input';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel, SubLabel } from './SheetPanel';
import type { SectionProps } from './sectionProps';
import { WeatherCorrection } from './WeatherCorrection';

/**
 * *When did you get off?* (A10 / D192): the minute the console was opened, pinned; half-hour steps
 * back; a datetime field bounded by the week (D199). Preselected only in daylight at the body;
 * after dark the ladder starts at sunset and nothing is chosen.
 *
 * Under the chosen time, **the weather the archive has for that hour** at the body (founder call,
 * 2026-09-21); with a start time or a duration, the whole run. *Not what you saw?* opens the
 * correction, which stores as the author's own reading.
 *
 * The ladder and its rules are core's `endTimeRow`, as on the phone; what is web's is the control
 * under *Another time* — a native `datetime-local` bounded by the same two instants, instead of a
 * platform picker.
 */
export function EndTimePanel({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [chosen] = selectedValues(sheet, 'endTime');
  // Read once, at mount: the ladder must not tick under the cursor.
  const [now] = useState(() => Date.now());
  const row = endTimeRow({
    openedAtMs: sheet.openedAtMs,
    nowMs: now,
    timeZone,
    sun: body?.sunAt(sheet.openedAtMs) ?? null,
  });
  const gps = chosen?.precision === 'gps';
  const [picking, setPicking] = useState(false);

  // Preselect the pinned minute in daylight, once, for a sheet that has nothing chosen yet. The
  // sheet's doing, not the author's: `defaulted` (so an extraction may step it down, D191) and
  // quiet (so an untouched sheet is not dirty the moment it opens).
  const preselect = row.preselected !== undefined ? row.chips[row.preselected] : undefined;
  const preMs = preselect?.ms;
  const prePrecision = preselect?.precision;
  const untouched = chosen === undefined && !sheet.fields.endTime.touched;
  useEffect(() => {
    if (!untouched || preMs === undefined || prePrecision === undefined) return;
    dispatch(
      {
        type: 'select',
        field: 'endTime',
        key: 'pinned',
        value: { ms: preMs, precision: prePrecision },
        defaulted: true,
      },
      { quiet: true },
    );
  }, [untouched, preMs, prePrecision, dispatch]);

  const choose = (ms: number) =>
    dispatch({
      type: 'select',
      field: 'endTime',
      key: 'chosen',
      value: { ms, precision: precisionForChoice(row, ms) },
    });
  const clock = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(ms);
  const offLadder = chosen !== undefined && !row.chips.some((c) => c.ms === chosen.ms);

  return (
    <SheetPanel
      label="When did you get off?"
      summary={sectionSummary(sheet, 'endTime', timeZone)}
      collapsed={sheet.collapsed.endTime}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'endTime', collapsed: !sheet.collapsed.endTime })
      }
      gap={gaps.has('endTime')}
    >
      {gps ? (
        <p className="text-foreground text-sm">
          {formatSkateTime(chosen.ms)}
          <span className="text-foreground-muted text-xs"> from your track</span>
        </p>
      ) : row.reason === 'expired' ? (
        <SheetHint>
          This sheet was opened more than a week ago. Reports post up to a week after you got off
          the ice — start a new one.
        </SheetHint>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {row.chips.map((chip) => (
              <SheetChip
                key={chip.ms}
                label={chip.pinned ? `${clock(chip.ms)} · now` : clock(chip.ms)}
                {...(chosen?.ms === chip.ms ? { tier: 'solid' as const } : {})}
                onClick={() => choose(chip.ms)}
              />
            ))}
            <SheetChip
              label={offLadder ? formatSkateTime(chosen.ms) : 'Another time'}
              {...(offLadder ? { tier: 'solid' as const } : {})}
              onClick={() => setPicking((p) => !p)}
            />
          </div>
          {picking ? (
            <Input
              type="datetime-local"
              className="max-w-64"
              aria-label="The minute you got off the ice"
              value={toDatetimeLocal(chosen?.ms ?? row.pickerMaxMs)}
              min={toDatetimeLocal(row.pickerMinMs)}
              max={toDatetimeLocal(row.pickerMaxMs)}
              onChange={(e) => {
                const ms = datetimeLocalToMs(e.target.value);
                if (Number.isFinite(ms)) choose(ms);
              }}
            />
          ) : null}
          {row.reason === 'after_dark' && chosen === undefined ? (
            <SheetHint>It's after dark — when did you come off?</SheetHint>
          ) : null}
        </div>
      )}
      <StartWindow report={report} dispatch={dispatch} />
      {chosen !== undefined && body ? (
        <SkateWeather
          waterBodyId={body.waterBodyId}
          endMs={chosen.ms}
          startMs={sheet.scalars.skateStartTime}
          timeZone={timeZone}
          report={report}
          dispatch={dispatch}
        />
      ) : null}
    </SheetPanel>
  );
}

/** *When did you get on?* — a start time or a duration; only the resolved start is stored. */
function StartWindow({ report, dispatch }: Pick<SectionProps, 'report' | 'dispatch'>) {
  const sheet = report.sheet;
  const [end] = selectedValues(sheet, 'endTime');
  const start = sheet.scalars.skateStartTime;
  const [mode, setMode] = useState<'none' | 'start' | 'duration'>(
    start !== undefined ? 'start' : 'none',
  );
  const [durationStr, setDurationStr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const gpsStart = end?.precision === 'gps' && start !== undefined;

  const resolve = (input: { start?: number; durationMinutes?: number }) => {
    if (end === undefined) return;
    const result = resolveSkateWindow({ end: end.ms, ...input });
    if (result.ok) {
      setError(null);
      dispatch({ type: 'setScalar', key: 'skateStartTime', value: result.skateStartTime });
    } else setError(result.error);
  };

  if (gpsStart) {
    return (
      <p className="text-foreground-muted text-xs">
        On the ice from {formatSkateTime(start)}, from your track.
      </p>
    );
  }
  const minutes = start !== undefined && end ? Math.round((end.ms - start) / 60_000) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <SubLabel>When did you get on? (optional)</SubLabel>
      <div className="flex flex-wrap gap-2">
        <SheetChip
          label="A start time"
          {...(mode === 'start' ? { tier: 'solid' as const } : {})}
          onClick={() => {
            if (mode === 'start') {
              setMode('none');
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
            } else setMode('start');
          }}
        />
        <SheetChip
          label="How long"
          {...(mode === 'duration' ? { tier: 'solid' as const } : {})}
          onClick={() => {
            if (mode === 'duration') {
              setMode('none');
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
            } else setMode('duration');
          }}
        />
      </div>
      {mode === 'start' && end ? (
        <Input
          type="datetime-local"
          className="max-w-64"
          aria-label="The minute you got on the ice"
          value={start !== undefined ? toDatetimeLocal(start) : ''}
          max={toDatetimeLocal(end.ms)}
          onChange={(e) => {
            const ms = datetimeLocalToMs(e.target.value);
            if (Number.isFinite(ms)) resolve({ start: ms });
          }}
        />
      ) : null}
      {mode === 'duration' ? (
        <Input
          inputMode="numeric"
          className="max-w-40"
          placeholder="minutes, e.g. 90"
          aria-label="How long you were on the ice, in minutes"
          value={durationStr}
          onChange={(e) => {
            const text = e.target.value;
            setDurationStr(text);
            if (text.trim() === '') {
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
              return;
            }
            resolve({ durationMinutes: Number(text) });
          }}
        />
      ) : null}
      {error ? (
        <p className="text-danger text-xs">{error}</p>
      ) : minutes !== undefined && minutes > 0 ? (
        <SheetHint>About {minutes} minutes on the ice.</SheetHint>
      ) : null}
    </div>
  );
}

/**
 * The archive's weather for the skate (founder call, 2026-09-21): the hour at the end time, or the
 * whole window once a start is known. Read through the panel's action, which serves the hours the
 * map already fetched and fetches the rest once; nothing shows until the archive answers, and
 * nothing is guessed.
 */
function SkateWeather({
  waterBodyId,
  endMs,
  startMs,
  timeZone,
  report,
  dispatch,
}: {
  waterBodyId: string;
  endMs: number;
  startMs: number | undefined;
  timeZone: string;
} & Pick<SectionProps, 'report' | 'dispatch'>) {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [hours, setHours] = useState<WindowHour[] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  // Re-read when the day the end time falls on changes, not on every minute chip.
  const dayMs = 24 * 3600_000;
  const days = Math.min(92, Math.max(2, Math.ceil((Date.now() - endMs) / dayMs) + 2));

  useEffect(() => {
    let cancelled = false;
    getDays({ waterBodyId: waterBodyId as Id<'waterBodies'>, days })
      .then((res) => {
        if (cancelled || !res) return;
        setHours(placeHours(res.hours, timeZone));
      })
      .catch(() => {
        // No archive for this cell yet, or no connection: the line stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, timeZone, days]);

  if (hours === null) return null;
  const window = hoursInWindow(hours, endMs, startMs);
  const at = hourAt(hours, endMs);
  const summary = startMs !== undefined ? summarizeWeatherWindow(window, timeZone) : null;
  const corrected = report.sheet.scalars.conditions;
  if (!at && !summary) return null;

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <p className="text-foreground text-sm">
        {summary ? summary.sentence : at ? describeWeatherHour(at) : ''}
        {corrected !== undefined && corrected.source !== 'openmeteo' ? (
          <span className="text-foreground-muted text-xs"> · corrected</span>
        ) : null}
      </p>
      {correcting ? (
        <WeatherCorrection
          initial={
            corrected ??
            (at ? { ...conditionsFromWindowHour(at), source: 'user' } : { source: 'user' })
          }
          onChange={(next) => dispatch({ type: 'setScalar', key: 'conditions', value: next })}
          onDone={() => setCorrecting(false)}
        />
      ) : (
        <button
          type="button"
          className="self-start text-primary text-xs hover:underline"
          onClick={() => setCorrecting(true)}
        >
          Not what you saw? Correct it
        </button>
      )}
    </div>
  );
}
