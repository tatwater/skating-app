import { api } from '@skating/convex/api';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';

import { routerTarget } from '@/lib/routerTarget';
import { useRole } from '@/lib/useRole';

import { type ListSummary, laneCountsFrom } from '../bodies/bodiesReads';
import { BODY_LANES } from '../bodies/bodyLanes';
import { safeReturnPath } from '../body/frame/bodySearch';
import { LOCK_START, lockSeenOf, nextLock } from '../inspector/lockModel';
import { isFailed, type Loadable, loaded, read, useConsoleReadSet } from '../reads/consoleReads';
import { useClockFor } from '../reads/readArgs';
import { useMinuteNow } from '../shell/presence';
import { CorpusTaskView } from './CorpusTaskView';
import type { CorpusInspectorState } from './inspector/CorpusInspector';
import { useTaskItem, useTaskPages, useTaskTail } from './list/taskReads';
import { placeAfter, type TaskQuery, taskListKey, taskSearchFor } from './taskSearch';
import { useCorpusSidebar } from './useCorpusSidebar';

/**
 * **A Corpus task lane, wired** — `BodiesRoute` draws it for a lane whose read is a task's
 * (`?lane=name-conflicts`), beside the same sidebar the library mounts (`useCorpusSidebar`). Its
 * place comes from the URL (validated by `validateBodiesSearch`, which takes `taskSearch`'s `tab`
 * and `item`); the lanes' counts, the lane's pages, its decided tail and the open task all come
 * through the console's one read layer; and the decided-only lock runs as a state machine over the
 * open task's live read (`admin/inspector/lockModel`), as the Inbox's does.
 *
 * - **The list is read against the list's clock**: the minute it was opened, held while it stays
 *   open, so a new minute never restarts the paging.
 * - **Every change of place is a navigation**, so the back button, a reload and a shared link put
 *   the page back as it was. Another tab or search closes a task opened from the list and keeps one
 *   that came by a link (`placeAfter`); a search, and opening a task beside one already open,
 *   replace the entry rather than stacking it.
 * - **Every read waits on `corpus.read`**; a viewer without it reads nothing of the tasks.
 * - **A link into the Body console carries the task's own address back** (`taskLinkTarget`), so the
 *   console's return control and ⇧⏎ land on this task, as the library's and the Inbox's links do.
 */
export function CorpusTaskRoute({ query }: { query: TaskQuery }) {
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  // The task's own address, whole (lane, tab, search, open item): the Body console's way back.
  const here = useRouterState({ select: (s) => s.location.href });
  const canRead = can('corpus.read');
  const key = taskListKey(query);
  const listNow = useClockFor(key);
  const inspectorRef = useRef<HTMLElement | null>(null);
  // The task last opened from the list; any other open task came by a link.
  const openedFromList = useRef<string | null>(null);

  const library = useLibraryCounts(listNow, can('body.read'));
  const { sidebar, tasks } = useCorpusSidebar({
    selected: query.lane.id,
    now: listNow,
    library: laneCountsFrom(library.counts, BODY_LANES),
    libraryReads: library.state === null ? [] : [library.state],
  });
  const pages = useTaskPages(
    canRead
      ? { lane: query.lane.task, tab: query.tab, q: query.q, now: listNow, memoryKey: key }
      : null,
  );
  const tailRead = useTaskTail(query.lane.task, query.tab, listNow, canRead);

  // ── The open task and its lock ──
  const itemRead = useTaskItem(query.item, query.lane.task, listNow, canRead);
  const itemValue = loaded(itemRead.state);
  const [lock, setLock] = useState(LOCK_START);
  const nextState = nextLock(lock, query.item, lockSeenOf(itemValue?.item));
  if (nextState !== lock) setLock(nextState);
  const inspector: CorpusInspectorState =
    query.item === null
      ? { kind: 'none' }
      : isFailed(itemRead.state)
        ? { kind: 'failed', retry: itemRead.retry, retrying: itemRead.retrying }
        : itemValue === undefined
          ? { kind: 'loading' }
          : itemValue.item === null
            ? itemValue.pending
              ? { kind: 'pending' }
              : { kind: 'missing' }
            : { kind: 'item', item: itemValue.item, phase: nextState.phase };

  // ── Navigation ──
  // Through the router's own search, never a hand-built query string.
  const go = (next: TaskQuery, replace = false) =>
    void navigate({
      to: '/admin/corpus',
      search: taskSearchFor(next) as never,
      ...(replace && { replace: true }),
    });
  const linkFor = useMemo(() => (path: string) => <Link {...taskLinkTarget(path, here)} />, [here]);

  return (
    <CorpusTaskView
      sidebar={sidebar}
      query={query}
      onQueryChange={(next) => {
        const fromList = query.item !== null && openedFromList.current === query.item;
        // A search moves within the list: it replaces the entry, as the library's does.
        go(placeAfter(query, next, fromList), next.q !== query.q);
      }}
      lanes={tasks.shown}
      list={{
        status: pages.status,
        rows: pages.rows,
        pending: pages.pending,
        retryPending: pages.failure?.pending === true,
      }}
      onLoadMore={pages.loadMore}
      {...(pages.failure !== null && { onRetryList: pages.failure.retry })}
      tail={
        query.tab === 'decided'
          ? null
          : {
              rows: loaded(tailRead.state)?.rows ?? [],
              failure: isFailed(tailRead.state)
                ? { retry: tailRead.retry, pending: tailRead.retrying }
                : null,
            }
      }
      inspector={inspector}
      onOpenItem={(taskId) => {
        openedFromList.current = taskId;
        go({ ...query, item: taskId }, query.item !== null);
        inspectorRef.current?.focus();
      }}
      onCloseItem={() => go({ ...query, item: null }, true)}
      now={now}
      linkFor={linkFor}
      inspectorRef={inspectorRef}
    />
  );
}

/**
 * A link out of a task, as the router takes it (`routerTarget`). One into the Body console
 * (*Open in Body →*, *History →*) carries `here`, the task's address, as `from` — validated as the
 * console validates it (`safeReturnPath`), so only a console list's path rides along. Any other
 * link goes as it is.
 */
export function taskLinkTarget(
  path: string,
  here: string,
): { to: string; search?: Record<string, string> } {
  const target = routerTarget(path);
  if (!target.to.startsWith('/admin/body/')) return target;
  const from = safeReturnPath(here);
  return from === null ? target : { ...target, search: { ...target.search, from } };
}

/**
 * The library lanes' counts beside a task lane: All's summary, as the library reads them on a lane
 * no server read lists. No counts while it loads or fails, or for a viewer without the library
 * (whose `state` is `null`: nothing asked, nothing to fail).
 */
function useLibraryCounts(
  now: number,
  enabled: boolean,
): { counts: ListSummary | undefined; state: Loadable<ListSummary> | null } {
  const { reads } = useConsoleReadSet({
    summary: enabled ? read(api.bodies.listSummary, { lane: 'all', now }) : null,
  });
  return {
    counts: enabled ? loaded(reads.summary) : undefined,
    state: enabled ? reads.summary : null,
  };
}
