import { api } from '@skating/convex/api';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';

import { routerTarget } from '@/lib/routerTarget';
import { useRole } from '@/lib/useRole';

import { type ListSummary, laneCountsFrom } from '../bodies/bodiesReads';
import { BODY_LANES, DEFAULT_LANE_ID } from '../bodies/bodyLanes';
import { LOCK_START, lockSeenOf, nextLock } from '../inspector/lockModel';
import type { Count } from '../overview/overviewModel';
import { isFailed, loaded, read, useConsoleReadSet } from '../reads/consoleReads';
import { ReadNote } from '../reads/ReadNote';
import { useClockFor } from '../reads/readArgs';
import { useMinuteNow } from '../shell/presence';
import { CorpusLanes, type SidebarLane } from './CorpusLanes';
import { CorpusTaskView } from './CorpusTaskView';
import type { CorpusLanesView } from './corpusTypes';
import type { CorpusInspectorState } from './inspector/CorpusInspector';
import { useCorpusLanes, useTaskItem, useTaskPages, useTaskTail } from './list/taskReads';
import { TASK_LANE_LIST, taskLaneById } from './taskLanes';
import { placeAfter, type TaskQuery, taskListKey, taskSearchFor } from './taskSearch';
import { COUNTS_FAILED } from './words/corpusWords';

/**
 * **A Corpus task lane, wired** — `BodiesRoute` draws it for a lane whose read is a task's
 * (`?lane=name-conflicts`), beside the same sidebar the library mounts. Its place comes from the URL
 * (validated by `validateBodiesSearch`, which takes `taskSearch`'s `tab` and `item`); the lanes'
 * counts, the lane's pages, its decided tail and the open task all come through the console's one
 * read layer; and the decided-only lock runs as a state machine over the open task's live read
 * (`admin/inspector/lockModel`), as the Inbox's does.
 *
 * - **The list is read against the list's clock**: the minute it was opened, held while it stays
 *   open, so a new minute never restarts the paging.
 * - **Every change of place is a navigation**, so the back button, a reload and a shared link put
 *   the page back as it was. Another tab or search closes a task opened from the list and keeps one
 *   that came by a link (`placeAfter`); opening a task beside one already open replaces the entry.
 * - **Every read waits on `corpus.read`**; a viewer without it reads nothing.
 */
export function CorpusTaskRoute({ query }: { query: TaskQuery }) {
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  const canRead = can('corpus.read');
  const key = taskListKey(query);
  const listNow = useClockFor(key);
  const inspectorRef = useRef<HTMLElement | null>(null);
  // The task last opened from the list; any other open task came by a link.
  const openedFromList = useRef<string | null>(null);

  const lanesRead = useCorpusLanes(listNow, canRead);
  const library = useLibraryCounts(listNow, can('body.read'));
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
  const openLane = (id: string) => {
    const task = taskLaneById(id);
    void navigate({
      to: '/admin/corpus',
      search: (task !== null
        ? taskSearchFor({ lane: task, tab: null, item: null, q: '' })
        : id === DEFAULT_LANE_ID
          ? {}
          : { lane: id }) as never,
    });
  };

  const linkFor = useMemo(() => (path: string) => <Link {...routerTarget(path)} />, []);

  return (
    <CorpusTaskView
      sidebar={
        <CorpusLanes
          lanes={sidebarLanes(lanesRead.shown, library)}
          selected={query.lane.id}
          onSelect={openLane}
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
      }
      query={query}
      onQueryChange={(next) =>
        go(placeAfter(query, next, query.item !== null && openedFromList.current === query.item))
      }
      lanes={lanesRead.shown}
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
 * The library lanes' counts beside a task lane: All's summary, as the library reads them on a lane
 * no server read lists. `undefined` while it loads, fails, or for a viewer without the library.
 */
function useLibraryCounts(now: number, enabled: boolean): ListSummary | undefined {
  const { reads } = useConsoleReadSet({
    summary: enabled ? read(api.bodies.listSummary, { lane: 'all', now }) : null,
  });
  return loaded(reads.summary);
}

/** The sidebar's lanes: the task lanes first, then the library's, each with its count. */
export function sidebarLanes(
  tasks: CorpusLanesView | undefined,
  library: ListSummary | undefined,
): SidebarLane[] {
  const libraryCounts = laneCountsFrom(library, BODY_LANES);
  const taskCount = (open: number | undefined): Count | null =>
    open === undefined || tasks?.pending === true ? null : { count: open, capped: false };
  return [
    ...TASK_LANE_LIST.map((l) => ({
      id: l.id,
      group: l.group,
      label: l.label,
      count: taskCount(tasks?.lanes[l.task].open),
    })),
    ...BODY_LANES.map((l) => ({
      id: l.id,
      group: l.group,
      label: l.label,
      count: libraryCounts[l.id] ?? null,
    })),
  ];
}
