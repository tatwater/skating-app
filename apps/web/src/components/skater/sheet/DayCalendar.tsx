import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { cn } from '@/lib/utils';
import { type CalendarDay, calendarCaption, calendarDays } from './reportCalendar';
import { useSheetContainer } from './sheetSlots';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * *When*'s day (5.6/5.7): a chip naming the day the end time is on, opening the report calendar —
 * last week and this one, with only the days a report can still be about live (D199,
 * `reportCalendar`). Today is the default; nothing older than the window can be picked.
 */
export function DayCalendar({
  dayStartMs,
  nowMs,
  timeZone,
  onPick,
}: {
  /** The day the end time is on now (its local midnight). */
  dayStartMs: number;
  nowMs: number;
  timeZone: string;
  onPick: (day: CalendarDay) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useSheetContainer();
  const days = useMemo(() => calendarDays(nowMs, timeZone), [nowMs, timeZone]);
  const today = days.find((d) => d.today);
  const dayName = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    [timeZone],
  );
  const label = useMemo(() => {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(dayStartMs + 12 * 3600_000);
    return today?.startMs === dayStartMs ? `Today · ${day}` : day;
  }, [dayStartMs, timeZone, today]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-attr="sheet-day"
        className={cn(
          'inline-flex h-6.5 cursor-pointer items-center gap-(--space-1_5) self-start rounded-control border border-solid border-line2 bg-transparent px-(--space-2) text-assist text-fg1 outline-none',
          'focus-visible:shadow-focus data-popup-open:bg-raise',
        )}
      >
        {label}
        <span aria-hidden className="text-fg3">
          ▾
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[18.5rem] p-(--space-3)"
        {...(container !== null ? { container } : {})}
      >
        <div className="mb-(--space-2_5) flex items-baseline justify-between">
          <span className="text-row font-medium text-fg">{calendarCaption(days, timeZone)}</span>
          <span className="text-assist text-fg3">The last 7 days</span>
        </div>
        <div className="grid grid-cols-7 gap-(--space-0_5) text-center">
          {WEEKDAYS.map((w) => (
            <span
              key={w}
              aria-hidden
              className="pb-(--space-1) text-kick tracking-head text-fg3 uppercase"
            >
              {w}
            </span>
          ))}
        </div>
        <fieldset
          aria-label="Which day was it?"
          className="m-0 grid grid-cols-7 gap-(--space-0_5) border-0 p-0 text-center"
        >
          {days.map((day) => {
            const chosen = day.startMs === dayStartMs;
            return (
              <button
                key={day.startMs}
                type="button"
                aria-pressed={chosen}
                aria-label={dayName.format(day.startMs + 12 * 3600_000)}
                aria-current={day.today ? 'date' : undefined}
                disabled={!day.live}
                data-attr="sheet-day-cell"
                onClick={() => {
                  onPick(day);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-9 cursor-pointer flex-col items-center justify-center rounded-control border-0 bg-transparent font-(family-name:--family-mono) text-mono-sm text-fg1 outline-none',
                  'hover:bg-lift-08 focus-visible:shadow-focus',
                  'disabled:cursor-default disabled:text-fg-disabled disabled:hover:bg-transparent',
                  chosen && 'bg-inv-bg text-inv-fg hover:bg-inv-bg',
                )}
              >
                {day.dayOfMonth}
                {day.today ? (
                  <small className="text-[0.625rem] leading-none font-(family-name:--family-sans)">
                    Today
                  </small>
                ) : null}
              </button>
            );
          })}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
