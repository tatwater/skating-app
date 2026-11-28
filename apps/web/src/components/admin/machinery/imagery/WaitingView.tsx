import { type ReactNode, type RefObject, useState } from 'react';

import { ActionBar } from '@/components/kit/action-bar';
import { Badge } from '@/components/kit/badge';
import { FactList } from '@/components/kit/fact-list';
import { Section } from '@/components/kit/section-slug';
import { Switch } from '@/components/kit/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { cn } from '@/lib/utils';

import { SentinelLows } from '../../season/SentinelLows';
import type { LowsState } from '../../season/sentinelLowsModel';
import {
  dayWords,
  fahrenheit,
  fahrenheitSpan,
  type ImageryPageView,
  isoDayWords,
  type LowsFacts,
  lineCrossed,
  relativeDay,
  type SentinelRow,
} from './imageryModel';
import * as W from './imageryWords';

/**
 * **The waiting page** (boards *6.4 Imagery | Waiting for Cold* and *| Line Crossed*): imagery not
 * started. Left, the sentinels: their overnight lows (the Overview's `SentinelLows`, reused whole),
 * how close each has come to the imagery line (or, once crossed, each against it), and what the
 * watch waits for (or what happened). Right, **the start panel**: the switch, what starting does in
 * order, what it costs in machine-minutes (never dollars, ruling 6), and *Start imagery*.
 *
 * ⚠ **Air temperatures at named sites, never ice (D3).** The line is the watch's trigger for a
 * camera, not a claim that any lake froze or will; a night counts once observed, never forecast.
 *
 * - **Crossed**: the panel's head says *Ready to start* and the foot's button is the primary one.
 * - **No watch, or Fly and R2 unset**: the switch and the button are drawn disabled, and the panel
 *   says why in words — never a refusal waiting to happen.
 */
export type WaitingViewProps = {
  view: ImageryPageView;
  lows: LowsState;
  rows: readonly SentinelRow[];
  facts: LowsFacts | null;
  now: number;
  timeZone?: string;
  /** *Start imagery*; absent when the viewer can't write (no switch, no button). */
  onStart?: () => Promise<boolean>;
  /** The pane the start key acts in. */
  pane?: RefObject<HTMLElement | null>;
  narrow?: boolean;
};

export function WaitingView({
  view,
  lows,
  rows,
  facts,
  now,
  timeZone,
  onStart,
  pane,
  narrow = false,
}: WaitingViewProps) {
  const crossed = lineCrossed(view.watch);
  return (
    <div
      data-slot="imagery-waiting"
      data-crossed={crossed ? '' : undefined}
      className={cn(
        'min-h-0 min-w-0 flex-1',
        narrow
          ? 'flex flex-col overflow-y-auto'
          : 'grid grid-cols-[minmax(0,1fr)_var(--size-sheet-sm)]',
      )}
    >
      <div
        data-slot="imagery-sentinels"
        className={cn(
          'flex min-w-0 flex-col gap-(--gap-section) px-gutter pt-(--space-4) pb-(--space-14)',
          !narrow && 'min-h-0 overflow-y-auto overscroll-contain',
        )}
      >
        <SentinelLows state={lows} />
        <SentinelTable view={view} rows={rows} crossed={crossed} timeZone={timeZone} />
        <WatchWords view={view} facts={facts} crossed={crossed} now={now} timeZone={timeZone} />
      </div>
      <StartPanel
        view={view}
        crossed={crossed}
        facts={facts}
        narrow={narrow}
        {...(onStart !== undefined && { onStart })}
        {...(pane !== undefined && { pane })}
      />
    </div>
  );
}

