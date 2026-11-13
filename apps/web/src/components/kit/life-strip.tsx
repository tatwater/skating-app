import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * "Its life" as a strip map (custom; B01-3 — People's hidden content 8.3, the Inbox's alert 2.6):
 * an item's history as stations on a line, **one station per event, evenly spaced** however many
 * there are, and the line between two stations drawn as **the state the item was in** between
 * them, with how long it lasted written in the line's gap.
 *
 * - **Lines** (`LifeLine`): `thin` (a hairline in the faint ink), `heavy` (3 px in the bright ink),
 *   `dashed` (2 px, the muted ink) — what would happen next, never what happened. What each weight
 *   *means* is the caller's (`lines`: visible to skaters / hidden / if restored on 8.3), and it is
 *   said once in the key under the strip and to a reader at every line.
 * - **Marks** (`LifeMark`): `dot` (an event), `hollow` (a quiet one, ringed), `ring` (ringed in the
 *   bright ink — a confirmation), `square` (a staff act, bright), `warn` (amber: something that
 *   changed the item's footing), `now` (today, the larger bright square), `end` (the station a
 *   decision would reach, faint and open). The station's words take the mark's tone: `now` bright,
 *   `warn` amber, `end` faint.
 * - **Never a forecast of the ice**: a station records what happened to an item, or what a staff
 *   action would do to it.
 *
 * A run too long to read (a dozen confirmations) is the caller's to fold into one station.
 */

type LifeLine = 'thin' | 'heavy' | 'dashed';

type LifeMark = 'dot' | 'hollow' | 'ring' | 'square' | 'warn' | 'now' | 'end';

type LifeStation = {
  /** When ("Wed 18 Mar", "14 Oct · today", "If restored"), set as a kicker. */
  when: ReactNode;
  /** What happened ("Hidden"). */
  title: ReactNode;
  /** Who, or why ("As a duplicate"). */
  sub?: ReactNode;
  mark: LifeMark;
  /** The line on to the next station: the state the item was in. The last station has none. */
  next?: LifeLine;
  /** How long that state lasted ("208 days"), written in the line's gap. */
  lasted?: ReactNode;
};

type LifeLineMeaning = {
  line: LifeLine;
  /** What the weight means here ("Visible to skaters"), as the key says it. */
  label: string;
};

/** A line's drawing: a zero-height box whose top border is the stroke, centered on the rail. */
const LINE: Record<LifeLine, string> = {
  thin: 'border-t-(length:--stroke-hair) border-solid border-fg3',
  heavy: 'border-t-(length:--stroke-run) border-solid border-fg',
  dashed: 'border-t-(length:--stroke-note) border-dashed border-fg2',
};

/** A mark's drawing, centered on its station. Dots are round; staff acts and today are square. */
const MARK: Record<LifeMark, string> = {
  dot: 'size-(--space-2_5) rounded-full bg-fg2',
  hollow: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg2',
  ring: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg',
  square: 'size-(--space-2_5) bg-fg',
  warn: 'size-(--space-2_5) bg-warn',
  now: 'size-(--space-3_5) bg-fg shadow-[0_0_0_var(--stroke-run)_var(--bg),0_0_0_var(--stroke-now)_var(--fg)]',
  end: 'size-(--space-2_5) rounded-full bg-bg inset-ring inset-ring-fg3',
};

const WHEN_TONE: Partial<Record<LifeMark, string>> = { now: 'text-fg', warn: 'text-warn' };
const TITLE_TONE: Partial<Record<LifeMark, string>> = {
  now: 'text-fg',
  warn: 'text-warn',
  end: 'text-fg3',
};

type LifeStripProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The stations, oldest first; the last is usually today or what a decision would do. */
  stations: readonly LifeStation[];
  /** What each line weight means here, in the key's order. */
  lines: readonly LifeLineMeaning[];
  /** The strip's name for a reader ("Its life"). */
  'aria-label': string;
  /** Draw the key under the strip. Default on. */
  showKey?: boolean;
};

function LifeStrip({
  stations,
  lines,
  showKey = true,
  className,
  'aria-label': label,
  ...props
}: LifeStripProps) {
  const meaning = (line: LifeLine) => lines.find((l) => l.line === line)?.label;
  return (
    <div
      data-slot="life-strip"
      className={cn('flex flex-col gap-(--space-1_5)', className)}
      {...props}
    >
      <ol
        aria-label={label}
        data-slot="life-stations"
        className="m-0 grid list-none auto-cols-[minmax(0,1fr)] grid-flow-col p-0"
      >
        {stations.map((station, i) => {
          const last = i === stations.length - 1;
          const said = station.next === undefined ? undefined : meaning(station.next);
          return (
            <li
              // Stations are a sequence: a station's place is its identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              key={i}
              data-slot="life-station"
              data-mark={station.mark}
              className="flex min-w-0 flex-col items-center gap-[0.4375rem] px-(--space-1) text-center"
            >
              <span
                data-slot="life-when"
                className={cn(
                  'text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg3 uppercase',
                  WHEN_TONE[station.mark],
                )}
              >
                {station.when}
              </span>
              <span
                aria-hidden="true"
                data-slot="life-rail"
                className="relative -mx-(--space-1) my-(--space-0_5) h-(--space-3_5) self-stretch"
              >
                {!last && station.next !== undefined && (
                  // From this station's middle to the next one's: a column on.
                  <span
                    data-slot="life-line"
                    data-line={station.next}
                    className="absolute inset-y-0 left-1/2 flex w-full items-center"
                  >
                    <i className={cn('h-0 min-w-0 flex-1', LINE[station.next])} />
                    <span
                      data-slot="life-lasted"
                      className="min-w-[4.25rem] shrink-0 px-(--space-2) text-center font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg2"
                    >
                      {station.lasted}
                    </span>
                    <i className={cn('h-0 min-w-0 flex-1', LINE[station.next])} />
                  </span>
                )}
                <span
                  data-slot="life-mark"
                  className={cn(
                    'absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2',
                    MARK[station.mark],
                  )}
                />
              </span>
              <span
                data-slot="life-title"
                className={cn(
                  'text-row leading-snug font-medium text-fg2',
                  TITLE_TONE[station.mark],
                )}
              >
                {station.title}
              </span>
              {station.sub != null && (
                <span data-slot="life-sub" className="text-assist leading-list text-fg3">
                  {station.sub}
                </span>
              )}
              {!last && said !== undefined && (
                <span className="sr-only">
                  {`Then: ${said}`}
                  {typeof station.lasted === 'string' ? `, ${station.lasted}` : ''}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {showKey && <LifeKey lines={lines} />}
    </div>
  );
}

/** The strip's key: each line weight and what it means here. A reader hears it at every line. */
function LifeKey({
  lines,
  className,
  ...props
}: Omit<ComponentProps<'ul'>, 'children'> & { lines: readonly LifeLineMeaning[] }) {
  return (
    <ul
      aria-hidden="true"
      data-slot="life-key"
      className={cn('m-0 flex list-none flex-wrap gap-(--space-4_5) p-0', className)}
      {...props}
    >
      {lines.map((l) => (
        <li
          key={l.line}
          data-slot="life-key-item"
          className="inline-flex items-center gap-[0.4375rem] text-assist leading-none text-fg3"
        >
          <i
            data-slot="life-key-swatch"
            data-line={l.line}
            className={cn('h-0 w-(--space-4_5) shrink-0', LINE[l.line])}
          />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

export {
  LifeKey,
  type LifeLine,
  type LifeLineMeaning,
  type LifeMark,
  type LifeStation,
  LifeStrip,
  type LifeStripProps,
};
