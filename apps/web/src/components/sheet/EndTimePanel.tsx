import {
  endTimeRow,
  formatSkateTime,
  precisionForChoice,
  resolveSkateWindow,
  sectionSummary,
  selectedValues,
} from '@skating/core';
import { useEffect, useMemo, useState } from 'react';
import { datetimeLocalToMs, toDatetimeLocal } from '../../lib/reportForm';
import { Input } from '../ui/input';
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
  const offLadder = chosen !== undefined && !row.chips.some((c) => c.ms === chosen.ms);

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
      <div className="grid grid-cols-[64px_1fr] items-start gap-x-3 gap-y-2">
        <RowLabel>End</RowLabel>
        {gps ? (
          <p className="text-foreground text-sm">
            {formatSkateTime(chosen.ms)}
            <span className="text-foreground-muted text-xs"> · from your track</span>
          </p>
        ) : row.reason === 'expired' ? (
          <SheetHint>
            This sheet was opened more than a week ago. Reports post up to a week after you got off
            the ice — start a new one.
          </SheetHint>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {row.chips.map((chip) => (
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
            {row.reason === 'after_dark' && chosen === undefined ? (
              <SheetHint>It's after dark — when did you come off?</SheetHint>
            ) : null}
          </div>
        )}
        <StartWindow report={report} dispatch={dispatch} />
      </div>
      <SheetHint>
        Drag the marks on the timeline, or set them here. Sunrise and sunset are the lake's.
      </SheetHint>
    </SheetPanel>
  );
}

function RowLabel({ children }: { children: string }) {
  return (
    <span className="pt-1.5 font-mono text-[10px] text-foreground-muted uppercase tracking-[0.1em]">
      {children}
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
        <p className="pt-1 text-foreground text-sm">
          {formatSkateTime(start)}
          <span className="text-foreground-muted text-xs"> · from your track</span>
        </p>
        <RowLabel>How long</RowLabel>
        <p className="pt-1 text-foreground text-sm">{duration ?? '—'}</p>
      </>
    );
  }
  return (
    <>
      <RowLabel>Started</RowLabel>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
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
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
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
              className="h-7 max-w-36"
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
          <p className="text-danger text-xs">{error}</p>
        ) : mode !== 'none' && !end ? (
          <SheetHint>Say when you got off first — a start time is read back from it.</SheetHint>
        ) : null}
      </div>
    </>
  );
}