/** *How close each sentinel has come* (waiting) or *Each sentinel against the line* (crossed). */
function SentinelTable({
  view,
  rows,
  crossed,
  timeZone,
}: {
  view: ImageryPageView;
  rows: readonly SentinelRow[];
  crossed: boolean;
  timeZone?: string;
}) {
  const since = view.watch?.openedAt ?? null;
  const end = (
    <span className="font-(family-name:--family-mono) text-mono-sm text-fg3 uppercase">
      {since === null ? W.OBSERVED_LOWS : W.observedSince(dayWords(since, timeZone))}
    </span>
  );
  return (
    <Section
      data-slot="sentinel-table"
      title={crossed ? W.AGAINST_THE_LINE : W.HOW_CLOSE}
      level={3}
      end={end}
    >
      {rows.length === 0 ? (
        <p className="m-0 text-assist text-fg3">{W.NO_LOWS}</p>
      ) : (
        <div
          data-slot="sentinel-scroll"
          className="-mx-gutter overflow-x-auto overscroll-x-contain"
        >
          <Table className="min-w-[36rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{W.SENTINEL}</TableHead>
                <TableHead align="end">{W.LAST_NIGHT}</TableHead>
                <TableHead align="end">{W.COLDEST}</TableHead>
                <TableHead align="end">{W.nightsAtOrBelow('32')}</TableHead>
                <TableHead align="end">{crossed ? W.AGAINST_LINE : W.SHORT_OF_LINE}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key} data-slot="sentinel-row">
                  <TableCell lead>{r.name}</TableCell>
                  <TableCell align="end" mono>
                    {r.lastC === null ? '—' : W.degreesF(fahrenheit(r.lastC))}
                  </TableCell>
                  <TableCell align="end" mono>
                    {r.coldest === null ? (
                      '—'
                    ) : (
                      <span className="flex flex-col items-end">
                        <span>{W.degreesF(fahrenheit(r.coldest.c))}</span>
                        <span className="font-(family-name:--family-sans) text-assist text-fg3">
                          {isoDayWords(r.coldest.on)}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell align="end" mono>
                    {W.nightsOf(r.atOrBelow, r.measured)}
                  </TableCell>
                  <TableCell
                    align="end"
                    mono
                    data-slot="sentinel-short"
                    className={cn(r.shortC !== null && r.shortC <= 0 && 'text-acc')}
                  >
                    {r.shortC === null
                      ? '—'
                      : r.shortC <= 0
                        ? W.belowBy(fahrenheitSpan(r.shortC))
                        : crossed
                          ? W.shortBy(fahrenheitSpan(r.shortC))
                          : W.degreesF(fahrenheitSpan(r.shortC))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

/** *What it's waiting for* (the line, then, the thresholds) or, crossed, *What happened*. */
function WatchWords({
  view,
  facts,
  crossed,
  now,
  timeZone,
}: {
  view: ImageryPageView;
  facts: LowsFacts | null;
  crossed: boolean;
  now: number;
  timeZone?: string;
}) {
  const watch = view.watch;
  const lineF = watch === null ? null : fahrenheit(watch.lineC);
  const rows: { label: string; value: ReactNode }[] = [];
  if (crossed) {
    // The watch's own crossing night when the lows aren't read: never the coldest night.
    const on = facts?.crossed?.on ?? watch?.crossed?.on ?? null;
    const sites = facts?.crossed?.sites ?? watch?.crossed?.sites ?? [];
    rows.push({
      label: W.THE_LINE,
      value:
        on === null
          ? W.CROSSED
          : sites.length > 0
            ? W.lineCrossedOn(
                isoDayWords(on),
                sites.map((s) => `${s.name} reached ${W.degreesF(fahrenheit(s.lowC))}`).join(', '),
              )
            : W.lineCrossedOnDay(isoDayWords(on)),
    });
    rows.push({
      label: W.THEN,
      value:
        watch?.staffEmailAt == null
          ? W.THEN_NOT_SENT
          : W.thenSent(
              `${relativeDay(watch.staffEmailAt, now, timeZone).toLowerCase()} at ${new Intl.DateTimeFormat(
                'en-GB',
                { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone },
              ).format(watch.staffEmailAt)}`,
            ),
    });
  } else {
    rows.push({ label: W.THE_LINE, value: lineF === null ? W.NOT_RECORDED : W.lineRule(lineF) });
    rows.push({ label: W.THEN, value: W.THEN_WAITING });
  }
  rows.push({ label: W.THRESHOLDS, value: W.THRESHOLDS_BODY });
  return (
    <Section data-slot="watch-words" title={crossed ? W.WHAT_HAPPENED : W.WAITING_FOR} level={3}>
      <FactList className="grid-cols-[7.5rem_minmax(0,1fr)]" rows={rows} />
    </Section>
  );
}

/**
 * The start panel: its head (and *Ready to start* once crossed), the switch with what it means now,
 * what starting does in order, what it costs, and the foot's *Start imagery*. The switch and the
 * button send the same write; a refusal is a toast (the write path's).
 */
function StartPanel({
  view,
  crossed,
  facts,
  narrow,
  onStart,
  pane,
}: {
  view: ImageryPageView;
  crossed: boolean;
  facts: LowsFacts | null;
  narrow: boolean;
  onStart?: () => Promise<boolean>;
  pane?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const blocked = view.state === 'noWatch' || !view.configured;
  const start = () => {
    if (onStart === undefined || busy || blocked) return;
    setBusy(true);
    void onStart().then(() => setBusy(false));
  };
  const on = facts?.crossed?.on ?? view.watch?.crossed?.on ?? null;
  const said =
    view.state === 'noWatch'
      ? W.START_NO_WATCH
      : !view.configured
        ? W.START_UNCONFIGURED
        : crossed
          ? W.startCrossed(on === null ? '' : isoDayWords(on))
          : W.START_WAITING;
  return (
    <aside
      data-slot="start-panel"
      aria-label={W.START_TITLE}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col border-0 border-solid border-line',
        narrow ? 'border-t' : 'border-s',
      )}
    >
      <div className="flex h-[calc(var(--space-8)+var(--space-1))] shrink-0 items-center gap-(--space-2_5) border-0 border-b border-solid border-line px-gutter">
        <h2 className="m-0 text-assist leading-none font-medium tracking-kick whitespace-nowrap text-fg uppercase">
          {W.START_TITLE}
        </h2>
        {crossed && !blocked && (
          <Badge data-slot="ready-to-start" className="ms-auto" tone="lit">
            {W.READY_TO_START}
          </Badge>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-(--gap-section) overflow-y-auto overscroll-contain px-gutter pt-(--space-4) pb-(--space-20)">
        <div
          data-slot="start-switch"
          className={cn(
            'flex items-start gap-(--space-4)',
            crossed && !blocked && 'border border-solid border-line2 p-(--space-4)',
          )}
        >
          <Switch
            aria-label={W.START_TITLE}
            checked={busy}
            disabled={onStart === undefined || blocked || busy}
            onCheckedChange={(next) => {
              if (next) start();
            }}
            className="mt-(--space-1)"
          />
          <div className="flex min-w-0 flex-col gap-(--space-1_5)">
            <span className="font-(family-name:--family-mono) text-stat leading-none font-medium tracking-disp text-fg uppercase">
              {W.OFF}
            </span>
            <p data-slot="start-said" className="m-0 text-assist leading-list text-fg2">
              {said}
            </p>
          </div>
        </div>
        <Section data-slot="starting-steps" title={W.WHAT_STARTING_DOES} level={3}>
          <ol className="m-0 flex list-none flex-col p-0">
            {W.STARTING_STEPS.map((s, i) => (
              <li
                key={s.head}
                className="grid grid-cols-[var(--space-7)_minmax(0,1fr)] gap-y-(--space-1) border-0 border-b-(length:--stroke-hair) border-dotted border-line py-(--space-2_5) last:border-b-0"
              >
                <span className="font-(family-name:--family-mono) text-mono-sm text-fg3">
                  {i + 1}
                </span>
                <span className="text-row font-medium text-fg">{s.head}</span>
                <span className="col-start-2 text-assist leading-list text-fg3">{s.body}</span>
              </li>
            ))}
          </ol>
        </Section>
        <Section data-slot="start-costs" title={W.WHAT_IT_COSTS} level={3}>
          <FactList
            className="grid-cols-[6.5rem_minmax(0,1fr)]"
            rows={[
              { label: W.COST_FLY, value: W.COST_FLY_BODY },
              { label: W.COST_CATALOGS, value: W.COST_CATALOGS_BODY },
              { label: W.COST_STOPPING, value: W.COST_STOPPING_BODY },
            ]}
          />
        </Section>
      </div>
      {onStart !== undefined && (
        <ActionBar
          data-slot="start-actions"
          aria-label={W.START_TITLE}
          groups={[
            {
              id: 'start',
              items: [
                {
                  id: 'start',
                  label: W.START_TITLE,
                  hotkey: 'S',
                  what: W.STARTING_STEPS[0]?.body ?? '',
                  loading: busy,
                  disabled: blocked,
                  onPress: start,
                },
              ],
            },
          ]}
          {...(pane !== undefined && { pane })}
        />
      )}
    </aside>
  );
}
