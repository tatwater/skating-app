import { api } from '@skating/convex/api';
import type { ReactNode } from 'react';

import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonBlock } from '@/components/kit/skeleton';
import { useTheme } from '@/components/theme-provider';
import { useRole } from '@/lib/useRole';
import { isFailed, type Loadable, read, useConsoleReadSet } from '../../reads/consoleReads';
import { useClockFor } from '../../reads/readArgs';
import { useInspectorContext } from '../inspector/inspectorContext';
import type { InboxItemView } from '../list/inboxTypes';
import { EMBED_HEIGHT, InboxMap } from './InboxMap';
import type { InboxMapView } from './inboxMapScene';
import { ITEM_MAP_WORDS as W } from './inboxMapWords';
import { type ItemMapRead, itemMapScene, kindHasMap } from './itemMapAdapters';

/**
 * **The map every Inbox handler drops into its map slot.** Reads the item's geometry
 * (`inbox.itemMap`, bounded on bytes, apart from the item's own read) at the console's read clock
 * for this item, turns it into the board's scene (`itemMapAdapters`), and draws the embed. A kind
 * with nothing to place — a ticket, a flag on a person, a comment, a Post or a photo — draws
 * nothing at all, not even a loading box; an answer with nothing in it collapses the same way.
 *
 * While it loads, the embed's box holds its place (a skeleton block at the embed's height); a read
 * that failed says so with *Try again*, as the console's other reads do. A short answer is said on
 * the map's own caption (`itemMapAdapters`).
 */
export function ItemMap({ item }: { item: InboxItemView }): ReactNode {
  const { can } = useRole();
  const hasMap = kindHasMap(item) && can('body.read');
  const ref = item.itemId as string;
  const now = useClockFor(`item-map:${ref}`);
  const { reads, retry, pending } = useConsoleReadSet({
    map: hasMap ? read(api.inbox.itemMap, { ref, now }) : null,
  });
  const { resolvedTheme } = useTheme();
  // The inspector's zone (the console's: the reader's own unless the page pins one), so a date on
  // the map reads on the same day as every date beside it.
  // On a narrow page (one pane at a time, the view's rule) the map is view-only: no zoom pair, and it
  // takes no pointer, so a swipe scrolls the inspector rather than the map.
  const { timeZone, narrow = false } = useInspectorContext();
  const mode = resolvedTheme === 'light' ? 'light' : 'dark';
  if (!hasMap) return null;
  return (
    <ItemMapView
      item={item}
      state={reads.map as Loadable<ItemMapRead>}
      onRetry={retry}
      retrying={pending}
      renderMap={(view) => (
        <InboxMap view={view} mode={mode} height={EMBED_HEIGHT} viewOnly={narrow} />
      )}
      {...(timeZone !== undefined ? { timeZone } : {})}
    />
  );
}

/** The map's states, from props: loading, failed, nothing to draw, or the embed. */
export function ItemMapView({
  item,
  state,
  onRetry,
  retrying = false,
  renderMap,
  timeZone,
  height = EMBED_HEIGHT,
}: {
  item: InboxItemView;
  state: Loadable<ItemMapRead>;
  onRetry?: () => void;
  retrying?: boolean;
  renderMap: (view: InboxMapView) => ReactNode;
  timeZone?: string;
  height?: number;
}): ReactNode {
  if (state === undefined) {
    return (
      <SkeletonBlock
        data-slot="item-map-loading"
        aria-label={W.loading}
        className="w-full"
        style={{ height }}
      />
    );
  }
  if (isFailed(state)) {
    return (
      <div
        data-slot="item-map-failed"
        className="flex w-full items-center px-gutter"
        style={{ height }}
      >
        <RetryNote onRetry={onRetry} pending={retrying}>
          {W.failed}
        </RetryNote>
      </div>
    );
  }
  const view = itemMapScene(item, state.map, timeZone);
  if (view === null) return null;
  return <div data-slot="item-map">{renderMap(view)}</div>;
}
