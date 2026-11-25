import { useMemo } from 'react';

import { Button } from '@/components/kit/button';
import { MiddleList, type MiddleListItem } from '@/components/kit/middle-list';
import { RetryNote } from '@/components/kit/retry-note';
import { cn } from '@/lib/utils';

import type { CorpusRowView } from '../corpusTypes';
import { LIST_FAILED, READ_MORE, TAIL_FAILED } from '../words/corpusWords';
import type { TaskListStatus } from './taskReads';
import { type TaskRowView, taskRowView } from './taskRows';

/**
 * **A task lane's list** (boards 4.2, 4.3, the middle column): the lane's open tasks in the server's
 * order, then its decided tail under them, in one listbox (the kit's `MiddleList`: one tab stop, ↑↓,
 * type-ahead, ⏎ or Space opens). A failed page is said under the rows that stand, with *Try again*;
 * a list with more to read asks on from *Read on*.
 */

export type TaskListData = {
  status: TaskListStatus;
  rows: readonly CorpusRowView[];
  /** The server is still filing its stored tasks. */
  pending: boolean;
  retryPending?: boolean;
};

export type TaskTail = {
  title: string;
  rows: readonly CorpusRowView[];
  failure?: { retry: () => void; pending: boolean } | null;
};

export type TaskListProps = {
  /** The list's accessible name (the lane). */
  label: string;
  list: TaskListData;
  /** What an empty open list's end says. */
  emptyWords: string;
  tail?: TaskTail | null;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  className?: string;
};

const itemOf = (row: TaskRowView): MiddleListItem => ({
  id: row.id,
  title: row.title,
  ...(row.sub !== '' && { sub: row.sub }),
  ...(row.acres !== null && { meta: row.acres }),
});

export function TaskList({
  label,
  list,
  emptyWords,
  tail = null,
  selectedId,
  onOpen,
  onLoadMore,
  onRetry,
  className,
}: TaskListProps) {
  const items = useMemo(() => list.rows.map((r) => itemOf(taskRowView(r))), [list.rows]);
  const tailItems = useMemo(
    () => (tail === null ? [] : tail.rows.map((r) => itemOf(taskRowView(r)))),
    [tail],
  );
  // The decided tail is drawn only under a list whose every row is in.
  const showTail = list.status === 'done' && tailItems.length > 0;
  return (
    <div data-slot="corpus-task-list" className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <MiddleList
        className="min-h-0 flex-1"
        label={label}
        items={items}
        emptyLabel={emptyWords}
        loading={list.status === 'loading'}
        selectedId={selectedId}
        onOpen={onOpen}
        {...(showTail && tail !== null && { decided: { label: tail.title, items: tailItems } })}
      />
      {(list.status === 'more' || list.status === 'budget') && onLoadMore !== undefined && (
        <div className="flex shrink-0 justify-center border-0 border-t border-solid border-line px-gutter py-(--space-2)">
          <Button size="xs" data-slot="corpus-read-more" onClick={onLoadMore}>
            {READ_MORE}
          </Button>
        </div>
      )}
      <RetryNote
        data-slot="corpus-list-error"
        className="shrink-0 px-gutter empty:hidden"
        {...(onRetry !== undefined && { onRetry })}
        pending={list.retryPending === true}
      >
        {list.status === 'error' ? LIST_FAILED : null}
      </RetryNote>
      {tail?.failure != null && (
        <RetryNote
          data-slot="corpus-tail-error"
          className="shrink-0 px-gutter"
          onRetry={tail.failure.retry}
          pending={tail.failure.pending}
        >
          {TAIL_FAILED}
        </RetryNote>
      )}
    </div>
  );
}
