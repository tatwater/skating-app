import {
  CORPUS_NOT_RECORDED,
  CORPUS_TASK_FACETS,
  CORPUS_TASK_LANES,
  type CorpusTaskFacet,
  type CorpusTaskLane,
} from '@skating/core';

import { LANE_LABELS, TAB_LABELS, TASKS_GROUP } from './words/corpusWords';

/**
 * **The Corpus task lanes, as data** — the sidebar entry, the page word, the kicker's word and the
 * facet tabs of each lane core builds (`CORPUS_TASK_LANES`), so a lane 6b–6d adds is an entry here
 * (the type checker names it: the table is exhaustive over core's union) and the frame draws it.
 *
 * The URL names a lane by its `id` (`?lane=name-conflicts`), the server by its `task`
 * (`nameConflicts`). A lane joins the sidebar in the PR that builds it (D300): an id with no entry is
 * dropped by the search, never drawn unbuilt.
 */

/** A facet a tab can show: every facet of the lane but `notRecorded`, which reads under *All*. */
export type TaskFacetTab<L extends CorpusTaskLane = CorpusTaskLane> = Exclude<
  CorpusTaskFacet<L>,
  typeof CORPUS_NOT_RECORDED
>;

export type TaskLaneEntry<L extends CorpusTaskLane = CorpusTaskLane> = {
  /** The lane in the URL (`?lane=`) and in the sidebar. */
  id: string;
  /** The lane as the server knows it. */
  task: L;
  /** The sidebar group's kicker. */
  group: string;
  /** The sidebar's words, and the page word. */
  label: string;
  /** The facet tabs after *All*, in the board's order, each with its words. */
  tabs: readonly { id: TaskFacetTab<L>; label: string }[];
};

/** The URL id of each lane: the boards' names, kebab-cased. */
const IDS: Record<CorpusTaskLane, string> = {
  nameConflicts: 'name-conflicts',
  classConflicts: 'class-conflicts',
};

function entry<L extends CorpusTaskLane>(task: L): TaskLaneEntry<L> {
  const labels = TAB_LABELS[task] as Record<TaskFacetTab<L>, string>;
  const facets = CORPUS_TASK_FACETS[task] as readonly CorpusTaskFacet<L>[];
  return {
    id: IDS[task],
    task,
    group: TASKS_GROUP,
    label: LANE_LABELS[task],
    tabs: facets
      .filter((f): f is TaskFacetTab<L> => f !== CORPUS_NOT_RECORDED)
      .map((id) => ({ id, label: labels[id] })),
  };
}

/** Every task lane, by its server name. */
export const TASK_LANES: { [L in CorpusTaskLane]: TaskLaneEntry<L> } = {
  nameConflicts: entry('nameConflicts'),
  classConflicts: entry('classConflicts'),
};

/** The task lanes in the sidebar's order (core's). */
export const TASK_LANE_LIST: readonly TaskLaneEntry[] = CORPUS_TASK_LANES.map(
  (task) => TASK_LANES[task] as TaskLaneEntry,
);

/**
 * Where the Corpus's tasks start from elsewhere (Inbox Zero's *Corpus →*): the first lane, in the
 * sidebar's order, with an open task — or the first lane when none has one, or no count is read.
 */
export function firstOpenLane(
  lanes: { lanes: Record<CorpusTaskLane, { open: number }> } | undefined,
): TaskLaneEntry {
  return (
    TASK_LANE_LIST.find((l) => (lanes?.lanes[l.task].open ?? 0) > 0) ??
    (TASK_LANE_LIST[0] as TaskLaneEntry)
  );
}

/** Every task lane's open tasks, added up. */
export function openTotal(lanes: { lanes: Record<CorpusTaskLane, { open: number }> }): number {
  return TASK_LANE_LIST.reduce((sum, l) => sum + lanes.lanes[l.task].open, 0);
}

/** The task lane a URL id names, or `null` (a library lane's id, a lane not built, junk). */
export function taskLaneById(id: string | undefined): TaskLaneEntry | null {
  return TASK_LANE_LIST.find((l) => l.id === id) ?? null;
}
