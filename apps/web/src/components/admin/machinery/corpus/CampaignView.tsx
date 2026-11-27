import type { Id } from '@skating/convex/dataModel';
import { type ReactNode, type RefObject, useState } from 'react';

import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { historyWhen } from '../../shell/consoleTime';
import { RunActions } from '../actions/RunActions';
import type { RunWrites } from '../actions/useRunWrites';
import { RUN_WORDS as W } from '../words/runWords';
import { HeartbeatStat } from './HeartbeatStat';
import { PassesTable } from './PassesTable';
import type { RunTailProps } from './RunTail';
import { clock, count, elapsedParts, humanize } from './runFormat';
import {
  actionTarget,
  CORE_RULE,
  campaignLivenessAt,
  defaultTailRun,
  headBadge,
  type LivenessRule,
  passesLine,
  runningPass,
  stageSegments,
  tailState,
} from './runModel';
import { RunHead, RunNotes } from './runParts';
import { PathSection } from './runSections';
import type { CampaignView as CampaignData, LivenessView, PassRowView } from './runViews';
import { StageBar } from './StageBar';

/** What a page hands its tail: the run, and how to draw it (the route mounts `LiveRunTail`). */
export type TailFor = Omit<RunTailProps, 'events' | 'more' | 'loadingOlder' | 'onLoadOlder'> & {
  runId: Id<'importRuns'>;
};

export type CampaignViewProps = {
  view: CampaignData;
  /** The page's ticking clock: every age and every late or stalled mark is read against it. */
  now: number;
  timeZone?: string;
  /** Draws a run's tail (`(t) => <LiveRunTail {...t} />` on the page; a story's own fixture). */
  tail: (t: TailFor) => ReactNode;
  /** The writes; absent when the viewer can't write, so no action bar is drawn. */
  writes?: RunWrites | null;
  /** The pane the action keys act in. */
  pane?: RefObject<HTMLElement | null>;
  /** Core's stall rule; a story passes its fake until core's lands. */
  rule?: LivenessRule;
};

/** Which pass a run in the table is (for the tail's end words and its state). */
function passOf(passes: readonly PassRowView[], runId: Id<'importRuns'>): PassRowView | undefined {
  return passes.find((p) => p.run?.id === runId);
}

/**
 * **The campaign page** (board 6.2's right column): the head (the campaign id, *Campaign · full
 * canonical*, the state badge), the four stats (*Passes* with the stage bar, *Batches*,
 * *Elapsed*, *Heartbeat* — the last two ticking with `now`), *Passes* (the plan merged with the
 * runs; a row with a run switches the tail to it), *Live tail*, *What to check* while it is quiet,
 * *Outcome so far* for the running pass, and *Path* (the merge's stages). The action bar floats at
 * the foot from late on. Drawn from props: the route wires the reads, a story the board's fixtures.
 */
export function CampaignView({
  view,
  now,
  timeZone,
  tail,
  writes,
  pane,
  rule = CORE_RULE,
}: CampaignViewProps) {
  const liveness = campaignLivenessAt(view, now, rule);
  // One pane at a time (a phone): the stats one under another, the table scrolling in its own box.
  const narrow = useInspectorContext().narrow === true;
  const status = view.row.status;
  const marked = view.marked !== null;
  const [picked, setPicked] = useState<Id<'importRuns'> | null>(null);
  const tailRun = picked ?? defaultTailRun(view);
  const target = actionTarget(view);
  const badge = headBadge(liveness, status, view.marked?.at ?? null, timeZone);
  const kicker = [
    W.campaign,
    view.row.scope === null ? W.scopeNotRecorded : W.scope(view.row.scope.pass),
    ...(view.deployment === undefined ? [] : [view.isProd ? W.production : view.deployment]),
    ...(view.row.dryRun ? [W.dryRun] : []),
  ].join(' · ');

  return (
    <InspectorFrame
      head={<RunHead title={view.row.title} kicker={kicker} badge={badge} />}
      actions={
        <RunActions
          target={target}
          status={status}
          liveness={liveness}
          marked={marked}
          // A campaign rebuilt from its runs has always ended: never an action on it.
          writes={view.recorded ? writes : null}
          {...(pane !== undefined && { pane })}
        />
      }
    >
      <div
        data-slot="campaign-view"
        data-state={liveness.state}
        className="flex flex-col gap-(--gap-section) px-gutter pt-(--space-3_5)"
      >
        <RunNotes
          marked={view.marked}
          waiting={view.waiting}
          clockSkewMs={view.clockSkewMs}
          {...(timeZone !== undefined && { timeZone })}
        />
        <CampaignStats
          view={view}
          liveness={liveness}
          now={now}
          timeZone={timeZone}
          columns={narrow ? 1 : 4}
        />
        <Section
          data-slot="passes"
          title={W.passesSection}
          level={3}
          {...(!narrow && { end: <End>{W.onYourMachine}</End> })}
        >
          {!view.recorded && <Note data-slot="not-recorded-campaign">{W.notRecordedCampaign}</Note>}
          {view.recorded && view.flags !== null && view.flags.length > 0 && (
            <p data-slot="campaign-flags" className="m-0 text-assist text-fg3">
              {W.flags}{' '}
              <code className="font-(family-name:--family-mono) text-mono-sm text-fg2">
                {view.flags.join(' ')}
              </code>
            </p>
          )}
          <div
            data-slot="passes-scroll"
            className="-mx-gutter overflow-x-auto overscroll-x-contain"
          >
            <PassesTable
              passes={view.passes}
              liveness={liveness}
              selected={tailRun}
              onSelect={setPicked}
              {...(timeZone !== undefined && { timeZone })}
            />
          </div>
        </Section>
        <TailSection
          view={view}
          runId={tailRun}
          liveness={liveness}
          now={now}
          timeZone={timeZone}
          tail={tail}
        />
        <Quiet view={view} liveness={liveness} timeZone={timeZone} />
        <PathSection stages={view.path} />
      </div>
    </InspectorFrame>
  );
}

