import { INBOX_LANES, type InboxLane, zoneOffsetMs } from '@skating/core';
import {
  type ComponentProps,
  cloneElement,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react';

import { buttonVariants } from '@/components/kit/button';
import { DisplayWord } from '@/components/kit/display-word';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { SkeletonText } from '@/components/kit/skeleton';
import { hourTicks, type StepEvent, StepRugChart } from '@/components/kit/step-rug-chart';
import { cn } from '@/lib/utils';
import { ComingSoonLink } from '../inspector/ComingSoonLink';
import {
  CORPUS,
  CORPUS_LINK,
  DECIDED_BY_LANE,
  INBOX_ZERO,
  LEGEND_DECIDED,
  LEGEND_FILED,
  LEGEND_OPEN,
  MACHINERY,
  MACHINERY_LINK,
  medianWords,
  NOT_IN_INBOX,
  OPEN_START_UNKNOWN,
  OPEN_TODAY,
  TODAY_CAPPED,
  ZERO_LANE_WORDS,
  zeroAt,
  zeroLine,
  zeroQuiet,
} from '../words/inboxWords';
import type { InboxTodayView } from './inboxTypes';

/**
 * **Inbox zero** (board 2.9, the inspector's column when nothing is open and nothing waits): no pane
 * head; the word, then the day in one line — *As of 15:02, 22 decided today, a median of 1.5 days from
 * filing to decision* — then *Open, today* (the open count stepping through the day over its rug of
 * filings and decisions, marked where it reached zero), *Decided today, by lane*, and *Not in the
 * inbox*: where the work that isn't a person's filing waits (Corpus, Machinery — *Coming soon*, D286).
 *
 * From `inbox.today`, read only while the inbox is at zero. Nothing is judged: these are counts of
 * what moderators did, never anything about ice (D3).
 */

/**
 * The live links of *Not in the inbox*, by the mode they open: the router's link element, worn as
 * the row's link chip. A mode with none here is *Coming soon* (D286). The route provides them (Corpus
 * from B01-7a: the first task lane with an open task), so the view between needs no prop for them.
 */
export const ZeroLinks = createContext<{ corpus?: ReactElement }>({});

const HOUR = 3_600_000;
/** The longest two whole local hours in a row are apart: 90 minutes, across a half-hour change. */
const LONGEST_LOCAL_HOUR = 1.5 * HOUR;

export type ZeroToday =
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'ready'; today: InboxTodayView };

export function InboxZero({
  day,
  now,
  timeZone,
  notInInbox,
  canReadSupport = true,
}: {
  day: ZeroToday;
  now: number;
  timeZone?: string;
  /** Support's lane is the support readers' (D37): hidden from anyone else, never drawn as zero. */
  canReadSupport?: boolean;
  /** What waits in Corpus and Machinery, worded by the route; each line is drawn only with words. */
  notInInbox?: { corpus?: ReactNode; machinery?: ReactNode };
}) {
  const time = (at: number) => clock(at, timeZone);
  const links = useContext(ZeroLinks);
  return (
    <div data-slot="inbox-zero" className="min-h-0 flex-1 overflow-y-auto pb-(--space-14)">
      <div className="flex flex-col gap-(--space-2_5) px-gutter pt-(--space-7)">
        <DisplayWord data-slot="inbox-zero-word" render={(props) => <h2 {...props} />}>
          {INBOX_ZERO}
        </DisplayWord>
        {day.kind === 'ready' ? (
          <p data-slot="inbox-zero-line" className="m-0 text-body leading-body text-fg2">
            {dayLine(day.today, now, time)}
          </p>
        ) : day.kind === 'loading' ? (
          <SkeletonText className="text-body" width="70%" />
        ) : null}
      </div>
      {day.kind === 'failed' && (
        <RetryNote className="px-gutter pt-(--space-4)" onRetry={day.retry} pending={day.retrying}>
          {INBOX_ZERO}
        </RetryNote>
      )}
      {day.kind === 'ready' && (
        <>
          <Section title={OPEN_TODAY} className="px-gutter pt-(--space-5_5)" end={<Legend />}>
            {day.today.openAtStart === null ? (
              // The server can't tell how many were open as the day began (its lists were capped):
              // no line is drawn from a figure worked back from capped lists — that would overstate.
              <Note data-slot="inbox-zero-start-unknown">{OPEN_START_UNKNOWN}</Note>
            ) : (
              <StepRugChart
                className="h-[13.375rem]"
                label={OPEN_TODAY}
                start={day.today.openAtStart}
                events={eventsOf(day.today)}
                {...(() => {
                  // The ticks on the reader's whole hours, as the span is (a half-hour zone's
                  // UTC hours would read :30): floored by this page's own clock.
                  const zone = timeZone ?? ownZone();
                  const { from, to } = span(day.today, now, zone);
                  return { from, to, ticks: hourTicks(from, to, (t) => floorLocalHour(t, zone)) };
                })()}
                formatTime={time}
                zeroLabel={(at) => zeroAt(time(at))}
              />
            )}
            {(day.today.filedCapped || day.today.decidedCapped) && (
              <p className="m-0 text-assist text-fg3">{TODAY_CAPPED}</p>
            )}
          </Section>
          <Section title={DECIDED_BY_LANE} className="px-gutter pt-(--space-5_5)">
            <ByLane today={day.today} canReadSupport={canReadSupport} />
          </Section>
        </>
      )}
      <Section title={NOT_IN_INBOX} className="px-gutter pt-(--space-5_5)">
        <div data-slot="inbox-zero-elsewhere" className="flex flex-col">
          <Elsewhere name={CORPUS} link={CORPUS_LINK} to={links.corpus}>
            {notInInbox?.corpus}
          </Elsewhere>
          <Elsewhere name={MACHINERY} link={MACHINERY_LINK} last>
            {notInInbox?.machinery}
          </Elsewhere>
        </div>
      </Section>
    </div>
  );
}

