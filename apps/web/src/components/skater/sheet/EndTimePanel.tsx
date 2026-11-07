import {
  endTimeRow,
  formatSkateTime,
  precisionForChoice,
  resolveSkateWindow,
  sectionSummary,
  selectedValues,
} from '@skating/core';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/kit/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { datetimeLocalToMs, toDatetimeLocal } from '@/lib/reportForm';
import { DayCalendar } from './DayCalendar';
import { dayStartOf, endOnDay, ladderOnDay } from './reportCalendar';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel } from './SheetPanel';
import type { SectionProps } from './sectionProps';

/**
 * *When* (A10 / D192, re-composed A10-6): three rows — **End** (required; the minute the console
 * was opened, pinned; half-hour steps back; a datetime bounded by the week, D199), **Started** and
 * **How long** (optional; only the resolved start is stored) — every one of which the timeline in
 * the center column also sets by a drag (founder call 2026-09-23). The weather that used to sit
 * here is the band under the timeline now.
 *
 * Preselected only in daylight at the body; after dark the ladder starts at sunset and nothing is
 * chosen. A track door has already stamped the GPS end exactly, and the row then shows it as the
 * one chip. The ladder and its rules are core's `endTimeRow`, as on the phone.
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
  const clockFormat = useMemo(
    () => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }),
    [timeZone],
  );
  const clock = (ms: number) => clockFormat.format(ms);
  // The day the end time is on (5.6/5.7): today unless the author picked another in the calendar.
  const openDay = dayStartOf(row.chips[0]?.ms ?? now, timeZone);
  const day = chosen !== undefined ? dayStartOf(chosen.ms, timeZone) : openDay;
  const ladder = ladderOnDay(row.chips, day, now, timeZone);
  const offLadder = chosen !== undefined && !ladder.some((c) => c.ms === chosen.ms);
  const pickDay = (dayStartMs: number) => {
    const from = chosen?.ms ?? row.chips[row.preselected ?? 1]?.ms ?? now;
    dispatch({
      type: 'select',
      field: 'endTime',
      key: 'chosen',
      value: { ms: endOnDay(from, dayStartMs, now, timeZone), precision: 'half_hour' },
    });
  };

  return (
    <SheetPanel
      id="section-when"
      label="When"
      summary={sectionSummary(sheet, 'endTime', timeZone)}
      collapsed={sheet.collapsed.endTime}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'endTime', collapsed: !sheet.collapsed.endTime })
      }
      gap={gaps.has('endTime')}
    >
      <div className="grid grid-cols-[4.5rem_1fr] items-start gap-x-(--space-3) gap-y-(--space-2_5)">
        {gps || row.reason === 'expired' ? null : (
          <>
            <RowLabel>Day</RowLabel>
            <DayCalendar
              dayStartMs={day}
              nowMs={now}
              timeZone={timeZone}
              onPick={(d) => pickDay(d.startMs)}
            />
          </>
        )}
        <RowLabel tip="Drag the marks on the day's ruler, or set them here. Sunrise and sunset are the lake's.">
          End
        </RowLabel>
        {gps ? (
          <p className="m-0 pt-1 text-row text-fg">
            {formatSkateTime(chosen.ms)}
            <span className="text-assist text-fg2"> · from your track</span>
          </p>
        ) : row.reason === 'expired' ? (
          <SheetHint>
            This sheet was opened more than a week ago. Reports post up to a week after you got off
            the ice — start a new one.
          </SheetHint>
        ) : (
          <div className="flex flex-col gap-(--space-2)">
            {row.reason === 'after_dark' && chosen === undefined ? (
              <p className="m-0 text-assist text-warn">
                It's after dark — which day was it, and when did you come off?
              </p>
            ) : null}
            <div className="flex flex-wrap gap-(--space-1_5)">
              {ladder.map((chip) => (
                <SheetChip
                  key={chip.ms}
                  compact
                  label={chip.pinned ? `${clock(chip.ms)} · now` : clock(chip.ms)}
                  {...(chosen?.ms === chip.ms ? { tier: 'solid' as const } : {})}
                  onClick={() => choose(chip.ms)}
                />
              ))}
              <SheetChip
                compact
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
          </div>
        )}
        <StartWindow report={report} dispatch={dispatch} />
      </div>
    </SheetPanel>
  );
}

function RowLabel({ children, tip }: { children: string; tip?: string }) {
  const label = (
    <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
      {children}
    </span>
  );
  return (
    <span className="pt-(--space-2)">
      {tip === undefined ? (
        label
      ) : (
        <Tooltip>
          <TooltipTrigger variant="text" tabIndex={0}>
            {label}
          </TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** *Started* and *How long* — a start time or a duration; only the resolved start is stored. */
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
  const clear = () => {
    setMode('none');
    dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
  };
  const minutes = start !== undefined && end ? Math.round((end.ms - start) / 60_000) : undefined;
  const duration =
    minutes !== undefined && minutes > 0
      ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
      : undefined;

  if (gpsStart) {
    return (
      <>
        <RowLabel>Started</RowLabel>
        <p className="m-0 pt-1 text-row text-fg">
          {formatSkateTime(start)}
          <span className="text-assist text-fg2"> · from your track</span>
        </p>
        <RowLabel>How long</RowLabel>
        <p className="m-0 pt-1 text-row text-fg">{duration ?? '—'}</p>
      </>
    );
  }
  return (
    <>
      <RowLabel>Started</RowLabel>
      <div className="flex flex-col gap-(--space-2)">
        <div className="flex flex-wrap gap-(--space-1_5)">
          <SheetChip
            compact
            label={start !== undefined ? formatSkateTime(start) : 'A start time'}
            {...(start !== undefined ? { tier: 'solid' as const } : {})}
            onClick={() => (mode === 'start' ? clear() : setMode('start'))}
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
      </div>
      <RowLabel>How long</RowLabel>
      <div className="flex flex-col gap-(--space-2)">
        <div className="flex flex-wrap items-center gap-(--space-1_5)">
          <SheetChip
            compact
            label={duration ?? 'How long'}
            {...(duration !== undefined ? { tier: 'solid' as const } : {})}
            onClick={() => (mode === 'duration' ? clear() : setMode('duration'))}
          />
          {/* Both controls wait on the end time: a duration resolves *back* from it. */}
          {mode === 'duration' && end ? (
            <Input
              inputMode="numeric"
              className="max-w-36"
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
        </div>
        {error ? (
          <p className="m-0 text-assist text-warn">{error}</p>
        ) : mode !== 'none' && !end ? (
          <SheetHint>Say when you got off first — a start time is read back from it.</SheetHint>
        ) : null}
      </div>
    </>
  );
}
