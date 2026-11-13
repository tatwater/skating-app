import type { ReactNode } from 'react';

import { StatusLamp, StatusText } from '@/components/kit/status-bar';

import type { CorpusCardData, InboxCardData, MachineryCardData } from './overviewData';
import type { LiveState } from './overviewModel';

/**
 * The Overview's integration points with the shell's status bar: the page's status groups and the
 * connection lamp. The shell mounts them (`AppShell`'s `status` and `lamp`); Home only says what
 * they read.
 *
 * The bar never restates the Inbox's count (the rail badge and the heads row carry it); it names
 * safety, the machinery's trouble, and a corpus pass not yet run, a group each.
 */
export function overviewStatus({
  inbox,
  machinery,
  corpus,
}: {
  inbox?: InboxCardData | undefined;
  machinery?: MachineryCardData | undefined;
  corpus?: CorpusCardData | undefined;
}): ReactNode[] {
  const groups: ReactNode[] = [];

  const safety = inbox?.lanes.safety;
  if (safety && safety.count > 0) {
    groups.push(
      <StatusText key="safety" tone="bad">
        {safety.count}
        {safety.capped ? '+' : ''} safety
      </StatusText>,
    );
  }

  if (machinery) {
    const n = (state: string) => machinery.jobs.filter((j) => j.state === state).length;
    const hand = [
      n('stalled') > 0 ? `${n('stalled')} stalled` : null,
      n('failed') > 0 ? `${n('failed')} failed` : null,
    ].filter(Boolean);
    const late = [
      n('late') > 0 ? `${n('late')} late` : null,
      n('retried') > 0 ? `${n('retried')} retried` : null,
    ].filter(Boolean);
    if (hand.length > 0 || late.length > 0) {
      groups.push(
        <span key="machinery" className="inline-flex gap-(--space-5)">
          {hand.length > 0 && <StatusText tone="bad">{hand.join(' · ')}</StatusText>}
          {late.length > 0 && <StatusText tone="warn">{late.join(' · ')}</StatusText>}
        </span>,
      );
    }
  }

  if (corpus?.preIcePass?.state === 'not-run') {
    groups.push(<StatusText key="pass">pre-ice pass not run</StatusText>);
  }
  return groups;
}

const LAMP_WORDS: Record<LiveState, string> = {
  live: 'Convex live',
  checking: 'Convex checking',
  off: 'Convex not live',
};

/**
 * The connection lamp, in the live mark's states. The kit lamp has no hollow state yet, so *Not
 * live* reads idle (dim, still) until it does.
 */
export function OverviewLamp({ state }: { state: LiveState }) {
  return <StatusLamp state={state === 'live' ? 'live' : 'idle'}>{LAMP_WORDS[state]}</StatusLamp>;
}
