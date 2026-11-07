import { reportEndMs, type SheetReport } from '@skating/core';

import { cn } from '@/lib/utils';
import { BodySilhouette } from '../../BodySilhouette';
import { Button } from '../../kit/button';
import { dayLabel } from '../panels/panelTime';
import type { SheetBody } from '../sheet/useSheetBody';

/**
 * The report sheet's instrument on a phone (boards 9.8, 9.9): the lake shrunk to its outline beside
 * its name and when you were there — the summary strip at the head of the one column, where the
 * desktop draws the map, the day's ruler and the weather band. No second map instance on a phone;
 * the When panel's chips below set the time the ruler would (D192's ladder, the keyboard path).
 */
export function PhoneInstrumentStrip({
  report,
  body,
  inert,
  onChange,
  now = Date.now(),
}: {
  report: SheetReport;
  body: SheetBody | null;
  /** Posting, or a sent Post: shown, not offered. */
  inert: boolean;
  /** Change the lake (the one Report's): asks first, as the desktop tab's × does. */
  onChange?: () => void;
  now?: number;
}) {
  const name = report.bodyName ?? body?.name ?? 'This lake';
  const timeZone = body?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section
      data-slot="phone-instrument"
      aria-label="The lake and the day"
      inert={inert}
      className={cn(
        'flex shrink-0 items-stretch gap-(--space-3) border-0 border-b border-solid border-line px-(--space-4) py-(--space-3_5)',
        inert && 'opacity-50',
      )}
    >
      <div className="flex size-23 shrink-0 items-center justify-center border border-solid border-line bg-panel">
        {body?.silhouette ? (
          <BodySilhouette data={body.silhouette} size={82} />
        ) : (
          <span aria-hidden="true" className="text-assist text-fg3">
            …
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-1_5)">
        <span className="flex items-center gap-(--space-2)">
          <h2 className="m-0 min-w-0 flex-1 truncate text-[1rem] leading-none font-semibold tracking-head text-fg uppercase">
            {name}
          </h2>
          {onChange !== undefined && (
            <Button size="xs" data-attr="phone-instrument-change" onClick={onChange}>
              Change
            </Button>
          )}
        </span>
        <span
          data-slot="phone-instrument-when"
          className="font-(family-name:--family-mono) text-mono-sm text-fg1"
        >
          {whenLine(report, timeZone, now)}
        </span>
      </div>
    </section>
  );
}

/** "Today · 9:30–11:30 AM", "Yesterday · 4:10 PM", or the line that says it isn't set yet. */
export function whenLine(report: SheetReport, timeZone: string, now: number): string {
  const end = reportEndMs(report);
  if (end === undefined) return 'When: not set yet';
  const start = report.sheet.scalars.skateStartTime;
  const clock = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(ms);
  const bare = (ms: number) => clock(ms).replace(/\s?[AP]M$/, '');
  const span =
    start !== undefined && start < end
      ? `${samePeriod(start, end, timeZone) ? bare(start) : clock(start)}–${clock(end)}`
      : clock(end);
  return `${dayLabel(end, now)} · ${span}`;
}

/** Whether two instants share AM or PM in the zone (the start drops its period when they do). */
function samePeriod(a: number, b: number, timeZone: string): boolean {
  const period = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone })
      .formatToParts(ms)
      .find((p) => p.type === 'dayPeriod')?.value;
  return period(a) === period(b);
}
