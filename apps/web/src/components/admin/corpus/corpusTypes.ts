import type { api } from '@skating/convex/api';
import type { CorpusTaskLane } from '@skating/core';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

/**
 * **The Corpus tasks' reads and writes, as the page holds them** — derived from the published
 * functions (`packages/convex/convex/corpusTasks.ts` and `corpusWrites.ts`, a contract), so the page
 * can't drift from what the server returns. Every Corpus task file (the frame's and each handler's)
 * reads its server shapes from here, never from the server's own modules.
 */

/** `corpusTasks.lanes`: each task lane's open count and its facets', `pending`. */
export type CorpusLanesView = FunctionReturnType<typeof api.corpusTasks.lanes>;
/** One lane's figures. */
export type CorpusLaneFigures = CorpusLanesView['lanes'][CorpusTaskLane];

/** `corpusTasks.listPage`: one page of the chain. */
export type CorpusListPage = FunctionReturnType<typeof api.corpusTasks.listPage>;
/** What one page of the chain is asked. */
export type CorpusListArgs = FunctionArgs<typeof api.corpusTasks.listPage>;
/** A list row, one variant per lane. */
export type CorpusRowView = CorpusListPage['rows'][number];

/** `corpusTasks.item`: the task behind `?item=`, or none (`item: null`, *No such task*). */
export type CorpusTaskItemRead = FunctionReturnType<typeof api.corpusTasks.item>;
/** One task as its handler draws it, one variant per lane. */
export type CorpusTaskItemView = NonNullable<CorpusTaskItemRead['item']>;
/** One lane's item: `CorpusItemOf<'nameConflicts'>` is what the Names handler draws. */
export type CorpusItemOf<L extends CorpusTaskLane> = Extract<CorpusTaskItemView, { lane: L }>;
/** One lane's row. */
export type CorpusRowOf<L extends CorpusTaskLane> = Extract<CorpusRowView, { lane: L }>;

/** Who decided a task, when and what, as the server sends it. */
export type CorpusDecidedView = NonNullable<CorpusTaskItemView['decided']>;
/** For each verb a handler draws: absent (not this lane's), `null` (allowed) or the refusal. */
export type CorpusCan = CorpusTaskItemView['can'];

/** What a decision answers: the task, its audit row (the toast's Undo) and the undo offer. */
export type CorpusDecisionResult = FunctionReturnType<typeof api.corpusWrites.decideName>;
