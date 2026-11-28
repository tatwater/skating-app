import type { ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/kit/collapsible';
import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { StatusDot, type StatusDotTone } from '@/components/kit/status-dot';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { shortAge } from '@/lib/ages';
import { cn } from '@/lib/utils';

import { InspectorFrame, InspectorHeadEnd } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { clock, tookWords } from '../corpus/runFormat';
import {
  type AttemptView,
  attemptFailed,
  capturedAtOf,
  dayClock,
  type GranuleView,
  granulePlatform,
  lastExit,
  openAttempt,
  shortDayWords,
} from './imageryModel';
import * as W from './imageryWords';

/**
 * **A granule's detail** (board 6.4's right column) — the head (the platform and its capture day,
 * the granule's id, its state badge), the four stats (*Captured*, *In the catalog*, *Queued*, and
 * by its state *Exit*, *Landed*, *Settled*, *Machine up* or *Waiting*), **Attempts** (one row a
 * Machine: which, when, how long in machine time, its exit and outcome; pressing one shows its
 * log), the **Machine log** of the open attempt (a failed attempt's open, a successful one's
 * collapsed behind *Show the log*, ruling 14), and **What to check** when the facts say something.
 *
 * - **A granule from before attempts were recorded** says so beside the count and the last error it
 *   kept, never an empty table read as none.
 * - **An old image kept no cutter log**: the log section says so, and still shows Fly's word.
 * - **An empty cut** says the cutter's own reason; never cloud (the pipeline cuts every pass).
 *
 * The log itself is the caller's (`log`): the route's live read, a story's fixture.
 */
export type GranuleDetailProps = {
  view: GranuleView;
  now: number;
  timeZone?: string;
  /** The attempt whose log shows (the URL's), or `null` for the newest. */
  attempt: number | null;
  onAttempt: (attempt: number) => void;
  /** The open attempt's log. */
  log: (attempt: AttemptView, failed: boolean) => ReactNode;
  /** When attempts began to be recorded (the season's *Counted from*), for an older granule. */
  recordedFrom?: number | null;
  /** The floating action bar. */
  actions?: ReactNode;
};

export function GranuleDetail({
  view,
  now,
  timeZone,
  attempt,
  onAttempt,
  log,
  recordedFrom = null,
  actions,
}: GranuleDetailProps) {
  const { row, attempts } = view;
  const narrow = useInspectorContext().narrow === true;
  const open = openAttempt(attempts, attempt);
  const capturedAt = capturedAtOf(row);
  const status = row.status;

  return (
    <InspectorFrame
      head={
        <>
          <h2
            data-slot="granule-title"
            className="m-0 min-w-0 shrink-0 text-assist leading-none font-medium tracking-kick whitespace-nowrap text-fg uppercase"
          >
            {granulePlatform(row)}
            {capturedAt !== null && ` · ${shortDayWords(capturedAt, timeZone)}`}
          </h2>
          <InspectorHeadEnd>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    data-slot="granule-id"
                    className="max-w-[18rem] truncate font-(family-name:--family-mono) text-mono-sm text-fg3 uppercase"
                  />
                }
              >
                {row.granuleId}
              </TooltipTrigger>
              <TooltipContent>{row.granuleId}</TooltipContent>
            </Tooltip>
            <Badge
              data-slot="granule-state"
              data-tone={status}
              {...(status === 'failed'
                ? { tone: 'bad' as const }
                : status === 'spawned'
                  ? { variant: 'live' as const }
                  : { variant: 'outline' as const })}
            >
              {W.badgeWords(status, row.attempts)}
            </Badge>
          </InspectorHeadEnd>
        </>
      }
      actions={actions}
    >
      <div
        data-slot="granule-detail"
        data-status={status}
        className="flex flex-col gap-(--gap-section) px-gutter pt-(--space-3_5)"
      >
        <StatGrid data-slot="granule-stats" columns={narrow ? 2 : 4}>
          <StatTile
            key="captured"
            label={W.CAPTURED}
            value={capturedAt === null ? W.NOT_RECORDED : clock(capturedAt, timeZone)}
            {...(capturedAt === null && { tone: 'dim' as const })}
            sub={capturedAt === null ? row.capturedAt : shortDayWords(capturedAt, timeZone)}
          />
          <StatTile
            key="catalog"
            data-slot="stat-catalog"
            label={W.IN_THE_CATALOG}
            value={row.catalogedAt === null ? W.NOT_RECORDED : clock(row.catalogedAt, timeZone)}
            {...(row.catalogedAt === null && { tone: 'dim' as const })}
            {...(row.catalogedAt !== null && {
              sub:
                capturedAt === null
                  ? shortDayWords(row.catalogedAt, timeZone)
                  : W.afterThePass(
                      shortDayWords(row.catalogedAt, timeZone),
                      shortAge(row.catalogedAt - capturedAt),
                    ),
            })}
          />
          <StatTile
            key="queued"
            label={W.QUEUED}
            value={clock(row.queuedAt, timeZone)}
            sub={W.byThePoll(shortDayWords(row.queuedAt, timeZone))}
          />
          {fourthStat(view, now, timeZone)}
        </StatGrid>

        <Section data-slot="attempts" title={W.ATTEMPTS} level={3} count={attempts.length}>
          {/* Tried before attempts were recorded: said, and beside the attempts recorded since. */}
          {view.before8b && (
            <Note data-slot="attempts-before">
              {W.attemptsBefore(
                recordedFrom === null ? null : shortDayWords(recordedFrom, timeZone),
              )}{' '}
              {W.keptCount(row.attempts, row.lastError)}
            </Note>
          )}
          {attempts.length === 0 ? (
            !view.before8b && (
              <p data-slot="attempts-none" className="m-0 text-assist text-fg3">
                {W.NO_ATTEMPTS_YET}
              </p>
            )
          ) : (
            // Its columns never squeeze to a phone: below its width the table scrolls in its own box.
            <div
              data-slot="attempts-scroll"
              className="-mx-gutter overflow-x-auto overscroll-x-contain"
            >
              <AttemptsTable
                attempts={attempts}
                selected={open?.attempt ?? null}
                onSelect={onAttempt}
                timeZone={timeZone}
              />
            </div>
          )}
        </Section>

        {open !== null && <MachineLog attempt={open} log={log} narrow={narrow} />}

        <WhatToCheck attempts={attempts} refusals={row.refusals} />
      </div>
    </InspectorFrame>
  );
}

