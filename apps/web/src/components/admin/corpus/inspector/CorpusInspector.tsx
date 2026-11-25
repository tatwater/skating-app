import type { CorpusTaskLane } from '@skating/core';
import type { ReactElement, ReactNode, RefObject } from 'react';

import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';

import { InspectorFrame, InspectorHeadTitle } from '../../inspector/InspectorFrame';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { isDecidedPhase, type LockPhase } from '../../inspector/lockModel';
import type { CorpusTaskItemView } from '../corpusTypes';
import {
  HISTORY,
  ITEM_FAILED,
  ITEM_PENDING,
  ITEM_PENDING_BODY,
  NO_SUCH_TASK,
  NO_SUCH_TASK_BODY,
  NOTHING_SELECTED,
} from '../words/corpusWords';
import { bodyPath } from './BodyLink';
import { decidedStateOf } from './corpusLock';
import { CORPUS_HANDLERS, type CorpusHandler, registeredHandler } from './handlerRegistry';
import { PlaceholderHandler } from './PlaceholderHandler';

/**
 * **The Corpus task inspector's contents, from props** — the open task drawn by its lane's handler
 * (or the placeholder, for a lane whose handler hasn't landed), or what stands in its place: *No such
 * task* (a ref to nothing, or a task that left while open — the list stays usable), *Not yet* (the
 * server's tasks aren't all filed, so a ref may not resolve *yet*), a failed read with *Try again*, a
 * loading frame, or — nothing open — *Nothing open*.
 *
 * It provides the inspector's context every frame and handler reads (the shared
 * `admin/inspector/`): the pane their keys bind to, the way back to the list, the task's *History →*
 * (its body's console, which holds the body's record), the clock, and the router's links.
 */

export type CorpusInspectorState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'missing' }
  | { kind: 'pending' }
  | { kind: 'item'; item: CorpusTaskItemView; phase: LockPhase };

export type CorpusInspectorProps = {
  state: CorpusInspectorState;
  now: number;
  timeZone?: string;
  /** The inspector column: what handlers bind their action keys to. */
  pane: RefObject<HTMLElement | null>;
  /** Back to the list (the lock's *Back to the queue*). */
  onBack?: () => void;
  /** The router's link for a console path (an anchor in a story). */
  linkFor: (path: string) => ReactElement;
  /** The handlers by lane; the builders' registry unless a story passes its own. */
  registry?: ReadonlyMap<CorpusTaskLane, CorpusHandler>;
  /** One pane at a time (the view's narrow rule): an item's map is view-only. */
  narrow?: boolean;
};

export function CorpusInspector({
  state,
  now,
  timeZone,
  pane,
  onBack,
  linkFor,
  registry = CORPUS_HANDLERS,
  narrow = false,
}: CorpusInspectorProps) {
  const item = state.kind === 'item' ? state.item : null;
  return (
    <InspectorProvider
      value={{
        pane,
        onBack,
        history: item === null ? undefined : historyLink(item, linkFor),
        decidedOnOpen: state.kind === 'item' && state.phase === 'onOpen',
        now,
        timeZone,
        linkFor,
        narrow,
      }}
    >
      <Contents state={state} now={now} registry={registry} />
    </InspectorProvider>
  );
}

function Contents({
  state,
  now,
  registry,
}: {
  state: CorpusInspectorState;
  now: number;
  registry: ReadonlyMap<CorpusTaskLane, CorpusHandler>;
}) {
  switch (state.kind) {
    case 'none':
      return (
        <ListEnd data-slot="corpus-nothing-open" className="mt-(--space-3)">
          {NOTHING_SELECTED}
        </ListEnd>
      );
    case 'loading':
      return (
        <InspectorFrame head={<SkeletonText width="40%" className="text-assist" />}>
          <div
            data-slot="corpus-item-loading"
            aria-busy="true"
            className="flex flex-col gap-(--space-3) px-gutter pt-(--space-4)"
          >
            <SkeletonText width="70%" className="text-disp" />
            <SkeletonText width="90%" className="text-body" />
            <SkeletonText width="80%" className="text-body" />
          </div>
        </InspectorFrame>
      );
    case 'failed':
      return (
        <InspectorFrame head={<InspectorHeadTitle>{ITEM_FAILED}</InspectorHeadTitle>}>
          <RetryNote
            data-slot="corpus-item-error"
            className="px-gutter pt-(--space-4)"
            onRetry={state.retry}
            pending={state.retrying}
          >
            {ITEM_FAILED}
          </RetryNote>
        </InspectorFrame>
      );
    case 'missing':
      return (
        <InspectorFrame head={<InspectorHeadTitle>{NO_SUCH_TASK}</InspectorHeadTitle>}>
          <p
            data-slot="corpus-no-such-task"
            className="m-0 px-gutter pt-(--space-4) text-row leading-body text-fg2"
          >
            {NO_SUCH_TASK_BODY}
          </p>
        </InspectorFrame>
      );
    case 'pending':
      return (
        <InspectorFrame head={<InspectorHeadTitle>{ITEM_PENDING}</InspectorHeadTitle>}>
          <p
            data-slot="corpus-item-pending"
            className="m-0 px-gutter pt-(--space-4) text-row leading-body text-fg2"
          >
            {ITEM_PENDING_BODY}
          </p>
        </InspectorFrame>
      );
    case 'item': {
      const { item, phase } = state;
      const Handler = registeredHandler(item, registry) ?? PlaceholderHandler;
      const locked =
        isDecidedPhase(phase) && item.decided !== null
          ? decidedStateOf(item.lane, item.decided)
          : null;
      return <Handler item={item} locked={locked} now={now} />;
    }
  }
}

/** The task's *History →*: its body's console, where the body's record is. */
function historyLink(item: CorpusTaskItemView, linkFor: (path: string) => ReactElement): ReactNode {
  return (
    <Button
      variant="link"
      size="xs"
      data-slot="corpus-history"
      nativeButton={false}
      render={linkFor(bodyPath(item.body.id))}
    >
      {HISTORY}
    </Button>
  );
}
