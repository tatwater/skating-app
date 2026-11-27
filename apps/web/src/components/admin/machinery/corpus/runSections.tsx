import type { Doc } from '@skating/convex/dataModel';
import { useState } from 'react';

import { Button } from '@/components/kit/button';
import { FactList } from '@/components/kit/fact-list';
import { Meter } from '@/components/kit/meter';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';

import { useInspectorContext } from '../../inspector/inspectorContext';
import { RUN_WORDS as W } from '../words/runWords';
import {
  type Count,
  type CountGroup,
  count,
  coverageLedger,
  formatBytes,
  groupCounts,
  humanize,
  isoDay,
  type Stage,
  stripPrefix,
  TOTALS,
} from './runFormat';

/**
 * **A run's record, re-skinned in the kit** (the old run detail's views, ported: its *unexplained*
 * arithmetic, its grouped tallies, its path and its failures). Each section draws what the row
 * holds and says *Not recorded* where a field is missing — never a zero for a count nobody kept.
 */

type ImportRun = Doc<'importRuns'>;

/** Rows a prefixed tally group shows before the rest wait behind *n more*; Totals is never capped. */
const GROUP_PREVIEW = 6;

const MONO = 'font-(family-name:--family-mono) text-mono-sm tracking-value tabular-nums';

/** *Not recorded*, in the faint ink: a field the row doesn't hold. */
export function NotRecorded() {
  return (
    <p data-slot="not-recorded" className="m-0 text-assist text-fg3">
      {W.notRecorded}
    </p>
  );
}

/** One labeled number with its share drawn under it (the number is always printed). */
function ShareRow({
  label,
  value,
  share,
  of,
  warn = false,
}: {
  label: string;
  value: number;
  share: number;
  of?: number;
  warn?: boolean;
}) {
  const pct = of !== undefined && of > 0 ? (Math.abs(value) / of) * 100 : undefined;
  return (
    <div data-slot="share-row" className="flex flex-col gap-(--space-1)">
      <div className="flex items-baseline justify-between gap-(--space-4) text-row">
        <span className={cn(warn ? 'text-warn' : 'text-fg2')}>{label}</span>
        <span className={cn(MONO, warn ? 'text-warn' : 'text-fg')}>
          {count(value)}
          {pct !== undefined && <span className="ms-(--space-2) text-fg3">{pct.toFixed(1)}%</span>}
        </span>
      </div>
      <Meter
        aria-label={label}
        value={Math.max(0, Math.min(1, share)) * 100}
        {...(warn && { tone: 'warn' as const })}
      />
    </div>
  );
}

/** *Coverage*: the rate, and the ledger that has to add up to it. */
export function CoverageSection({ coverage }: { coverage: ImportRun['coverage'] }) {
  return (
    <Section data-slot="coverage" title={W.coverage} level={3}>
      {coverage === undefined ? <NotRecorded /> : <CoverageBody coverage={coverage} />}
    </Section>
  );
}

function CoverageBody({ coverage }: { coverage: NonNullable<ImportRun['coverage']> }) {
  const { pct, unexplained, omissions, widest } = coverageLedger(coverage);
  return (
    <div className="flex flex-col gap-(--space-3)">
      <div className="flex items-baseline gap-(--space-2)">
        <span className={cn(MONO, 'text-stat text-fg')}>{pct.toFixed(1)}%</span>
        <span className="text-assist text-fg3">
          {W.coverageOf(coverage.covered, coverage.eligible, coverage.unit)}
        </span>
      </div>
      <Meter aria-label={W.coverage} value={Math.max(0, Math.min(100, pct))} />
      {omissions.map((o) => (
        <ShareRow
          key={o.reason}
          label={o.reason}
          value={o.count}
          share={o.count / widest}
          of={coverage.eligible}
        />
      ))}
      {unexplained !== 0 && (
        <div
          data-slot="unexplained"
          className="border-0 border-t border-solid border-line pt-(--space-2)"
        >
          <ShareRow
            label={W.unexplained}
            value={unexplained}
            share={Math.abs(unexplained) / widest}
            of={coverage.eligible}
            warn
          />
        </div>
      )}
    </div>
  );
}

/** *Tallies*: every count, grouped by the prefix its loader named it with. */
export function TalliesSection({ counts }: { counts: readonly Count[] }) {
  return (
    <Section data-slot="tallies" title={W.tallies} count={counts.length} level={3}>
      {counts.length === 0 ? (
        <NotRecorded />
      ) : (
        <div className="grid gap-x-(--space-6) gap-y-(--space-5) [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
          {groupCounts(counts).map((g) => (
            <TallyGroup key={g.key} group={g} />
          ))}
        </div>
      )}
    </Section>
  );
}