/** "As of 15:02, 22 decided today, a median of 1.5 days from filing to decision." */
export function dayLine(today: InboxTodayView, now: number, time: (at: number) => string): string {
  const asOf = time(now);
  const n = today.decided.length;
  if (n === 0) return zeroQuiet(asOf);
  const waits = today.decided.map((d) => d.at - d.filedAt).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1
      ? (waits[mid] as number)
      : ((waits[mid - 1] as number) + (waits[mid] as number)) / 2;
  const count = `${n.toLocaleString('en-US')}${today.decidedCapped ? '+' : ''}`;
  return zeroLine(asOf, count, medianWords(median));
}

/** Filings raise the count, decisions lower it. */
export function eventsOf(today: InboxTodayView): StepEvent[] {
  return [
    ...today.filed.map((f) => ({ at: f.at, delta: 1 as const })),
    ...today.decided.map((d) => ({ at: d.at, delta: -1 as const })),
  ];
}

/** The viewer's own zone, when the page names none. */
const ownZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone's offset at `ms`, read at the whole second (core's `zoneOffsetMs` carries ms' remainder). */
const offsetAt = (ms: number, timeZone: string) =>
  zoneOffsetMs(Math.floor(ms / 1000) * 1000, timeZone);

/**
 * The latest instant at or before `at` whose clock in `timeZone` reads a whole hour (:00:00) —
 * resolved by the zone's own offsets, never by taking the local minutes off: just after a clock
 * change the minutes taken off would straddle it, and a change of half an hour (Lord Howe Island)
 * would land on a local :30. In a half-hour or 45-minute zone (St John's, India, Kathmandu) a UTC
 * hour is a local :30 or :15, so the floor is the reader's clock's, never UTC's.
 *
 * The local reading at `at` is floored to its hour; every offset in force within three hours either
 * side gives a candidate instant for that reading, and the latest one that does read it and lies at
 * or before `at` wins. A reading a change skipped (the clocks jumped over it) has no instant: the
 * hour before it is tried.
 */
export function floorLocalHour(at: number, timeZone: string): number {
  const offsets = [
    ...new Set([0, -3, -2, -1, 1, 2, 3].map((h) => offsetAt(at + h * HOUR, timeZone))),
  ];
  let wall = Math.floor((at + offsetAt(at, timeZone)) / HOUR) * HOUR;
  for (let tries = 0; tries < 4; tries++) {
    const instants = offsets
      .map((off) => wall - off)
      .filter((t) => t <= at && t + offsetAt(t, timeZone) === wall);
    if (instants.length > 0) return Math.max(...instants);
    wall -= HOUR;
  }
  /* v8 ignore next 2 — no zone skips four hours in a row */
  return Math.floor(at / HOUR) * HOUR;
}

/**
 * The earliest instant at or after `at` whose clock in `timeZone` reads a whole hour — the floor's
 * mirror. Two whole local hours in a row are an hour apart, but 90 real minutes across Lord Howe's
 * half-hour changes (01:00, then 03:00 the morning 02:00 is skipped), so "an hour on, floored" can
 * fall short of `at`; the next whole hour after a floor is the latest one within 90 minutes of it.
 */
