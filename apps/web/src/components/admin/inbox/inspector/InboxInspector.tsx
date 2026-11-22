import type { ReactElement, ReactNode, RefObject } from 'react';

import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';

import type { InboxItemView } from '../list/inboxTypes';
import {
  HISTORY,
  ITEM_FAILED,
  ITEM_PENDING,
  ITEM_PENDING_BODY,
  KIND_HEAD,
  NO_SUCH_ITEM,
  NO_SUCH_ITEM_BODY,
  NOTHING_SELECTED,
} from '../words/inboxWords';
import { ComingSoonLink } from './ComingSoonLink';
import { HANDLERS, type HandlerKey, type InboxHandler, registeredHandler } from './handlerRegistry';
import { InspectorFrame, InspectorHeadTitle } from './InspectorFrame';
import { InspectorProvider } from './inspectorContext';
import { decidedStateOf, isDecidedPhase, type LockPhase } from './lockModel';
import { PlaceholderHandler } from './PlaceholderHandler';

/**
 * **The inspector column's contents, from props** — the open item drawn by its handler (or the
 * placeholder, for a kind whose handler hasn't landed), or what stands in its place: *No such item*
 * (a ref to nothing, or an item withdrawn while open — the list stays usable), *Still being
 * prepared* (the server's items aren't all stored yet, so a ref may not resolve *yet*), a failed
 * read with *Try again*, a loading frame, or — nothing open — the zero page or *Nothing open*.
 *
 * It provides the inspector's context every frame and handler reads: the pane their keys bind to,
 * the way back to the list, the item's *History →* (a live link to the page that holds it, or *Coming
 * soon* where that page is Reports, D286), and the clock.
 */

export type InspectorState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'missing' }
  | { kind: 'pending' }
  /** The read refuses this viewer (a support ticket, without support's read): its own words. */
  | { kind: 'refused'; words: string }
  | { kind: 'item'; item: InboxItemView; phase: LockPhase };

export type InboxInspectorProps = {
  state: InspectorState;
  now: number;
  timeZone?: string;
  /** The inspector column: what handlers bind their action keys to. */
  pane: RefObject<HTMLElement | null>;
  /** Back to the list (the lock's *Back to the queue*). */
  onBack?: () => void;
  /** The router's link for a console path (an anchor in a story). */
  linkFor: (path: string) => ReactElement;
  /** Nothing open and nothing waiting: Inbox zero (2.9). */
  zero?: ReactNode;
  /** The handlers by key; the builders' registry unless a story passes its own. */
  registry?: ReadonlyMap<HandlerKey, InboxHandler>;
  /** The viewer may read Support: the placeholder points at the Support page only then. */
  canReadSupport?: boolean;
  /** One pane at a time (the view's narrow rule): an item's map is view-only. */
  narrow?: boolean;
};

export function InboxInspector({
  state,
  now,
  timeZone,
  pane,
  onBack,
  linkFor,
  zero,
  registry = HANDLERS,
  canReadSupport = false,
  narrow = false,
}: InboxInspectorProps) {
  const item = state.kind === 'item' ? state.item : null;
  const decidedOnOpen = state.kind === 'item' && state.phase === 'onOpen';
  return (
    <InspectorProvider
      value={{
        pane,
        onBack,
        history: item === null ? undefined : historyLink(item, linkFor),
        decidedOnOpen,
        now,
        timeZone,
        linkFor,
        canReadSupport,
        narrow,
      }}
    >
      <Contents state={state} now={now} zero={zero} registry={registry} />
    </InspectorProvider>
  );
}