function TallyGroup({ group }: { group: CountGroup }) {
  const [open, setOpen] = useState(false);
  // Against the family's own largest: a lane's overlapping counts would sum past a whole.
  const widest = Math.max(1, ...group.counts.map((c) => c.value));
  const cap = group.key === TOTALS || open ? group.counts.length : GROUP_PREVIEW;
  const hidden = group.counts.length - cap;
  return (
    <div data-slot="tally-group" className="flex min-w-0 flex-col gap-(--space-2_5)">
      <span className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
        {group.title}
      </span>
      {group.counts.slice(0, cap).map((c) => (
        <ShareRow
          key={c.name}
          label={humanize(stripPrefix(c.name))}
          value={c.value}
          share={c.value / widest}
        />
      ))}
      {hidden > 0 && (
        <Button size="sm" variant="bare" className="self-start" onClick={() => setOpen(true)}>
          {W.moreInGroup(hidden)}
        </Button>
      )}
    </div>
  );
}

/** A stage's evidence on one line, as the board's *Path*: "2026-10-11 · 412 MB · sha ✓". */
export function stageFacts(stage: Stage): string {
  const parts: string[] = [];
  if (stage.detail?.startsWith('MISSING')) parts.push(W.missing);
  // A source's build date is a calendar date (a publisher's), stored at its UTC midnight.
  if (stage.sourceAt !== undefined) parts.push(isoDay(stage.sourceAt, 'UTC'));
  if (stage.bytes !== undefined) parts.push(formatBytes(stage.bytes));
  const sum = stage.sha256 !== undefined ? 'sha' : stage.md5 !== undefined ? 'md5' : null;
  if (stage.checksumVerified === true) parts.push(`${sum ?? 'checksum'} ${W.checksumOk}`);
  else if (stage.checksumVerified === false) parts.push(W.checksumBad);
  if (parts.length === 0 && stage.detail !== undefined) parts.push(stage.detail);
  return parts.length === 0 ? W.notRecorded : parts.join(' · ');
}

/** *Path*: each stage the run recorded, with its evidence, in order. */
export function PathSection({
  stages,
  className,
}: {
  stages: readonly Stage[];
  className?: string;
}) {
  // One pane at a time (a phone, beside the console's rail): the slug's long end would push the
  // page sideways, so it is left off, as the Passes section's is.
  const narrow = useInspectorContext().narrow === true;
  return (
    <Section
      data-slot="path"
      title={W.path}
      level={3}
      className={className}
      {...(!narrow && {
        end: (
          <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
            {W.pathEnd}
          </span>
        ),
      })}
    >
      {stages.length === 0 ? (
        <NotRecorded />
      ) : (
        <FactList
          rows={stages.map((s, i) => ({
            key: `${s.name}-${i}`,
            label: s.name,
            value: (
              <span
                className={cn(
                  MONO,
                  (s.checksumVerified === false || s.detail?.startsWith('MISSING')) && 'text-bad',
                )}
              >
                {stageFacts(s)}
              </span>
            ),
          }))}
        />
      )}
    </Section>
  );
}

/** *Failures*: the stored sample, and how many more the run counted but didn't keep. */
export function FailuresSection({
  failures,
  total,
}: {
  failures: ImportRun['failures'];
  total: number;
}) {
  const hidden = total - failures.length;
  return (
    <Section data-slot="failures" title={W.failuresSection} count={total} level={3}>
      {total === 0 ? (
        <p className="m-0 text-assist text-fg3">{W.failuresNone}</p>
      ) : (
        <div className="flex flex-col gap-(--space-1_5)">
          {failures.map((f, i) => (
            <div
              key={`${f.stage}-${f.key ?? i}`}
              data-slot="failure"
              className="flex flex-wrap items-baseline gap-x-(--space-2) text-row"
            >
              <span className={cn(MONO, 'text-fg3')}>{f.stage}</span>
              {f.key !== undefined && <span className={cn(MONO, 'text-fg')}>{f.key}</span>}
              <span className="text-fg2">{f.reason}</span>
            </div>
          ))}
          {hidden > 0 && (
            <p data-slot="failures-hidden" className="m-0 pt-(--space-1) text-assist text-fg3">
              {W.failuresHidden(hidden, failures.length)}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** A run's counts as facts (the board's *Outcome so far*): name, value. */
export function countFacts(counts: readonly Count[]) {
  return counts.map((c) => ({
    key: c.name,
    label: humanize(c.name),
    value: <span className={cn(MONO, 'text-fg')}>{count(c.value)}</span>,
  }));
}
