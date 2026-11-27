import type { ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Note, Quote } from '@/components/kit/note';
import { PersonLockup } from '@/components/kit/person-lockup';

import { InspectorHeadEnd } from '../../inspector/InspectorFrame';
import { RUN_WORDS as W } from '../words/runWords';
import { clock, quietWords } from './runFormat';
import type { HeadBadge } from './runModel';
import type { MarkedView, WaitingView } from './runViews';

/**
 * The pieces the campaign page and the run page share: the pane head (the run's name as the page
 * word, its kicker, its state badge at the end), and the notes under it — a mark with who, when and
 * why, a wait with who and until when, and a laptop clock that disagrees with the server's.
 */

export function RunHead({
  title,
  kicker,
  badge,
  end,
}: {
  title: string;
  kicker: string;
  badge: HeadBadge;
  /** Before the badge: a link (the campaign a pass ran under). */
  end?: ReactNode;
}) {
  return (
    <>
      <h2
        data-slot="run-title"
        className="m-0 min-w-0 text-disp leading-none font-semibold tracking-disp [overflow-wrap:anywhere] text-fg uppercase"
      >
        {title}
      </h2>
      <span
        data-slot="run-kicker"
        className="min-w-0 text-kick leading-(--lead-snug) font-medium tracking-kick text-fg3 uppercase"
      >
        {kicker}
      </span>
      <InspectorHeadEnd>
        {end}
        <StateBadge badge={badge} />
      </InspectorHeadEnd>
    </>
  );
}

/** The state badge: a live LED while running, amber or red solid by meaning, quiet when done. */
export function StateBadge({ badge }: { badge: HeadBadge }) {
  const common = { 'data-slot': 'run-state', 'data-tone': badge.tone } as const;
  switch (badge.tone) {
    case 'live':
      return (
        <Badge {...common} variant="live">
          {badge.words}
        </Badge>
      );
    case 'warn':
      return (
        <Badge {...common} tone="warn">
          {badge.words}
        </Badge>
      );
    case 'bad':
      return (
        <Badge {...common} tone="bad">
          {badge.words}
        </Badge>
      );
    case 'quiet':
      return (
        <Badge {...common} variant="outline">
          {badge.words}
        </Badge>
      );
  }
}

/** A person, as the notes stand them on their own line: a circle and their real name. */
function Who({ person }: { person: MarkedView['by'] }) {
  return <PersonLockup size="md" name={person.name} src={person.avatarUrl} />;
}

/**
 * The notes under a run's head: the mark (red: who, the reason quoted, the loader's own close kept
 * beside it, and that nothing was scheduled), the wait (amber: until when, and who), and the
 * laptop's clock when it is off by more than a minute.
 */
export function RunNotes({
  marked,
  waiting,
  clockSkewMs = null,
  timeZone,
}: {
  marked: MarkedView | null;
  waiting: WaitingView | null;
  clockSkewMs?: number | null;
  timeZone?: string;
}) {
  if (marked === null && waiting === null && clockSkewMs === null) return null;
  return (
    <div data-slot="run-notes" className="flex flex-col gap-(--space-4)">
      {marked !== null && (
        <Note data-slot="run-marked" tone="bad">
          <div className="flex flex-col gap-(--space-2)">
            <strong>{W.markedAt(clock(marked.at, timeZone))}</strong>
            <Who person={marked.by} />
            <Quote>{marked.reason}</Quote>
            {marked.loaderFinish != null && (
              <span data-slot="loader-finish">
                {W.loaderLater(marked.loaderFinish.status)}
                {marked.loaderFinish.error !== undefined &&
                  ` · ${W.loaderLaterError(marked.loaderFinish.error)}`}
              </span>
            )}
            <span className="text-fg3">{W.noReconcile}</span>
          </div>
        </Note>
      )}
      {marked === null && waiting !== null && (
        <Note data-slot="run-waiting" tone="warn">
          <div className="flex flex-col gap-(--space-2)">
            <strong>{W.waitingUntil(clock(waiting.until, timeZone))}</strong>
            <Who person={waiting.by} />
          </div>
        </Note>
      )}
      {clockSkewMs !== null && (
        <Note data-slot="clock-skew">
          {W.clockSkew(quietWords(Math.abs(clockSkewMs)), clockSkewMs > 0)}
        </Note>
      )}
    </div>
  );
}
