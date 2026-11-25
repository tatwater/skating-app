import { api } from '@skating/convex/api';
import { searchQueryArg } from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';

import { routerTarget } from '@/lib/routerTarget';
import { useRole } from '@/lib/useRole';
import { useCorpusLanes } from '../corpus/list/taskReads';
import { firstOpenLane, openTotal } from '../corpus/taskLanes';
import { taskSearchFor } from '../corpus/taskSearch';
import { openTasks } from '../corpus/words/corpusWords';
import { LOCK_START, lockSeenOf, nextLock } from '../inspector/lockModel';
import { isFailed, loaded, read, useConsoleReadSet } from '../reads/consoleReads';
import { ReadNote } from '../reads/ReadNote';
import { useClockFor } from '../reads/readArgs';
import { useMinuteNow } from '../shell/presence';
import { UnmergeLiveProvider } from '../shell/UnmergeLeft';
import { InboxView } from './InboxView';
import {
  type InboxQuery,
  type InboxSearch,
  listKey,
  placeAfter,
  queryOf,
  searchFor,
  serverFilter,
} from './inboxSearch';
import type { InspectorState } from './inspector/InboxInspector';
import { localMidnight } from './lanes/laneModel';
import { ZeroLinks, type ZeroToday } from './list/InboxZero';
import { decidedSince } from './list/inboxModel';
import {
  useDecidedFirstPage,
  useInboxItem,
  useInboxLanes,
  useInboxPages,
  useInboxTail,
  useInboxToday,
} from './list/inboxReads';
import type { InboxRowView } from './list/inboxTypes';
import type { FilterOption } from './list/LaneFacets';
import { COUNTS_FAILED, SUPPORT_REFUSED } from './words/inboxWords';

/**
 * **The Inbox, wired**: its place from the URL (validated by `validateInboxSearch`, the route's
 * `validateSearch`), the lanes' counts, the lane's pages, its tail, the open item and — at zero —
 * the day, all through the console's one read layer; the clock; and the decided-only lock, run as a
 * state machine over the open item's live read (`lockModel`).
 *
 * - **The lanes a viewer has** are the server's rule, asked of the role before the counts land, so
 *   a moderator's link to Support is All open, never an error.
 * - **The list is read against the list's clock**: the minute it was opened, held while it stays
 *   open, so a new minute never restarts the paging. **The day is the reader's live one**: today's
 *   counts roll over at local midnight with the list still open, and change only when the day does.
 * - **Every change of place is a navigation**, so the back button, a reload and a shared link put
 *   the page back as it was. Another lane, tab or filter closes an item opened from the list, and
 *   keeps one that came by a direct link (`placeAfter`); opening an item beside one already open
 *   replaces the entry, so back returns to the list rather than walking each item.
 */
