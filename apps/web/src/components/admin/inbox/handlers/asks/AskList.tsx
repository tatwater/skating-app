import { Quote } from '@/components/kit/note';
import { PersonByline } from '@/components/kit/person-lockup';
import { shortAge } from '@/lib/ages';

import { dayMonth } from '../../../shell/consoleTime';
import { useInspectorContext } from '../../inspector/inspectorContext';
import type { InboxItemView } from '../../list/inboxTypes';
import { ASK_LIST_WORDS as W } from './askListWords';

/**
 * **The ask list** (2.3's *The ask*; shared with 2.4's place asks): who asked, each on their own
 * byline — the kit's `PersonByline` (face, real name, @handle) with when at the line's end ("12 Oct ·
 * 2 d ago") — their note quoted under it, and a line for an ask filed with a recorded skate or from a
 * report. **Newest first**, as the board lists them. A person whose profile is gone is said as such,
 * never named.
 *
 * `total` is the item's own count (`memberCount`, `memberCountIsFloor`): the item's read holds at
 * most a page of asks, so past it the list says how many of how many it shows — a floor ("500+")
 * where the server's count stopped — rather than passing a page off as everyone.
 *
 * The zone dates are read in is the inspector's (`useInspectorContext`), as every date beside them.
 */

/** One ask an item holds (a request's or a place ask's), as `inbox.item` serves it. */
export type AskMemberView = Extract<InboxItemView, { kind: 'request' }>['asks'][number];

/** An item's count of its asks, and whether the server stopped counting (a floor). */
export type AskTotal = { count: number; floor: boolean };

/**
 * The asks newest first; ties keep the order they were served in. TEMPORARY: the server serves them
 * oldest first today; S3 decides the one order on the server, and this re-sort goes with it.
 */
export function newestFirst(asks: readonly AskMemberView[]): AskMemberView[] {
  return asks
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.askedAt - x.a.askedAt || x.i - y.i)
    .map(({ a }) => a);
}

/** "12 Oct · 2 d ago": the day it was asked and how long ago. */
export function askWhen(askedAt: number, now: number, timeZone?: string): string {
  return W.when(dayMonth(askedAt, timeZone), shortAge(now - askedAt));
}

/** The line under a list the server cut short, or `null` when every ask is shown. */
export function shownLine(shown: number, total: AskTotal | undefined): string | null {
  if (total === undefined) return null;
  if (!total.floor && total.count <= shown) return null;
  return W.shownOf(shown, total.count, total.floor);
}

export function AskList({
  asks,
  now,
  total,
}: {
  asks: AskMemberView[];
  now: number;
  total?: AskTotal;
}) {
  const { timeZone } = useInspectorContext();
  const more = shownLine(asks.length, total);
  return (
    <div data-slot="ask-list" className="flex min-w-0 flex-col gap-(--space-3_5)">
      <ul aria-label={W.list} className="m-0 flex list-none flex-col gap-(--space-3_5) p-0">
        {newestFirst(asks).map((a) => (
          <li key={a.requestId} data-slot="ask" className="flex min-w-0 flex-col gap-(--space-1_5)">
            {a.asker === null || a.asker.deleted ? (
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
            {a.note !== null && a.note.trim() !== '' && (
              <Quote data-slot="ask-note">{a.note.trim()}</Quote>
            )}
            {a.activityId !== null && (
              <span data-slot="ask-skate" className="text-assist leading-body text-fg3">
                {W.withSkate}
              </span>
            )}
            {a.fromReport !== null && (
              <span data-slot="ask-report" className="text-assist leading-body text-fg3">
                {W.fromReport(dayMonth(a.fromReport.skateEndTime, timeZone))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {more !== null && (
        <span data-slot="ask-list-more" className="text-assist leading-body text-fg3">
          {more}
        </span>
      )}
    </div>
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
