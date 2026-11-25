import type { ReactNode } from 'react';

import { Quote } from '@/components/kit/note';
import { PersonByline } from '@/components/kit/person-lockup';

import { shortAge } from '@/lib/ages';
import { useInspectorContext } from '../../../inspector/inspectorContext';
import { dayMonth } from '../../../shell/consoleTime';
import { ListCutLine, type ListTotal } from '../../blocks/listCut';
import { shownName } from '../../blocks/shownName';
import { skateWords } from '../../blocks/skateWords';
import type { InboxItemView } from '../../list/inboxTypes';
import { ASK_LIST_WORDS as W } from './askListWords';

/**
 * **The ask list** (2.3's *The ask*; shared with 2.4's place asks): who asked, each on their own
 * byline — the kit's `PersonByline` (face, real name, @handle) with when at the line's end ("12 Oct ·
 * 2 d ago") — their note quoted under it, and a line for an ask filed with a recorded skate (its day and length) or
 * from a report. **In the server's order** — newest first, as the board lists them. A person whose profile
 * is gone is said as such, never named.
 *
 * `total` is the item's own count and whether the server cut the list short (`asksCut`): past a page
 * the list says how many of how many it shows, as every Inbox list says it (`blocks/listCut`).
 *
 * The zone dates are read in is the inspector's (`useInspectorContext`), as every date beside them.
 */

/** One ask an item holds (a request's or a place ask's), as `inbox.item` serves it. */
export type AskMemberView = Extract<InboxItemView, { kind: 'request' }>['asks'][number];

/**
 * An ask's recorded skate as its line says it: "With a recorded skate · 1h 36m · 11 Oct 09:00–11:00"
 * — the one skate format (`blocks/skateWords`). An ask tied to a skate the read couldn't describe
 * still says it came with one.
 */
export function skateLine(
  a: Pick<AskMemberView, 'activityId' | 'skate'>,
  timeZone?: string,
): string | null {
  if (a.skate === null) return a.activityId !== null ? W.withSkate : null;
  return W.skateWhen(skateWords(a.skate, timeZone));
}

/** "12 Oct · 2 d ago": the day it was asked and how long ago. */
export function askWhen(askedAt: number, now: number, timeZone?: string): string {
  return W.when(dayMonth(askedAt, timeZone), shortAge(now - askedAt));
}

export function AskList({
  asks,
  now,
  total,
  rowMeta,
}: {
  asks: AskMemberView[];
  now: number;
  total: ListTotal;
  /**
   * What a kind adds under an asker's row (the place handler's landmark history); `null` adds
   * nothing for that ask.
   */
  rowMeta?: (ask: AskMemberView) => ReactNode;
}) {
  const { timeZone } = useInspectorContext();
  return (
    <div data-slot="ask-list" className="flex min-w-0 flex-col gap-(--space-3_5)">
      <ul aria-label={W.list} className="m-0 flex list-none flex-col gap-(--space-3_5) p-0">
        {asks.map((a) => (
          <li key={a.requestId} data-slot="ask" className="flex min-w-0 flex-col gap-(--space-1_5)">
            {shownName(a.asker) === null || a.asker === null ? (
              <div className="flex min-w-0 items-baseline justify-between gap-(--space-3)">
                <span data-slot="ask-gone" className="text-row leading-list text-fg3">
                  {W.goneAsker}
                </span>
                <AskMeta text={askWhen(a.askedAt, now, timeZone)} />
              </div>
            ) : (
              <PersonByline
                // A narrow pane: the time wraps under the name rather than over the handle.
                className="flex-wrap gap-y-(--space-1)"
                name={a.asker.displayName}
                {...(a.asker.username !== '' && { handle: a.asker.username })}
                meta={askWhen(a.askedAt, now, timeZone)}
              />
            )}
            <AskWords ask={a} timeZone={timeZone} />
            {rowMeta !== undefined && <AskRowMeta>{rowMeta(a)}</AskRowMeta>}
            {a.fromReport !== null && (
              <span data-slot="ask-report" className="text-assist leading-body text-fg3">
                {W.fromReport(dayMonth(a.fromReport.skateEndTime, timeZone))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <ListCutLine members={asks} total={total} noun="asks" />
    </div>
  );
}

/**
 * **An ask's own words, as every ask is drawn**: its note quoted, and its recorded skate. The list's
 * rows draw them, and so does a handler's compact layout for a single ask (the place handler's), so
 * an ask reads the same wherever it stands.
 */
export function AskWords({
  ask,
  timeZone,
}: {
  ask: Pick<AskMemberView, 'note' | 'activityId' | 'skate'>;
  timeZone: string | undefined;
}) {
  const skate = skateLine(ask, timeZone);
  return (
    <>
      {ask.note !== null && ask.note.trim() !== '' && (
        <Quote data-slot="ask-note">{ask.note.trim()}</Quote>
      )}
      {skate !== null && (
        <span data-slot="ask-skate" className="text-assist leading-body text-fg3">
          {skate}
        </span>
      )}
    </>
  );
}

/** A kind's own line under an asker's row, in the list's assist face; nothing for `null`. */
function AskRowMeta({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <span data-slot="ask-meta" className="text-assist leading-body text-fg3">
      {children}
    </span>
  );
}

/** The byline's time, for a gone asker's line (`PersonByline`'s own meta face). */
function AskMeta({ text }: { text: string }) {
  return (
    <span className="shrink-0 font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase">
      {text}
    </span>
  );
}