/** The fourth stat, by what the granule's state makes worth saying. */
function fourthStat(view: GranuleView, now: number, timeZone?: string): ReactNode {
  const { row, attempts } = view;
  switch (row.status) {
    case 'failed': {
      const exit = lastExit(attempts);
      return (
        <StatTile
          key="exit"
          data-slot="stat-exit"
          label={<span className="text-bad">{W.EXIT}</span>}
          value={exit === null ? W.NOT_RECORDED : String(exit.code)}
          tone={exit === null ? 'dim' : 'bad'}
          sub={exit === null ? (row.lastError ?? W.NO_EXIT) : W.exitWords(exit.code, exit.oom)}
        />
      );
    }
    case 'landed':
    case 'empty':
      return (
        <StatTile
          key="settled"
          data-slot="stat-settled"
          label={row.status === 'landed' ? W.LANDED_AT : W.SETTLED_AT}
          value={row.settledAt === null ? W.NOT_RECORDED : clock(row.settledAt, timeZone)}
          {...(row.settledAt === null
            ? { tone: 'dim' as const }
            : { sub: shortDayWords(row.settledAt, timeZone) })}
        />
      );
    case 'spawned':
      return (
        <StatTile
          key="up"
          data-slot="stat-up"
          label={W.MACHINE_UP}
          value={row.spawnedAt === null ? W.NOT_RECORDED : shortAge(now - row.spawnedAt)}
          {...(row.spawnedAt === null
            ? { tone: 'dim' as const }
            : { sub: clock(row.spawnedAt, timeZone) })}
        />
      );
    case 'queued':
      return (
        <StatTile
          key="waiting"
          data-slot="stat-waiting"
          label={W.WAITING}
          value={shortAge(now - row.queuedAt)}
          sub={W.sinceQueued}
        />
      );
  }
}

