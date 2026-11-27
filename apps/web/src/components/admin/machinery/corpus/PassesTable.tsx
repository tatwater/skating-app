import type { Id } from '@skating/convex/dataModel';
import { Fragment } from 'react';

import { StatusDot, type StatusDotTone } from '@/components/kit/status-dot';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { cn } from '@/lib/utils';

import { RUN_WORDS as W } from '../words/runWords';
import { clock, count, tookWords } from './runFormat';
import { passState } from './runModel';
import type { LivenessView, PassRowView } from './runViews';

/**
 * **The campaign's passes** (board 6.2's *Passes*): the plan merged with the runs — the script's
 * passes in order, then *By hand, after the campaign* under its sub-head — each with what it does,
 * its state at the page's clock, in / up, failures, when it started and how long it took. A pass
 * that never started is dim; *required* is amber (the merge absorbed pairs nobody has folded yet).
 * A row with a run is pressed (or ⏎) to show that pass in the live tail; the one shown is selected.
 */
export function PassesTable({
  passes,
  liveness,
  selected,
  onSelect,
  timeZone,
}: {
  passes: readonly PassRowView[];
  /** The campaign's, at the page's clock: it tones the running pass. */
  liveness: LivenessView;
  /** The run the tail shows. */
  selected: Id<'importRuns'> | null;
  onSelect: (runId: Id<'importRuns'>) => void;
  timeZone?: string;
}) {
  const script = passes.filter((p) => p.by === 'script');
  const hand = passes.filter((p) => p.by === 'hand');
  const row = (p: PassRowView) => {
    const state = passState(p, liveness);
    const dim = state.tone === 'dim';
    const dot: StatusDotTone =
      state.tone === 'bad' ? 'bad' : state.tone === 'warn' ? 'warn' : dim ? 'hollow' : 'quiet';
    const run = p.run;
    return (
      <TableRow
        key={p.pass}
        data-slot="pass-row"
        data-pass={p.pass}
        data-state={p.state}
        dim={dim}
        clickable={run !== null}
        selected={run !== null && run.id === selected}
        {...(run !== null && { onClick: () => onSelect(run.id) })}
      >
        <TableCell className="w-(--space-4) pe-0">
          <StatusDot tone={dot} />
        </TableCell>
        <TableCell lead={!dim}>{p.pass}</TableCell>
        <TableCell>{p.skipped !== null ? W.skippedBecause(p.skipped) : p.does}</TableCell>
        <TableCell
          data-slot="pass-state"
          className={cn(
            'font-(family-name:--family-mono) text-mono-sm',
            state.tone === 'bad' && 'text-bad',
            state.tone === 'warn' && 'text-warn',
            state.tone === 'fg' && 'text-fg',
          )}
        >
          {state.words}
        </TableCell>
        <TableCell align="end" mono className="whitespace-nowrap">
          {run === null
            ? ''
            : run.inUp === null
              ? '—'
              : `${count(run.inUp.in)} / ${count(run.inUp.up)}`}
        </TableCell>
        <TableCell align="end" mono className="whitespace-nowrap">
          {run === null ? '' : count(run.failed)}
        </TableCell>
        <TableCell mono className="whitespace-nowrap">
          {run === null ? '' : clock(run.startedAt, timeZone)}
        </TableCell>
        <TableCell align="end" mono className="whitespace-nowrap">
          {run === null
            ? ''
            : run.finishedAt === null
              ? '—'
              : tookWords(run.finishedAt - run.startedAt)}
        </TableCell>
      </TableRow>
    );
  };
  return (
    // Its columns never squeeze to a phone: below its width the table scrolls in its own box.
    <Table data-slot="passes-table" className="min-w-[46rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-(--space-4) pe-0">
            <span className="sr-only">{W.state}</span>
          </TableHead>
          <TableHead>{W.pass}</TableHead>
          <TableHead>{W.whatItDoes}</TableHead>
          <TableHead>{W.state}</TableHead>
          <TableHead align="end">{W.inUp}</TableHead>
          <TableHead align="end">{W.failed}</TableHead>
          <TableHead>{W.startedHead}</TableHead>
          <TableHead align="end">{W.tookHead}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {script.map(row)}
        {hand.length > 0 && (
          <Fragment>
            <TableRow data-slot="by-hand">
              <TableCell colSpan={8} className="pt-(--space-4)">
                <span className="text-row font-medium text-fg">{W.byHandHead}</span>
                <span className="ms-(--space-2) text-assist text-fg3">{W.byHandAssist}</span>
              </TableCell>
            </TableRow>
            {hand.map(row)}
          </Fragment>
        )}
      </TableBody>
    </Table>
  );
}