function Contents({
  state,
  now,
  zero,
  registry,
}: {
  state: InspectorState;
  now: number;
  zero: ReactNode;
  registry: ReadonlyMap<HandlerKey, InboxHandler>;
}) {
  switch (state.kind) {
    case 'none':
      return (
        zero ?? (
          <ListEnd data-slot="inbox-nothing-open" className="mt-(--space-3)">
            {NOTHING_SELECTED}
          </ListEnd>
        )
      );
    case 'loading':
      return (
        <InspectorFrame head={<SkeletonText width="40%" className="text-assist" />}>
          <div
            data-slot="inbox-item-loading"
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
            data-slot="inbox-item-error"
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
        <InspectorFrame head={<InspectorHeadTitle>{NO_SUCH_ITEM}</InspectorHeadTitle>}>
          <p
            data-slot="inbox-no-such-item"
            className="m-0 px-gutter pt-(--space-4) text-row leading-body text-fg2"
          >
            {NO_SUCH_ITEM_BODY}
          </p>
        </InspectorFrame>
      );
    case 'refused':
      return (
        <InspectorFrame head={<InspectorHeadTitle>{KIND_HEAD.ticket}</InspectorHeadTitle>}>
          <p
            data-slot="inbox-item-refused"
            className="m-0 px-gutter pt-(--space-4) text-row leading-body text-fg2"
          >
            {state.words}
          </p>
        </InspectorFrame>
      );
    case 'pending':
      return (
        <InspectorFrame head={<InspectorHeadTitle>{ITEM_PENDING}</InspectorHeadTitle>}>
          <p
            data-slot="inbox-item-pending"
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
        isDecidedPhase(phase) && item.decided !== null ? decidedStateOf(item.decided) : null;
      return <Handler item={item} locked={locked} now={now} />;
    }
  }
}

// ── History → ────────────────────────────────────────────────────────────────────────────────

/** Where an item's history lives (D226): Reports for content, the Body console, People. */
export type HistoryPlace =
  | { kind: 'reports' }
  | { kind: 'body'; id: string; tab?: string }
  | { kind: 'person'; id: string };

/** The page that holds an item's history, or `null` when none names it. */
export function historyOf(item: InboxItemView): HistoryPlace | null {
  switch (item.kind) {
    case 'flag': {
      const t = item.target;
      if (!t.exists) return null;
      switch (t.targetType) {
        case 'user':
          return { kind: 'person', id: t.person.person.userId };
        case 'waterbody':
          return { kind: 'body', id: t.body.waterBodyId };
        case 'hazard':
          return t.hazard.body === null
            ? null
            : { kind: 'body', id: t.hazard.body.waterBodyId, tab: 'hazards' };
        case 'accessAlert':
          return { kind: 'body', id: t.alert.body.waterBodyId, tab: 'access' };
        default:
          // A report, a Post, a comment or a photo: its history is Reports', not built yet.
          return { kind: 'reports' };
      }
    }
    case 'access':
      return { kind: 'body', id: item.body.waterBodyId, tab: 'access' };
    case 'request':
      return item.body === null ? null : { kind: 'body', id: item.body.waterBodyId };
    case 'place':
      return { kind: 'body', id: item.body.waterBodyId, tab: 'places' };
    case 'drawn':
      return { kind: 'body', id: item.body.waterBodyId };
    case 'ticket':
      return item.person === null ? null : { kind: 'person', id: item.person.person.userId };
  }
}

/** A console path for a history place that exists (`null` for Reports, which doesn't yet). */
export function historyPath(place: HistoryPlace): string | null {
  switch (place.kind) {
    case 'reports':
      return null;
    case 'body':
      return `/admin/body/${encodeURIComponent(place.id)}${place.tab === undefined ? '' : `?tab=${place.tab}`}`;
    case 'person':
      return `/admin/people/${encodeURIComponent(place.id)}`;
  }
}

function historyLink(item: InboxItemView, linkFor: (path: string) => ReactElement): ReactNode {
  const place = historyOf(item);
  if (place === null) return undefined;
  const path = historyPath(place);
  if (path === null) return <ComingSoonLink data-slot="inbox-history">{HISTORY}</ComingSoonLink>;
  return (
    <Button
      variant="link"
      size="xs"
      data-slot="inbox-history"
      nativeButton={false}
      render={linkFor(path)}
    >
      {HISTORY}
    </Button>
  );
}
