import type { Id } from '@skating/convex/dataModel';
import type { ReactNode, RefObject } from 'react';

import { FactList } from '@/components/kit/fact-list';
import { RunError } from '@/components/kit/log';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';

import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { historyWhen } from '../../shell/consoleTime';
import { RunActions } from '../actions/RunActions';
import type { RunWrites } from '../actions/useRunWrites';
import { RUN_WORDS as W } from '../words/runWords';
import { ElapsedValue, type TailFor } from './CampaignView';
import { HeartbeatStat } from './HeartbeatStat';
import { count, elapsedParts, headlineCounts, humanize } from './runFormat';
import { CORE_RULE, headBadge, type LivenessRule, runLivenessAt, tailState } from './runModel';
import { RunHead, RunNotes } from './runParts';
import {
  CoverageSection,
  FailuresSection,
  NotRecorded,
  PathSection,
  TalliesSection,
} from './runSections';
import type { RunView as RunData } from './runViews';

export type RunViewProps = {
  view: RunData;
  /** The page's ticking clock. */
  now: number;
  timeZone?: string;
  tail: (t: TailFor) => ReactNode;
  writes?: RunWrites | null;
  pane?: RefObject<HTMLElement | null>;
  /** The link to the campaign a pass ran under (the route's router link; a story's anchor). */
  linkToRun?: (runId: Id<'importRuns'>, label: string) => ReactNode;
  rule?: LivenessRule;
};

/** The words for a stored scope: "full canonical", or the states it named. */
function scopeWords(doc: RunData['doc']): string {
  const scope = doc.scope;
  if (scope === undefined) return W.scopeNotRecorded;
  const states =
    scope.states !== undefined && !scope.complete ? ` · ${W.states(scope.states)}` : '';
  return `${W.scope(scope.pass)}${states}`;
}

/**
 * **The run page** — one pass, or a single run listed on its own: the old run detail re-homed and
 * re-skinned in the kit. The head (the pass, *Single pass · full canonical · dev*, the state badge,
 * the campaign it ran under), the mark or the wait, the stats (*Elapsed*, *Heartbeat*, *Failures*),
 * the run's error, its own tail, *What to check* while quiet, then the record: *Outcome*,
 * *Coverage* (with its *unexplained* arithmetic), *Tallies*, *Path*, *Failures*, *Notes*. A field
 * the row doesn't hold reads *Not recorded*.
 */
export function RunView({
  view,
  now,
  timeZone,
  tail,
  writes,
  pane,
  linkToRun,
  rule = CORE_RULE,
}: RunViewProps) {
  const { doc } = view;
  const liveness = runLivenessAt(view, now, rule);
  const narrow = useInspectorContext().narrow === true;
  const marked = view.marked !== null;
  const title = doc.campaignPass ?? doc.label;
  const dryRun = view.dryRun === true;
  const kicker = [
    view.parent === null ? W.singlePass : W.campaignPass,
    scopeWords(doc),
    doc.isProd ? W.production : doc.deployment,
    ...(dryRun ? [W.dryRun] : []),
  ].join(' · ');
  const badge = headBadge(liveness, doc.status, view.marked?.at ?? null, timeZone);
  const ended = doc.status !== 'running' || marked;
  const end = doc.finishedAt ?? (ended ? null : now);
  const elapsed = end === null ? null : elapsedParts(end - doc.startedAt);
  const headline = headlineCounts(doc);
  const quiet =
    !ended &&
    (liveness.state === 'late' ||
      liveness.state === 'stalled' ||
      liveness.state === 'waiting' ||
      liveness.state === 'notRecorded');

  return (
    <InspectorFrame
      head={
        <RunHead
          title={title}
          kicker={kicker}
          badge={badge}
          end={
            view.parent !== null && linkToRun !== undefined
              ? linkToRun(view.parent.id, W.campaignLink(view.parent.title))
              : undefined
          }
        />
      }
      actions={
        <RunActions
          target={{ runId: doc._id, title }}
          status={doc.status}
          liveness={liveness}
          marked={marked}
          stopAsked={doc.stopRequest !== undefined}
          writes={writes}
          {...(pane !== undefined && { pane })}
        />
      }
    >
      <div
        data-slot="run-view"
        data-state={liveness.state}
        className="flex flex-col gap-(--gap-section) px-gutter pt-(--space-3_5)"
      >
        <RunNotes
          marked={view.marked}
          waiting={view.waiting}
          {...(timeZone !== undefined && { timeZone })}
        />
        <StatGrid data-slot="run-stats" columns={narrow ? 1 : 3}>
          <StatTile
            key="elapsed"
            label={ended ? W.took : W.elapsed}
            value={elapsed === null ? W.notRecorded : <ElapsedValue parts={elapsed} />}
            {...(elapsed === null && { tone: 'dim' as const })}
            sub={W.started(historyWhen(doc.startedAt, now, timeZone))}
          />
          <HeartbeatStat
            key="heartbeat"
            liveness={liveness}
            status={doc.status}
            marked={marked}
            lastHeardAt={doc.progressAt ?? null}
            {...(timeZone !== undefined && { timeZone })}
          />
          <StatTile
            key="failures"
            label={W.failures}
            value={count(doc.failures.length)}
            unit={W.failuresUnit}
            {...(doc.failuresTotal > 0 && { tone: doc.status === 'failed' ? 'bad' : 'warn' })}
            sub={W.failuresOf(doc.failuresTotal)}
          />
        </StatGrid>
        {doc.error !== undefined && (
          <RunError data-slot="run-error" title={W.error} message={doc.error} />
        )}
        <Section data-slot="tail" title={!ended ? W.liveTail : W.log} level={3}>
          {tail({
            runId: doc._id,
            state: tailState(doc.status, marked),
            liveness,
            lastHeardAt: doc.progressAt ?? null,
            now,
            ...(timeZone !== undefined && { timeZone }),
          })}
        </Section>
        {quiet && (
          <Section data-slot="what-to-check" title={W.whatToCheck} level={3}>
            <FactList
              className="grid-cols-[7.5rem_minmax(0,1fr)]"
              rows={[
                { label: W.checkTerminal, value: W.checkTerminalBody },
                {
                  label: W.checkLogFile,
                  value: `${W.checkLogFileBody} ${
                    doc.campaignId === undefined ? W.logPathUnknown : W.logPath(doc.campaignId)
                  }`,
                },
                { label: W.checkConvex, value: W.checkConvexBody },
              ]}
            />
          </Section>
        )}
        <Section data-slot="outcome" title={W.outcome} level={3}>
          {headline.length === 0 ? (
            <NotRecorded />
          ) : (
            <StatGrid columns={narrow ? 2 : Math.min(4, headline.length)}>
              {headline.map((c) => (
                <StatTile key={c.name} label={humanize(c.name)} value={count(c.value)} />
              ))}
            </StatGrid>
          )}
        </Section>
        <CoverageSection coverage={doc.coverage} />
        <TalliesSection counts={doc.counts} />
        <PathSection stages={doc.stages} />
        <FailuresSection failures={doc.failures} total={doc.failuresTotal} />
        {doc.notes !== undefined && doc.notes.length > 0 && (
          <Section data-slot="notes" title={W.notes} level={3}>
            <div className="flex flex-col gap-(--space-1_5)">
              {doc.notes.map((n) => (
                <p key={n} className="m-0 text-assist text-fg2">
                  {n}
                </p>
              ))}
            </div>
          </Section>
        )}
      </div>
    </InspectorFrame>
  );
}
