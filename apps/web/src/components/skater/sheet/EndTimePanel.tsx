import {
  endTimeRow,
  floorToMinute,
  formatSkateTime,
  instantForClockAtOrBefore,
  precisionForChoice,
  resolveSkateWindow,
  sectionSummary,
  selectedChips,
  selectedValues,
  startTimeChips,
  zonedInstantOnDayOf,
} from '@skating/core';
import { type ReactNode, useEffect, useState } from 'react';
import { Input } from '@/components/kit/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { timeInputToMinuteOfDay, toTimeInput } from '@/lib/reportForm';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { DayCalendar } from './DayCalendar';
import {
  clampToWindow,
  dayStartOf,
  endOnDay,
  ladderOnDay,
  offeredEndChips,
} from './reportCalendar';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel } from './SheetPanel';
import type { SectionProps } from './sectionProps';

/**
 * *When* (A10 / D192, re-composed A10-6, reworked 2026-11-07): three rows — **End** (required),
 * **Started** and **How long** (optional; only the resolved start is stored) — every one of which
 * the timeline in the center column also sets by a drag (founder call 2026-09-23).
 *
 * Each time row is one line of quick chips (`offeredEndChips` / `startTimeChips` — few enough to
 * never wrap) plus *Another time*, a **time-only** input: the Day row owns the end's date, and a
 * start's date is inferred from its clock against the end (last night when the reading is later
 * than the end's). A value set off the chips — a ruler drag, a typed time — collapses the row to
 * the value and *Reset*, which brings the chips back.
 *
 * The pinned "9:25 AM · now" chip, and its daylight preselect, exist only under a coarse pointer:
 * nobody brings their laptop to the lake, so on a desk "now" is not when anyone got off (founder,
 * 2026-11-07). After dark the ladder starts at sunset and nothing is preselected either way. A
 * track door has already stamped the GPS end exactly, and the row then shows it as the one chip.
 * The ladder and its rules are core's `endTimeRow`, as on the phone.
 */
/** "9:25 AM" on the lake's clock — the whole panel speaks lake time. One formatter per zone. */
const clockFormats = new Map<string, Intl.DateTimeFormat>();
function clock(ms: number, timeZone: string): string {
  let format = clockFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
    clockFormats.set(timeZone, format);
  }
  return format.format(ms);
}