function End({ children }: { children: ReactNode }) {
  return (
    <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
      {children}
    </span>
  );
}

/** "2 done", for a campaign whose plan wasn't recorded. */
const RUN_WORDS_PLAN = (passes: readonly PassRowView[]) =>
  W.passesDone(passes.filter((p) => p.state === 'done' || p.state === 'dryRun').length);

/** The four stats: Passes (the stage bar), Batches, Elapsed, Heartbeat. */
function CampaignStats({
  view,
  liveness,
  now,
  timeZone,
  columns,
}: {
  view: CampaignData;
  liveness: LivenessView;
  now: number;
  timeZone: string | undefined;
  columns: number;
}) {
  const ended = view.row.status !== 'running' || view.marked !== null;
  const segments = stageSegments(view.passes, liveness, ended, view.marked !== null);
  const line = view.recorded
    ? passesLine(view.passes, liveness)
    : `${RUN_WORDS_PLAN(view.passes)} · ${W.planNotRecorded}`;
  const running = runningPass(view);
  const batches = running?.batches ?? null;
  const end = view.row.finishedAt ?? (ended ? null : now);
  const elapsed = end === null ? null : elapsedParts(end - view.row.startedAt);
  return (
    <StatGrid data-slot="campaign-stats" columns={columns}>
      <div key="passes" data-slot="stat-passes" className="flex min-w-0 flex-col gap-(--space-1)">
        <span className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
          {W.passes}
        </span>
        <StageBar
          label={line}
          className="h-(--type-stat)"
          segments={segments.map((s) => ({ id: s.pass, tone: s.tone, group: s.by }))}
        />
        <span className="text-trim text-assist leading-list text-fg3">{line}</span>
      </div>
      {batches !== null ? (
        <StatTile
          key="batches"
          data-slot="stat-batches"
          label={W.batches}
          value={
            batches.total === null
              ? count(batches.applied)
              : `${count(batches.applied)} / ${count(batches.total)}`
          }
          unit={batches.total === null ? W.batchesSoFar : W.batchesUnit}
          {...(batches.total === null && { sub: W.totalNotRecorded })}
        />
      ) : (
        <StatTile
          key="bodies"
          data-slot="stat-bodies"
          label={W.bodiesLoaded}
          {...(view.row.line.kind === 'campaign' && view.row.line.bodiesLoaded !== null
            ? { value: count(view.row.line.bodiesLoaded), unit: W.bodiesUnit }
            : { value: W.notRecorded, tone: 'dim' as const })}
        />
      )}
      <StatTile
        key="elapsed"
        data-slot="stat-elapsed"
        label={ended ? W.took : W.elapsed}
        value={elapsed === null ? W.notRecorded : <ElapsedValue parts={elapsed} />}
        {...(elapsed === null && { tone: 'dim' as const })}
        sub={W.started(historyWhen(view.row.startedAt, now, timeZone))}
      />
      <HeartbeatStat
        key="heartbeat"
        liveness={liveness}
        status={view.row.status}
        marked={view.marked !== null}
        lastHeardAt={running?.progressAt ?? null}
        {...(timeZone !== undefined && { timeZone })}
      />
    </StatGrid>
  );
}