export function ceilLocalHour(at: number, timeZone: string): number {
  const floor = floorLocalHour(at, timeZone);
  return floor === at ? at : floorLocalHour(floor + LONGEST_LOCAL_HOUR, timeZone);
}

/**
 * The chart's span: from the local hour of the day's first event (or eight hours back), never before
 * the day began, to the first whole local hour at or after now that is at least an hour on.
 */
export function span(
  today: InboxTodayView,
  now: number,
  timeZone: string = ownZone(),
): { from: number; to: number } {
  const first = Math.min(now - 8 * HOUR, ...eventsOf(today).map((e) => e.at));
  const from = Math.max(today.since, floorLocalHour(first, timeZone));
  const to = ceilLocalHour(Math.max(now, from + HOUR), timeZone);
  return { from, to };
}

/** Each lane's decisions today, in the lanes' order — Support only for a viewer who reads it. */
export function byLane(
  today: InboxTodayView,
  canReadSupport = true,
): { lane: InboxLane; count: number }[] {
  const counts = new Map<InboxLane, number>();
  for (const d of today.decided) counts.set(d.lane, (counts.get(d.lane) ?? 0) + 1);
  return INBOX_LANES.filter((lane) => canReadSupport || lane !== 'support').map((lane) => ({
    lane,
    count: counts.get(lane) ?? 0,
  }));
}

function ByLane({ today, canReadSupport }: { today: InboxTodayView; canReadSupport: boolean }) {
  return (
    // As many to a row as fit (seven at the boards' width), each name whole — on a phone the cells
    // wrap to further rows rather than cut a lane's name.
    <dl
      data-slot="inbox-zero-by-lane"
      className="m-0 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-y-(--space-3)"
    >
      {byLane(today, canReadSupport).map(({ lane, count }) => (
        <div
          key={lane}
          data-lane={lane}
          className="me-(--space-2_5) flex min-w-0 flex-col gap-(--space-1_5) border-0 border-e border-dotted border-line pe-(--space-2_5) last:me-0 last:border-e-0"
        >
          <dt className="text-kick leading-(--lead-snug) font-medium tracking-label break-words text-fg3 uppercase">
            {ZERO_LANE_WORDS[lane]}
          </dt>
          <dd className="m-0 font-(family-name:--family-mono) text-stat leading-none font-medium text-fg">
            {count.toLocaleString('en-US')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Legend() {
  return (
    <span
      data-slot="inbox-zero-legend"
      className="flex items-center gap-(--space-3_5) text-assist leading-none text-fg3"
    >
      <span className="flex items-center gap-(--space-1_5)">
        <i aria-hidden="true" className="h-px w-(--space-4) bg-fg" />
        {LEGEND_OPEN}
      </span>
      <span className="flex items-center gap-(--space-1_5)">
        <i aria-hidden="true" className="size-[5px] border border-solid border-fg3" />
        {LEGEND_FILED}
      </span>
      <span className="flex items-center gap-(--space-1_5)">
        <i aria-hidden="true" className="h-[9px] w-px bg-fg2" />
        {LEGEND_DECIDED}
      </span>
    </span>
  );
}

function Elsewhere({
  name,
  link,
  to,
  last = false,
  children,
}: {
  name: string;
  link: string;
  /** The router's link to the mode; without one the mode is *Coming soon*. */
  to?: ReactElement | undefined;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid min-h-(--space-10) grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-(--space-3) text-row text-fg1',
        !last && 'border-0 border-b border-dotted border-line',
      )}
    >
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        {name}
      </span>
      <span className="min-w-0">{children}</span>
      {to === undefined ? (
        <ComingSoonLink>{link}</ComingSoonLink>
      ) : (
        cloneElement(
          to as ReactElement<ComponentProps<'a'>>,
          {
            'data-slot': 'inbox-zero-link',
            className: cn(buttonVariants({ variant: 'link', size: 'xs' }), 'no-underline'),
            children: (
              <span className="inline-flex items-center gap-[inherit]">
                {link}
                <span aria-hidden="true" className="-mr-[3px]">
                  →
                </span>
              </span>
            ),
          } as ComponentProps<'a'>,
        )
      )}
    </div>
  );
}

/** "15:02" in the console's zone. */
function clock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined && { timeZone }),
  }).format(at);
}