export function InboxRoute() {
  const search = useSearch({ strict: false }) as InboxSearch;
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  const canRead = can('inbox.read');
  const canSupport = can('inbox.support.read');
  const query = queryOf(search, canSupport);
  const key = listKey(query);
  const listNow = useClockFor(key);
  // **The day is the reader's, on the live clock**: today's counts (the lanes' *Decided today*, Inbox
  // zero's day) count from the latest local midnight, so a list left open past midnight rolls over
  // with it. It changes only when the day does, so no day read re-subscribes on a minute tick.
  const dayStart = localMidnight(now);
  // A day read's clock: the list's, or the day's start once that passes it. The server holds a
  // `dayStart` within `[now − 1.5 days, now]` (`heldDayStart`), so the new day's midnight beside
  // yesterday's list clock would be pulled back to that clock; this pair satisfies it, and changes
  // only with the list or the day. The pages keep the list's clock, so the paging never restarts.
  const dayNow = Math.max(listNow, dayStart);
  const inspectorRef = useRef<HTMLElement | null>(null);
  // The item last opened from the list (a row's press or keys); any other open item came by a link.
  const openedFromList = useRef<string | null>(null);

  const lanesRead = useInboxLanes(dayNow, dayStart, canRead);
  const lanes = lanesRead.shown;
  const pages = useInboxPages(
    canRead
      ? {
          lane: query.lane,
          facet: query.facet,
          ...(query.filter !== null && { filter: serverFilter(query.filter) }),
          now: listNow,
          memoryKey: key,
        }
      : null,
  );
  const tailRead = useInboxTail(query.lane, listNow, canRead);

  // Inbox zero: All open, unfiltered, the counts in and nothing open.
  const atZero =
    query.lane === 'all' &&
    query.filter === null &&
    lanes !== undefined &&
    !lanes.pending &&
    lanes.allOpen === 0;
  const todayRead = useInboxToday(dayNow, dayStart, canRead && atZero);
  const decidedRead = useDecidedFirstPage(listNow, canRead && atZero);
  // *Not in the inbox*: what waits in Corpus's task lanes, read only at zero, and the way there —
  // the first lane with an open task. No count while the server is still filing its tasks.
  const canCorpus = can('corpus.read');
  const corpusLanes = useCorpusLanes(listNow, canCorpus && atZero).shown;
  const corpusLine =
    corpusLanes === undefined || corpusLanes.pending
      ? undefined
      : openTasks(openTotal(corpusLanes));
  const corpusLink = canCorpus ? (
    <Link
      to="/admin/corpus"
      search={taskSearchFor({ lane: firstOpenLane(corpusLanes), tab: null, item: null, q: '' })}
    />
  ) : undefined;

  // ── The open item and its lock ──────────────────────────────────────────────────────────────
  // A `ticket:` ref to a viewer without support's read is refused by the read itself; it isn't
  // asked, and the refusal is said in the read's own sentence (the server's `SUPPORT_REFUSAL`).
  const ticketRefused = query.item?.startsWith('ticket:') === true && !canSupport;
  const itemRead = useInboxItem(ticketRefused ? null : query.item, canRead);
  const itemValue = loaded(itemRead.state);
  const [lock, setLock] = useState(LOCK_START);
  const nextState = nextLock(lock, query.item, lockSeenOf(itemValue?.item));
  if (nextState !== lock) setLock(nextState);
  const inspector: InspectorState =
    query.item === null
      ? { kind: 'none' }
      : ticketRefused
        ? { kind: 'refused', words: SUPPORT_REFUSED }
        : isFailed(itemRead.state)
          ? { kind: 'failed', retry: itemRead.retry, retrying: itemRead.retrying }
          : itemValue === undefined
            ? { kind: 'loading' }
            : itemValue.item === null
              ? itemValue.pending
                ? { kind: 'pending' }
                : { kind: 'missing' }
              : { kind: 'item', item: itemValue.item, phase: nextState.phase };

  // ── The filter's searches ───────────────────────────────────────────────────────────────────
  const [bodyQ, setBodyQ] = useState('');
  const [personQ, setPersonQ] = useState('');
  const bodyArg = can('body.read') ? searchQueryArg(bodyQ, 6) : 'skip';
  const personTerm = personQ.trim();
  const {
    reads: found,
    retry: retrySearch,
    pending: retryingSearch,
  } = useConsoleReadSet({
    bodies:
      bodyArg === 'skip'
        ? null
        : read(api.waterBodies.searchByName, { ...bodyArg, bodiesOnly: true }),
    people:
      can('people.read') && personTerm.length > 0
        ? read(api.admin.userSearch, { query: personTerm })
        : null,
  });
  const bodyResults: FilterOption[] = (loaded(found.bodies) ?? []).map((b) => ({
    id: b.waterBodyId,
    label: b.name,
    ...(b.states.length > 0 && { sub: b.states.join(', ') }),
  }));
  const personResults: FilterOption[] = (loaded(found.people) ?? []).map((p) => ({
    id: p.userId,
    label: p.displayName,
  }));
  const searchFailure = (x: unknown) =>
    isFailed(x) ? { retry: retrySearch, pending: retryingSearch } : null;
  const [named, setNamed] = useState<{ id: string; name: string } | null>(null);
  const filterName = nameOfFilter(query, named, pages.rows);

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────
  // Through the router's own search, never a hand-built query string (the router reads a string
  // query as JSON, so a value like `true` or `1.50` would come back changed).
  const go = (next: InboxQuery, replace = false) =>
    void navigate({
      to: '/admin/inbox',
      search: searchFor(next) as never,
      ...(replace && { replace: true }),
    });

  const tail = atZero
    ? {
        rows: decidedSince(loaded(decidedRead.state)?.rows ?? [], dayStart),
        failure: isFailed(decidedRead.state)
          ? { retry: decidedRead.retry, pending: decidedRead.retrying }
          : null,
      }
    : query.lane === 'all' || query.lane === 'decided'
      ? null
      : {
          rows: loaded(tailRead.state)?.rows ?? [],
          failure: isFailed(tailRead.state)
            ? { retry: tailRead.retry, pending: tailRead.retrying }
            : null,
        };

  const zeroDay: ZeroToday = isFailed(todayRead.state)
    ? { kind: 'failed', retry: todayRead.retry, retrying: todayRead.retrying }
    : todayRead.state === undefined
      ? { kind: 'loading' }
      : { kind: 'ready', today: todayRead.state };

  const linkFor = useMemo(() => (path: string) => <Link {...routerTarget(path)} />, []);

  return (
    // The unmerge's live state where a merge is refused with `unmerging` (the Drawn lever).
    <UnmergeLiveProvider>
      <ZeroLinks value={corpusLink === undefined ? {} : { corpus: corpusLink }}>
        <InboxView
          lanes={lanes}
          canReadSupport={canSupport}
          query={query}
          onQueryChange={(next) =>
            go(
              placeAfter(query, next, query.item !== null && openedFromList.current === query.item),
            )
          }
          list={{
            status: pages.status,
            rows: pages.rows,
            pending: pages.pending,
            retryPending: pages.failure?.pending === true,
          }}
          onLoadMore={pages.loadMore}
          {...(pages.failure !== null && { onRetryList: pages.failure.retry })}
          tail={tail}
          zero={
            atZero
              ? {
                  day: zeroDay,
                  ...(corpusLine !== undefined && { notInInbox: { corpus: corpusLine } }),
                }
              : null
          }
          inspector={inspector}
          onOpenItem={(itemId, from) => {
            openedFromList.current = itemId;
            go({ ...query, item: itemId }, query.item !== null);
            // From the keys, focus follows into the item; a press leaves it where the pointer is.
            if (from === 'keys') inspectorRef.current?.focus();
          }}
          onCloseItem={() => go({ ...query, item: null }, true)}
          {...(query.from !== null && {
            onReturn: () => void navigate({ ...routerTarget(query.from as string) } as never),
          })}
          now={now}
          linkFor={linkFor}
          filterName={filterName}
          {...(can('body.read') && {
            bodySearch: {
              onQuery: setBodyQ,
              results: bodyResults,
              failure: searchFailure(found.bodies),
            },
          })}
          {...(can('people.read') && {
            personSearch: {
              onQuery: setPersonQ,
              results: personResults,
              failure: searchFailure(found.people),
            },
          })}
          onNamed={(id, name) => setNamed({ id, name })}
          inspectorRef={inspectorRef}
          countsNote={
            <ReadNote
              data-slot="counts-error"
              className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) empty:border-0 empty:p-0"
              reads={[lanesRead.state]}
            >
              {COUNTS_FAILED}
            </ReadNote>
          }
        />
      </ZeroLinks>
    </UnmergeLiveProvider>
  );
}

/**
 * The applied body's or person's name: the one chosen in the menu, else one a row carries (the
 * body's name, the author's, the filer's, the asker's), else none (the chip says *One body*).
 */
export function nameOfFilter(
  query: InboxQuery,
  named: { id: string; name: string } | null,
  rows: readonly InboxRowView[],
): string | null {
  const f = query.filter;
  if (f === null || f.kind === 'age') return null;
  if (named !== null && named.id === f.id) return named.name;
  for (const r of rows) {
    if (f.kind === 'body' && r.body?.waterBodyId === f.id) return r.body.name;
    if (f.kind === 'about') {
      const people = [
        r.kind === 'flag' ? r.author : null,
        r.kind === 'flag' ? r.firstFiler : null,
        r.kind === 'request' || r.kind === 'place' ? r.firstAsker : null,
        r.kind === 'drawn' ? r.drawer : null,
        r.kind === 'ticket' ? r.person : null,
      ];
      const hit = people.find((p) => p?.userId === f.id);
      if (hit != null) return hit.displayName;
    }
  }
  return null;
}