/** "1 h 14 m": each figure in the value's ink, each unit in the gray slot. */
export function ElapsedValue({ parts }: { parts: ReturnType<typeof elapsedParts> }) {
  return (
    <span data-slot="elapsed">
      {parts.map((p, i) => (
        <span key={p.unit}>
          {i > 0 && ' '}
          {p.value}
          <span className="ms-unit text-row font-light tracking-normal text-fg3">{p.unit}</span>
        </span>
      ))}
    </span>
  );
}

/** *Live tail* (*Log* once it has ended): the shown pass's lines, its name at the rule's end. */
function TailSection({
  view,
  runId,
  liveness,
  now,
  timeZone,
  tail,
}: {
  view: CampaignData;
  runId: Id<'importRuns'>;
  liveness: LivenessView;
  now: number;
  timeZone: string | undefined;
  tail: (t: TailFor) => ReactNode;
}) {
  const running = runningPass(view);
  const isCurrent = running !== null && running.runId === runId;
  const isCampaign = runId === view.row.id;
  const pass = passOf(view.passes, runId);
  // The current pass, or between passes the campaign row, is drawn at the campaign's liveness;
  // any other pass by its own close.
  const live =
    (isCurrent || (isCampaign && running === null)) &&
    view.row.status === 'running' &&
    view.marked === null;
  const state = live
    ? tailState('running', false)
    : isCampaign
      ? tailState(view.row.status, view.marked !== null)
      : pass?.state === 'failed'
        ? 'failed'
        : pass?.run?.finishedAt === null
          ? 'live'
          : 'finished';
  const name = isCampaign ? view.row.title : (pass?.pass ?? view.current?.pass ?? '');
  return (
    <Section
      data-slot="tail"
      title={state === 'live' ? W.liveTail : W.log}
      level={3}
      end={<End>{name}</End>}
    >
      {tail({
        runId,
        state,
        liveness: live ? liveness : { state: 'finished' },
        lastHeardAt: isCurrent ? (running?.progressAt ?? null) : null,
        now,
        ...(timeZone !== undefined && { timeZone }),
      })}
    </Section>
  );
}

/** *What to check* (while quiet) beside *Outcome so far* (the running pass's counts). */
function Quiet({
  view,
  liveness,
  timeZone,
}: {
  view: CampaignData;
  liveness: LivenessView;
  timeZone: string | undefined;
}) {
  const quiet =
    view.row.status === 'running' &&
    view.marked === null &&
    (liveness.state === 'late' ||
      liveness.state === 'stalled' ||
      liveness.state === 'waiting' ||
      liveness.state === 'notRecorded');
  const current = view.current;
  if (!quiet && current === null) return null;
  return (
    <div
      data-slot="quiet"
      className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-(--space-8) gap-y-(--gap-section)"
    >
      {quiet && (
        <Section data-slot="what-to-check" title={W.whatToCheck} level={3}>
          <FactList
            className="grid-cols-[7.5rem_minmax(0,1fr)]"
            rows={[
              { label: W.checkTerminal, value: W.checkTerminalBody },
              {
                label: W.checkLogFile,
                value: (
                  <>
                    {W.checkLogFileBody}{' '}
                    <code className="font-(family-name:--family-mono) text-mono-sm text-fg [overflow-wrap:anywhere]">
                      {view.row.campaignId === null
                        ? W.logPathUnknown
                        : W.logPath(view.row.campaignId)}
                    </code>
                  </>
                ),
              },
              { label: W.checkConvex, value: W.checkConvexBody },
            ]}
          />
        </Section>
      )}
      {current !== null && (
        <Section
          data-slot="outcome-so-far"
          title={runningPass(view) !== null ? W.outcomeSoFar : W.outcomeOf(current.pass)}
          level={3}
          {...(current.progressAt !== null && {
            end: <End>{W.lastFlush(clock(current.progressAt, timeZone))}</End>,
          })}
        >
          {current.counts.length === 0 && current.failures.total === 0 ? (
            <p className="m-0 text-assist text-fg3">{W.noCounts}</p>
          ) : (
            <FactList
              rows={[
                ...current.counts.map((c) => ({
                  key: c.name,
                  label: humanize(c.name),
                  value: (
                    <span className="font-(family-name:--family-mono) text-mono-sm text-fg">
                      {count(c.value)}
                    </span>
                  ),
                })),
                {
                  key: 'failures',
                  label: W.failures,
                  value: (
                    <span
                      data-slot="outcome-failures"
                      className="font-(family-name:--family-mono) text-mono-sm text-fg"
                    >
                      {current.failures.total === 0
                        ? W.failuresNone
                        : [
                            W.failuresStored(current.failures.stored),
                            ...(current.failures.keys[0] !== undefined
                              ? [
                                  W.failuresMore(
                                    current.failures.keys[0],
                                    current.failures.total - 1,
                                  ),
                                ]
                              : []),
                          ].join(' · ')}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Section>
      )}
    </div>
  );
}