export function EndTimePanel({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [chosen] = selectedValues(sheet, 'endTime');
  const mobile = useCoarsePointer();
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

  // Preselect the pinned minute in daylight, once, for a sheet that has nothing chosen yet — on a
  // phone, where "now" plausibly is when the author got off. The sheet's doing, not the author's:
  // `defaulted` (so an extraction may step it down, D191) and quiet (so an untouched sheet is not
  // dirty the moment it opens).
  const preselect = row.preselected !== undefined ? row.chips[row.preselected] : undefined;
  const preMs = preselect?.ms;
  const prePrecision = preselect?.precision;
  const untouched = chosen === undefined && !sheet.fields.endTime.touched;
  useEffect(() => {
    if (!mobile || !untouched || preMs === undefined || prePrecision === undefined) return;
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
  }, [mobile, untouched, preMs, prePrecision, dispatch]);

  const choose = (ms: number) =>
    dispatch({
      type: 'select',
      field: 'endTime',
      key: 'chosen',
      value: { ms, precision: precisionForChoice(row, ms) },
    });
  // The day the end time is on (5.6/5.7): today unless the author picked another in the calendar.
  const openDay = dayStartOf(row.chips[0]?.ms ?? now, timeZone);
  const day = chosen !== undefined ? dayStartOf(chosen.ms, timeZone) : openDay;
  const ladder = ladderOnDay(offeredEndChips(row.chips, mobile), day, now, timeZone);
  const offLadder = chosen !== undefined && !ladder.some((c) => c.ms === chosen.ms);
  const pickDay = (dayStartMs: number) => {
    // Seeded from what's chosen, else the ladder's top half hour — never the pinned minute: the
    // sheet-open clock carried to another day is exactly the "now" a desk is not offered, and on
    // a phone the preselect has already made it `chosen` when it applies.
    const from = chosen?.ms ?? row.chips.find((c) => !c.pinned)?.ms ?? row.chips[0]?.ms ?? now;
    dispatch({
      type: 'select',
      field: 'endTime',
      key: 'chosen',
      value: { ms: endOnDay(from, dayStartMs, now, timeZone), precision: 'half_hour' },
    });
  };
  // Back to the default: the chips return, and on a phone the pinned minute is selected again.
  const resetEnd = () => {
    setPicking(false);
    for (const chip of selectedChips(sheet, 'endTime')) {
      dispatch({ type: 'deselect', field: 'endTime', key: chip.key });
    }
    if (mobile && preMs !== undefined && prePrecision !== undefined) {
      dispatch({
        type: 'select',
        field: 'endTime',
        key: 'pinned',
        value: { ms: preMs, precision: prePrecision },
        defaulted: true,
      });
    }
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
      <div className="grid grid-cols-[6rem_1fr] items-start gap-x-(--space-3) gap-y-(--space-2_5)">
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
          <ValueLine>
            {formatSkateTime(chosen.ms, timeZone)}
            <span className="text-assist text-fg2"> · from your track</span>
          </ValueLine>
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
            {offLadder && !picking ? (
              <div className="flex min-h-6.5 flex-wrap items-center gap-(--space-2)">
                <span className="text-row text-fg">{clock(chosen.ms, timeZone)}</span>
                <SheetChip compact label="Reset" onClick={resetEnd} />
              </div>
            ) : (
              <div className="flex flex-wrap gap-(--space-1_5)">
                {ladder.map((chip) => (
                  <SheetChip
                    key={chip.ms}
                    compact
                    label={
                      chip.pinned ? `${clock(chip.ms, timeZone)} · now` : clock(chip.ms, timeZone)
                    }
                    {...(chosen?.ms === chip.ms ? { tier: 'solid' as const } : {})}
                    onClick={() => choose(chip.ms)}
                  />
                ))}
                <SheetChip
                  compact
                  label="Another time"
                  {...(offLadder ? { tier: 'solid' as const } : {})}
                  onClick={() => setPicking((p) => !p)}
                />
              </div>
            )}
            {picking ? (
              <Input
                type="time"
                className="max-w-36"
                aria-label="The minute you got off the ice"
                value={chosen !== undefined ? toTimeInput(chosen.ms, timeZone) : ''}
                onChange={(e) => {
                  const minute = timeInputToMinuteOfDay(e.target.value);
                  if (!Number.isFinite(minute)) return;
                  // A clock reading after now clamps to now — floored to the row's minute grain
                  // (never below the window's old edge), so a typed end stays off the seconds.
                  const ms = clampToWindow(zonedInstantOnDayOf(day, minute, timeZone), now);
                  choose(Math.min(ms, floorToMinute(now)));
                }}
              />
            ) : null}
          </div>
        )}
        <StartWindow report={report} dispatch={dispatch} timeZone={timeZone} />
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
  // h-6.5 is the chip row's and the day chip's height: the key centers on its row's first line.
  return (
    <span className="flex h-6.5 items-center whitespace-nowrap">
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

/** A read-only row value, on the same line box as its key. */
function ValueLine({ children }: { children: ReactNode }) {
  return <p className="m-0 flex min-h-6.5 items-center text-row text-fg">{children}</p>;
}

/** *Started* and *How long* — a start time or a duration; only the resolved start is stored. */
function StartWindow({
  report,
  dispatch,
  timeZone,
}: Pick<SectionProps, 'report' | 'dispatch' | 'timeZone'>) {
  const sheet = report.sheet;
  const [end] = selectedValues(sheet, 'endTime');
  const start = sheet.scalars.skateStartTime;
  const [picking, setPicking] = useState<'none' | 'start' | 'duration'>('none');
  const [durationStr, setDurationStr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const gpsStart = end?.precision === 'gps' && start !== undefined;
  // The end row's ladder, mirrored: the half hours just before the end.
  const chips =
    end !== undefined && end.precision !== 'gps' ? startTimeChips(end.ms, timeZone) : [];
  const onChips = start !== undefined && chips.includes(start);

  const resolve = (input: { start?: number; durationMinutes?: number }) => {
    if (end === undefined) return;
    const result = resolveSkateWindow({ end: end.ms, ...input });
    if (result.ok) {
      setError(null);
      dispatch({ type: 'setScalar', key: 'skateStartTime', value: result.skateStartTime });
    } else setError(result.error);
  };
  const clear = () => {
    setPicking('none');
    setDurationStr('');
    setError(null);
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
        <ValueLine>
          {formatSkateTime(start, timeZone)}
          <span className="text-assist text-fg2"> · from your track</span>
        </ValueLine>
        <RowLabel>How long</RowLabel>
        <ValueLine>{duration ?? '—'}</ValueLine>
      </>
    );
  }
  return (
    <>
      <RowLabel>Started</RowLabel>
      <div className="flex flex-col gap-(--space-2)">
        {start !== undefined && !onChips && picking !== 'start' ? (
          // Set off the chips — a ruler drag, a typed time, a duration: the value and the way back.
          <div className="flex min-h-6.5 flex-wrap items-center gap-(--space-2)">
            <span className="text-row text-fg">{clock(start, timeZone)}</span>
            <SheetChip compact label="Reset" onClick={clear} />
          </div>
        ) : (
          <div className="flex flex-wrap gap-(--space-1_5)">
            {chips.map((ms) => (
              <SheetChip
                key={ms}
                compact
                label={clock(ms, timeZone)}
                {...(start === ms ? { tier: 'solid' as const } : {})}
                onClick={() => (start === ms ? clear() : resolve({ start: ms }))}
              />
            ))}
            <SheetChip
              compact
              label={chips.length > 0 ? 'Another time' : 'A start time'}
              {...(start !== undefined && !onChips ? { tier: 'solid' as const } : {})}
              onClick={() => setPicking((p) => (p === 'start' ? 'none' : 'start'))}
            />
          </div>
        )}
        {picking === 'start' && end ? (
          <Input
            type="time"
            className="max-w-36"
            aria-label="The minute you got on the ice"
            value={start !== undefined ? toTimeInput(start, timeZone) : ''}
            onChange={(e) => {
              const minute = timeInputToMinuteOfDay(e.target.value);
              if (!Number.isFinite(minute)) return;
              // The date is the clock's own doing: the latest reading at or before the end —
              // "11:00 PM" against a morning end is last night.
              resolve({ start: instantForClockAtOrBefore(end.ms, minute, timeZone) });
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
            onClick={() =>
              picking === 'duration' || duration !== undefined ? clear() : setPicking('duration')
            }
          />
          {/* Both controls wait on the end time: a duration resolves *back* from it. */}
          {picking === 'duration' && end ? (
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
        ) : picking !== 'none' && !end ? (
          <SheetHint>Say when you got off first — a start time is read back from it.</SheetHint>
        ) : null}
      </div>
    </>
  );
}
