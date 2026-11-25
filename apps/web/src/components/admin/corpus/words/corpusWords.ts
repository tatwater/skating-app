import type {
  CORPUS_NOT_RECORDED,
  CorpusTaskDecision,
  CorpusTaskFacet,
  CorpusTaskLane,
} from '@skating/core';

/**
 * **Every word the Corpus task frame says that no board supplied**, in one module for the copy pass
 * (the boards' own words — the lanes' names, the tabs, *Open in Body →* — are here too, so the
 * frame reads one place). A handler's words are its own (`handlers/<Lane>/`).
 *
 * Nothing here says or implies anything about the ice (D3): a task is a question about the record —
 * which name a body displays, which class it carries — never about conditions.
 */

// ── The lanes (the boards' words) ───────────────────────────────────────────────────────────────────

/** The sidebar group the task lanes sit in. */
export const TASKS_GROUP = 'Tasks';

/** Each lane's name: the sidebar's, the page word's, the inspector's kicker. */
export const LANE_LABELS: Record<CorpusTaskLane, string> = {
  nameConflicts: 'Name conflicts',
  classConflicts: 'Class conflicts',
};

/** One task of the lane, the inspector head's kicker ("Name conflict"). */
export const TASK_HEAD: Record<CorpusTaskLane, string> = {
  nameConflicts: 'Name conflict',
  classConflicts: 'Class conflict',
};

/** The kicker beside the page word: "412 bodies" (every task is on one body). */
export const bodiesCount = (n: number) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? 'body' : 'bodies'}`;

/**
 * Each lane's facet tabs, the boards' words, in core's order after *All*. `notRecorded` has no
 * tab: a task whose facts aren't stored reads under *All* only.
 */
export const TAB_LABELS: {
  [L in CorpusTaskLane]: Record<Exclude<CorpusTaskFacet<L>, typeof CORPUS_NOT_RECORDED>, string>;
} = {
  nameConflicts: { different: 'Different', oneLetter: 'One letter', qualifier: 'Qualifier' },
  classConflicts: { wetlandOrLake: 'Wetland or lake', otherPairs: 'Other pairs' },
};

/** "2,263", "0.4" — acres as the list's column writes them: a tenth under ten, whole above. */
export function acresFigure(acres: number): string {
  const n = acres < 10 ? Math.round(acres * 10) / 10 : Math.round(acres);
  return n.toLocaleString('en-US');
}

/** "2,263 ac", "0.4 ac" — an area as the boards write it, from the server's acres. */
export function acresText(acres: number): string {
  return `${acresFigure(acres)} ac`;
}

/**
 * The line under each lane's page word, where the board draws one (4.3's): what the lane is, said
 * plainly, since navigation carries no tooltips. `null`: the board draws none.
 */
export const LANE_WHAT: Record<CorpusTaskLane, string | null> = {
  nameConflicts: null,
  classConflicts: 'The catalogs disagree on the kind of water',
};

/** The search's hint in each lane (the boards' words: names are found by either). */
export const SEARCH_HINT: Record<CorpusTaskLane, string> = {
  nameConflicts: 'Find a body by either name',
  classConflicts: 'Find a body by name, id or external id',
};
/** The search field's accessible name. */
export const SEARCH_LABEL = 'Find a body';

/** The list's column heads, per lane (the boards'; the order column is the server's, unsorted). */
export const COLUMN_HEADS: Record<CorpusTaskLane, readonly [string, string, string]> = {
  nameConflicts: ['Shown / the other', 'Kind', 'Acres'],
  classConflicts: ['Body', 'The catalogs say', 'Acres'],
};

/** A body stored with no name (`''`). */
export const UNNAMED = 'Unnamed water';

/** The end tab under every open row: "All 412". */
export const allOf = (n: number) => `All ${n.toLocaleString('en-US')}`;
/** Where a list stopped at the search's bound: more may match (the Inbox's words). */
export const MORE_TO_READ = 'More to read';
/** The next page, on its way (the Inbox's words). */
export const LOADING_MORE = 'Loading more';

/** The tab over every open task of the lane. */
export const TAB_ALL = 'All';
/** The lane's decided tasks, newest first. */
export const TAB_DECIDED = 'Decided';

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────

export const LANES_LABEL = 'Lanes';
export const LIST_LABEL = 'List';
export const INSPECTOR_LABEL = 'Task';
export const NOTHING_OPEN = 'Nothing open';
export const NOTHING_DECIDED = 'Nothing decided yet';
export const NOTHING_MATCHES = 'Nothing matches';
export const DECIDED_THIS_WEEK = 'Decided lately';
export const LIST_FAILED = 'The list couldn’t be read';
export const TAIL_FAILED = 'The decided tasks couldn’t be read';
export const READ_MORE = 'Read on';
export const COUNTS_FAILED = 'Counts couldn’t be read';
export const BACK_TO_LIST = 'Back to the list';
/** The server is still filing its stored tasks (the backfill): the list may lack some. */
export const LIST_PENDING = 'Still filing the corpus’s tasks: some may be missing.';
/** A class conflict whose catalogs' claims aren't stored yet. */
export const NOT_RECORDED = 'Not recorded';

// ── The inspector ─────────────────────────────────────────────────────────────────────────────────────

export const NOTHING_SELECTED = 'Nothing open: pick a task from the list.';
export const ITEM_FAILED = 'This task couldn’t be read';
export const NO_SUCH_TASK = 'No such task';
export const NO_SUCH_TASK_BODY =
  'Nothing here by that link: the task may have left the lane when its question went away.';
export const ITEM_PENDING = 'Not yet';
export const ITEM_PENDING_BODY =
  'The corpus’s tasks are still being filed. This one may be there once they are.';
/** The pane head's link to the body's console. */
export const OPEN_IN_BODY = 'Open in Body →';
/** The lock's link to the body's history. */
export const HISTORY = 'History →';
/** A decider whose profile is gone. */
export const DECIDER_GONE = 'someone no longer here';

/** What each decision is called on the lock's line ("Decided by … · 14:42 · renamed"). */
export const DECISION_WORDS: Record<CorpusTaskLane, Record<CorpusTaskDecision, string>> = {
  nameConflicts: { kept: 'name kept', renamed: 'renamed', reclassed: 'reclassed' },
  classConflicts: { kept: 'class kept', renamed: 'renamed', reclassed: 'reclassed' },
};

// The placeholder's facts (a lane whose handler hasn't landed).
export const FACT_LANE = 'Lane';
export const FACT_FILED = 'Filed';
export const FACT_BODY = 'Body';
export const FACT_WHERE = 'Where';
export const FACT_CLASS = 'Class';
export const FACT_ACRES = 'Acres';
export const FACT_NAMES = 'Names';
export const FACT_CLAIMS = 'Catalogs';
/** The placeholder's one line: this lane decides nowhere else yet, so the body's console is the way. */
export const PLACEHOLDER_LINE =
  'This lane’s decisions aren’t drawn here yet. The body’s console holds its record.';
