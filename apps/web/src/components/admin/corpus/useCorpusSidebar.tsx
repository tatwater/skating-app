import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { useRole } from '@/lib/useRole';

import { laneStart, searchFor } from '../bodies/bodiesSearch';
import { BODY_LANES, laneById } from '../bodies/bodyLanes';
import type { Count } from '../overview/overviewModel';
import type { Loadable } from '../reads/consoleReads';
import { ReadNote } from '../reads/ReadNote';
import { CorpusLanes, type SidebarLane } from './CorpusLanes';
import type { CorpusLanesView } from './corpusTypes';
import { type CorpusLanesState, useCorpusLanes } from './list/taskReads';
import { TASK_LANE_LIST, taskLaneById } from './taskLanes';
import { taskSearchFor } from './taskSearch';
import { COUNTS_FAILED } from './words/corpusWords';

/**
 * **The one Corpus sidebar, wired** — mounted by both views: the library's (`BodiesView`, through
 * `BodiesRoute`) and a task lane's (`CorpusTaskView`, through `CorpusTaskRoute`). The task lanes
 * count from `corpusTasks.lanes` (read here, behind `corpus.read`); the library's lanes from the
 * counts its caller already reads. One failure note at the lanes' foot speaks for both reads.
 *
 * Opening a lane resets the place: a task lane opens on *All*, nothing open, no search; a library
 * lane as the library opens it (`laneStart`). The lane on screen again keeps its place.
 */
export function useCorpusSidebar({
  selected,
  now,
  library,
  libraryReads,
}: {
  /** The lane on screen (its URL id). */
  selected: string;
  /** The clock the lanes' read is asked on (the list's). */
  now: number;
  /** The library lanes' counts, by id, as the caller reads them. */
  library: Readonly<Partial<Record<string, Count | null>>>;
  /** The reads behind `library`, for the failure note. */
  libraryReads: readonly Loadable<unknown>[];
}): { sidebar: ReactNode; tasks: CorpusLanesState } {
  const navigate = useNavigate();
  const { can } = useRole();
  const tasks = useCorpusLanes(now, can('corpus.read'));
  const openLane = (id: string) => {
    const task = taskLaneById(id);
    void navigate({
      to: '/admin/corpus',
      search: (task !== null
        ? taskSearchFor({ lane: task, tab: null, item: null, q: '' })
        : searchFor(laneStart(laneById(id)))) as never,
    });
  };
  return {
    tasks,
    sidebar: (
      <CorpusLanes
        lanes={sidebarLanes(tasks.shown, library)}
        selected={selected}
        onSelect={openLane}
        countsNote={
          <ReadNote
            data-slot="counts-error"
            className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) empty:border-0 empty:p-0"
            reads={[tasks.state, ...libraryReads]}
          >
            {COUNTS_FAILED}
          </ReadNote>
        }
      />
    ),
  };
}

/**
 * The sidebar's lanes, in its order — the task lanes (*Tasks*), then the library's (*Views*,
 * *Standing*) — each with its count: a task lane's from the lanes read (none while the server is
 * still filing, never a partial figure), a library lane's from `library`.
 */
export function sidebarLanes(
  tasks: CorpusLanesView | undefined,
  library: Readonly<Partial<Record<string, Count | null>>>,
): SidebarLane[] {
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
      count: library[l.id] ?? null,
    })),
  ];
}
