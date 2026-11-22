import type { ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { PersonLockup } from '@/components/kit/person-lockup';

import { standingLine, type TimelineEvent, verdictWords } from '../handlers/Access/accessModel';
import { ACCESS_WORDS as W } from '../handlers/Access/accessWords';

/**
 * **A claims-and-ruling timeline event, drawn** (board 2.2's timeline): one home for the Access item's
 * timeline and the standing ruling a contest-access ask contests, so the two draw a ruling the same
 * way. Each event's mark is the timeline's (`ItemTimeline`); this draws what sits beside it.
 */

/** A person in the timeline: their circle and real name — the board's timeline draws no handle. */
function Who({ p }: { p: { displayName: string } }) {
  return <PersonLockup size="md" name={p.displayName} />;
}

/** Someone's words in the timeline: one style for every quote, no rule (the board's `.qt`). */
function Said({ text }: { text: string }) {
  return (
    <p data-slot="access-quote" className="m-0 text-row leading-body text-fg2">
      “{text}”
    </p>
  );
}

/** One timeline event's body: a report, the standing ruling, or the reports that ruling dismissed. */
export function TimelineEventBody({ event: e }: { event: TimelineEvent }): ReactNode {
  switch (e.kind) {
    case 'report': {
      const standing = e.filer === null ? null : standingLine(e.filer);
      return (
        <>
          <div className="flex min-w-0 items-baseline justify-between gap-(--space-3)">
            {e.filer !== null ? (
              <Who p={e.filer} />
            ) : (
              <span className="text-row text-fg2">{W.filedByApp}</span>
            )}
            {standing !== null && (
              <span className="shrink-0 font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase">
                {standing}
              </span>
            )}
          </div>
          {e.note !== null && <Said text={e.note} />}
        </>
      );
    }
    case 'ruling':
      return (
        <>
          <div className="flex min-w-0 flex-wrap items-baseline gap-(--space-2_5)">
            <span className="text-row font-medium text-fg">{verdictWords(e.verdict)}</span>
            <Badge variant="outline" tone="bright">
              {W.standingRuling}
            </Badge>
          </div>
          {/* The person who ruled stands on a line of their own (the board's review 6). */}
          <div data-slot="access-ruled-by">
            {e.by !== null ? (
              <Who p={e.by} />
            ) : (
              <span className="text-row text-fg3">{W.someoneGone}</span>
            )}
          </div>
          {e.note !== null && <Said text={e.note} />}
          {e.reason !== null && (
            <span data-slot="access-ruling-source" className="text-assist leading-body text-fg3">
              {W.source} {e.reason}
            </span>
          )}
        </>
      );
    case 'dismissed':
      return (
        <>
          <span className="text-row text-fg2">{W.reportsDismissed(e.count, e.capped)}</span>
          {e.filers.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-(--space-1_5) gap-y-(--space-1)">
              {e.filers.map((f, i) => (
                <span key={f.userId} className="inline-flex items-baseline gap-(--space-1_5)">
                  {i > 0 && <span className="text-assist text-fg3">and</span>}
                  <Who p={f} />
                </span>
              ))}
            </div>
          )}
          {e.notes.map((n) => (
            <Said key={n} text={n} />
          ))}
        </>
      );
  }
}
