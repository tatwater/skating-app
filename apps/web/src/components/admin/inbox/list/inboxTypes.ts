import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

/**
 * **The Inbox reads' answers, as the page holds them** — derived from the published functions
 * (`packages/convex/convex/inbox.ts`, a contract), so the page can't drift from what the server
 * returns. Every Inbox file reads its server shapes from here.
 */

/** `inbox.lanes`: the lanes' counts, the decided total, *Today*, `pending`. */
export type InboxLanesView = FunctionReturnType<typeof api.inbox.lanes>;
/** One lane's figures. */
export type InboxLaneFigures = InboxLanesView['lanes'][number];
/** `inbox.listPage`: one page of the chain. */
export type InboxListPage = FunctionReturnType<typeof api.inbox.listPage>;
/** A list row, one variant per kind. */
export type InboxRowView = InboxListPage['rows'][number];
/** `inbox.tail`: a lane's *Decided this week*. */
export type InboxTailView = FunctionReturnType<typeof api.inbox.tail>;
/** `inbox.today`: the day so far (2.9). */
export type InboxTodayView = FunctionReturnType<typeof api.inbox.today>;
/** `inbox.item`: the item behind `?item=`, or none. */
export type InboxItemRead = FunctionReturnType<typeof api.inbox.item>;
/** One item as its handler draws it, one variant per kind. */
export type InboxItemView = NonNullable<InboxItemRead['item']>;
/** Who decided an item, when and what, as the server sends it. */
export type InboxDecidedView = NonNullable<InboxItemView['decided']>;
/** For each verb a handler draws: `null` (allowed) or the write's refusal. */
export type InboxCan = InboxItemView['can'];