/** The attempts: one row a Machine, the open one's log below (a press, or ⏎, shows another). */
function AttemptsTable({
  attempts,
  selected,
  onSelect,
  timeZone,
}: {
  attempts: readonly AttemptView[];
  selected: number | null;
  onSelect: (attempt: number) => void;
  timeZone?: string;
}) {
  return (
    <Table data-slot="attempts-table" className="min-w-[38rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-(--space-4) pe-0">
            <span className="sr-only">{W.OUTCOME}</span>
          </TableHead>
          <TableHead>{W.ATTEMPT}</TableHead>
          <TableHead>{W.MACHINE}</TableHead>
          <TableHead>{W.STARTED}</TableHead>
          <TableHead align="end">{W.TOOK}</TableHead>
          <TableHead align="end">{W.EXIT}</TableHead>
          <TableHead>{W.OUTCOME}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...attempts]
          .sort((a, b) => a.attempt - b.attempt)
          .map((a) => {
            const verdict = W.VERDICT_WORDS[a.verdict];
            const dot: StatusDotTone =
              verdict.tone === 'bad' ? 'bad' : verdict.tone === 'warn' ? 'warn' : 'quiet';
            const started = a.startedAt ?? a.spawnedAt;
            const took =
              a.machineMs === null
                ? '—'
                : a.machineMsFrom === 'settle'
                  ? W.about(tookWords(a.machineMs))
                  : tookWords(a.machineMs);
            return (
              <TableRow
                key={a.id}
                data-slot="attempt-row"
                data-attempt={a.attempt}
                data-verdict={a.verdict}
                clickable
                selected={a.attempt === selected}
                onClick={() => onSelect(a.attempt)}
              >
                <TableCell className="w-(--space-4) pe-0">
                  <StatusDot tone={dot} />
                </TableCell>
                <TableCell lead>{a.attempt}</TableCell>
                <TableCell mono>{a.machineId ?? a.machineName}</TableCell>
                <TableCell mono className="whitespace-nowrap">
                  {dayClock(started, timeZone)}
                </TableCell>
                <TableCell align="end" mono className="whitespace-nowrap">
                  {took}
                </TableCell>
                <TableCell align="end" mono>
                  {a.exitCode ?? '—'}
                </TableCell>
                <TableCell
                  data-slot="attempt-outcome"
                  className={cn(
                    'font-(family-name:--family-mono) text-mono-sm',
                    verdict.tone === 'bad' && 'text-bad',
                    verdict.tone === 'warn' && 'text-warn',
                    verdict.tone === 'fg' && 'text-fg',
                  )}
                >
                  {verdict.words}
                </TableCell>
              </TableRow>
            );
          })}
      </TableBody>
    </Table>
  );
}

/**
 * The open attempt's machine log: open when the cut didn't land, collapsed behind *Show the log*
 * when it did (ruling 14). What the record says when there are no lines to read: still being
 * collected, a cut still running, or a cutter too old to keep its own (Fly's word still shows).
 */
function MachineLog({
  attempt,
  log,
  narrow,
}: {
  attempt: AttemptView;
  log: (attempt: AttemptView, failed: boolean) => ReactNode;
  narrow: boolean;
}) {
  const failed = attemptFailed(attempt.verdict);
  // No Machine was ever confirmed (Fly turned the spawn down, or its answer never came): nothing
  // ran that the pump knows of, so there is no log — never "an image from before logs were kept".
  const noMachine = attempt.machineId === null && attempt.verdict !== 'cutting';
  // A phone keeps the attempt's number alone: the corner never pushes the page sideways.
  const corner =
    narrow || noMachine
      ? W.attemptNumber(attempt.attempt)
      : W.logOrigins(
          attempt.attempt,
          W.logFrom(attempt.log, attempt.verdict === 'landed' || attempt.verdict === 'empty'),
        );
  const cornerNode = (
    <span className="font-(family-name:--family-mono) text-mono-sm text-fg3 uppercase">
      {corner}
    </span>
  );
  let body: ReactNode;
  if (attempt.verdict === 'cutting') {
    body = <p className="m-0 text-assist text-fg3">{W.LOG_CUTTING}</p>;
  } else if (noMachine) {
    body = (
      <Note data-slot="machine-log-note">
        {attempt.verdict === 'refused' ? W.LOG_REFUSED : W.LOG_UNCONFIRMED}
      </Note>
    );
  } else if (attempt.log === 'pending') {
    body = <p className="m-0 text-assist text-fg3">{W.LOG_PENDING}</p>;
  } else {
    const note =
      attempt.log === 'none' ? W.LOG_NONE : attempt.log === 'missing' ? W.LOG_MISSING : null;
    const lines = log(attempt, failed);
    body = (
      <div className="flex flex-col gap-(--space-3)">
        {note !== null && <Note data-slot="machine-log-note">{note}</Note>}
        {failed ? (
          lines
        ) : (
          <Collapsible data-slot="machine-log-collapsed">
            <CollapsibleTrigger>{W.SHOW_LOG}</CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-(--space-3)">{lines}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    );
  }
  return (
    <Section
      data-slot="machine-log"
      data-open={failed ? '' : undefined}
      title={W.MACHINE_LOG}
      level={3}
      end={cornerNode}
    >
      {body}
    </Section>
  );
}

function WhatToCheck({
  attempts,
  refusals,
}: {
  attempts: readonly AttemptView[];
  refusals: number;
}) {
  const rows = W.whatToCheck(attempts, refusals);
  if (rows.length === 0) return null;
  return (
    <Section data-slot="what-to-check" title={W.WHAT_TO_CHECK} level={3}>
      <FactList
        className="grid-cols-[7.5rem_minmax(0,1fr)]"
        rows={rows.map((r) => ({ label: r.label, value: r.body }))}
      />
    </Section>
  );
}
