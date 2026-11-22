import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

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
  const fit = useStationsFit();
  const meaning = (line: LifeLine) => lines.find((l) => l.line === line)?.label;
  // The copy's parts carry `measure-` slots, so nothing that counts the strip's parts counts them.
  const slot = (name: string, copy: boolean) => (copy ? `measure-${name}` : name);
  const across = (copy: boolean) => (
    <ol
      aria-label={copy ? undefined : label}
      data-slot={slot('life-stations', copy)}
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
            data-slot={slot('life-station', copy)}
            data-mark={station.mark}
            className="flex min-w-0 flex-col items-center gap-[0.4375rem] px-(--space-1) text-center"
          >
            <span
              data-slot={slot('life-when', copy)}
              className={cn(
                'text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg3 uppercase',
                WHEN_TONE[station.mark],
              )}
            >
              {station.when}
            </span>
            <span
              aria-hidden="true"
              data-slot={slot('life-rail', copy)}
              className="relative -mx-(--space-1) my-(--space-0_5) h-(--space-3_5) self-stretch"
            >
              {!last && station.next !== undefined && (
                // From this station's middle to the next one's: a column on.
                <span
                  data-slot={slot('life-line', copy)}
                  data-line={station.next}
                  className="absolute inset-y-0 left-1/2 flex w-full items-center"
                >
                  <i className={cn('h-0 min-w-0 flex-1', LINE[station.next])} />
                  <span
                    data-slot={slot('life-lasted', copy)}
                    className="min-w-[4.25rem] shrink-0 px-(--space-2) text-center font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg2"
                  >
                    {station.lasted}
                  </span>
                  <i className={cn('h-0 min-w-0 flex-1', LINE[station.next])} />
                </span>
              )}
              <span
                data-slot={slot('life-mark', copy)}
                className={cn(
                  'absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2',
                  MARK[station.mark],
                )}
              />
            </span>
            <span
              data-slot={slot('life-title', copy)}
              className={cn('text-row leading-snug font-medium text-fg2', TITLE_TONE[station.mark])}
            >
              {station.title}
            </span>
            {station.sub != null && (
              <span
                data-slot={slot('life-sub', copy)}
                className="text-assist leading-list text-fg3"
              >
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
  );
  // The strip as drawn across, unseen and inert, clipped to nothing: measured after every commit
  // and whenever its box changes, so the strip seen is never redrawn to be measured.
  const copy = (
    <div
      aria-hidden="true"
      inert
      data-slot="life-strip-measure"
      className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
    >
      {across(true)}
    </div>
  );
  if (!fit.fits) {
    return (
      <div
        ref={fit.root}
        data-slot="life-strip"
        data-narrow=""
        className={cn('relative', className)}
        {...props}
      >
        {copy}
        <LifeList stations={stations} lines={lines} showKey={showKey} aria-label={label} />
      </div>
    );
  }
  return (
    <div
      ref={fit.root}
      data-slot="life-strip"
      className={cn('relative flex flex-col gap-(--space-1_5)', className)}
      {...props}
    >
      {copy}
      {across(false)}
      {showKey && <LifeKey lines={lines} />}
    </div>
  );
}

/**
 * Whether every station fits across: each date on one line inside its column, and each line long
 * enough to show on both sides of how long it lasted (at least a mark's width each side). Measured
 * on the unseen copy, at the strip's own width.
 */
function useStationsFit() {
  const root = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const check = useRef<() => void>(() => {});
  check.current = () => {
    const copy = root.current?.querySelector<HTMLElement>('[data-slot="measure-life-stations"]');
    // (The copy is always drawn; the guard is for the type.)
    /* v8 ignore next */
    if (copy == null) return;
    const marks = [...copy.querySelectorAll<HTMLElement>('[data-slot="measure-life-mark"]')];
    const mark = Math.max(0, ...marks.map((m) => m.getBoundingClientRect().width));
    const crowded =
      // A date wider than its station's content box (its line runs on past the station by design,
      // so the station's own overflow says nothing).
      [...copy.querySelectorAll<HTMLElement>('[data-slot="measure-life-station"]')].some((li) => {
        const when = li.querySelector<HTMLElement>('[data-slot="measure-life-when"]');
        const pad = getComputedStyle(li);
        const room = li.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
        return when !== null && when.getBoundingClientRect().width > room + 0.5;
      }) ||
      [...copy.querySelectorAll<HTMLElement>('[data-slot="measure-life-line"] > i')].some(
        (side) => side.getBoundingClientRect().width < mark - 0.5,
      );
    setFits(!crowded);
  };
  // After every commit: new words (a relabel, another item in the same slot) re-decide the layout,
  // as a new count or a new box does. Cheap — a few reads of the unseen copy — and a decision that
  // stands sets nothing.
  useLayoutEffect(() => check.current());
  // The box, and a late web font, re-decide too.
  useLayoutEffect(() => {
    const el = root.current;
    // (The root is rendered with the effect; the guard is for the type.)
    /* v8 ignore next */
    if (el == null) return;
    const run = () => check.current();
    const observer = new ResizeObserver(run);
    observer.observe(el);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) run();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
  return { root, fits };
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

/**
 * **Its life, top to bottom** (the record sheet on a narrow screen, 8.9): the kit
 * `LifeStrip`'s stations and lines, read down the page instead of across — the date in a column of
 * its own, the rail beside it, what happened and who beside that. Same stations, same marks, same
 * line weights and the same key, so a reader learns one strip.
 *
 * - **The line under a station is the state it left the item in**, drawn down the rail to the next
 *   station; how long it lasted follows the station's words.
 */

/** A line down the rail: a zero-width box whose left border is the stroke. */
const LIST_LINE: Record<LifeLine, string> = {
  thin: 'border-l-(length:--stroke-hair) border-solid border-fg3',
  heavy: 'border-l-(length:--stroke-run) border-solid border-fg',
  dashed: 'border-l-(length:--stroke-note) border-dashed border-fg2',
};

const LIST_MARK: Record<LifeStation['mark'], string> = {
  dot: 'size-(--space-2_5) rounded-full bg-fg2',
  hollow: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg2',
  ring: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg',
  square: 'size-(--space-2_5) bg-fg',
  warn: 'size-(--space-2_5) bg-warn',
  now: 'size-(--space-2_5) bg-fg',
  end: 'size-(--space-2_5) rounded-full bg-bg inset-ring inset-ring-fg3',
};

const LIST_TONE: Partial<Record<LifeStation['mark'], string>> = {
  now: 'text-fg',
  warn: 'text-warn',
  end: 'text-fg3',
};

type LifeListProps = Omit<ComponentProps<'div'>, 'children'> & {
  stations: readonly LifeStation[];
  lines: readonly LifeLineMeaning[];
  'aria-label': string;
  showKey?: boolean;
};

function LifeList({
  stations,
  lines,
  showKey = true,
  className,
  'aria-label': label,
  ...props
}: LifeListProps) {
  const meaning = (line: LifeLine) => lines.find((l) => l.line === line)?.label;
  return (
    <div
      data-slot="life-list"
      className={cn('flex flex-col gap-(--space-2)', className)}
      {...props}
    >
      <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
        {stations.map((station, i) => {
          const last = i === stations.length - 1;
          const said = station.next === undefined ? undefined : meaning(station.next);
          return (
            <li
              // Stations are a sequence: a station's place is its identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              key={i}
              data-slot="life-list-station"
              data-mark={station.mark}
              className="grid grid-cols-[6.75rem_var(--space-3_5)_minmax(0,1fr)] gap-x-(--space-2_5)"
            >
              <span
                className={cn(
                  'pt-(--space-0_5) text-kick leading-none font-semibold tracking-kick text-fg3 uppercase',
                  station.mark === 'now' && 'text-fg',
                  station.mark === 'warn' && 'text-warn',
                )}
              >
                {station.when}
              </span>
              <span aria-hidden="true" className="relative flex justify-center">
                <span
                  className={cn(
                    'relative z-1 mt-(--space-0_5) block shrink-0',
                    LIST_MARK[station.mark],
                  )}
                />
                {!last && station.next !== undefined && (
                  <i
                    data-slot="life-list-line"
                    data-line={station.next}
                    className={cn(
                      'absolute top-(--space-3_5) bottom-0 left-1/2 w-0 -translate-x-1/2',
                      LIST_LINE[station.next],
                    )}
                  />
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-(--space-0_5) pb-(--space-3)">
                <span
                  className={cn(
                    'text-row leading-snug font-medium text-fg2',
                    LIST_TONE[station.mark],
                  )}
                >
                  {station.title}
                </span>
                {station.sub != null && (
                  <span className="text-assist leading-list text-fg3">{station.sub}</span>
                )}
                {!last && station.lasted != null && (
                  <span className="font-(family-name:--family-mono) text-mono-sm leading-none text-fg3">
                    {station.lasted}
                  </span>
                )}
                {!last && said !== undefined && <span className="sr-only">{`Then: ${said}`}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {showKey && <LifeKey lines={lines} />}
    </div>
  );
}

export {
  LifeKey,
  type LifeLine,
  type LifeLineMeaning,
  LifeList,
  type LifeListProps,
  type LifeMark,
  type LifeStation,
  LifeStrip,
  type LifeStripProps,
};
