import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { ReactNode } from 'react';

import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonBlock } from '@/components/kit/skeleton';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import type { BodyDoc } from '../../bodies/bodiesReads';
import { CATALOG_TAGS } from '../../body/tabs/names/namesModel';
import { InboxMap } from '../../inbox/map/InboxMap';
import type { EmbedBody, InboxMapView } from '../../inbox/map/inboxMapScene';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { isFailed, type Loadable, read, useConsoleReadSet } from '../../reads/consoleReads';
import { embedOutline, type HeadMapInput, headMapScene } from './headMapScene';
import { HEAD_MAP_WORDS as W } from './headMapWords';

/**
 * **A Corpus task's head map** (boards 4.2 and 4.3): real geography, square beside the pane head
 * (Review 11 rule 6) or a band across the inspector, drawn by the Inbox's embed (`InboxMap`: the
 * Body console's camera, chrome and scene tables, no rack, a legend plate in the corner).
 *
 * **What it reads.** The task's item carries no geometry, so the map reads it apart from the item,
 * as the Inbox's `ItemMap` does: the body's stored record (`waterBodies.get`, the read the Bodies
 * preview and every Body tab already make) for its outline, and the same for each neighbor the item
 * names (at most three). A neighbor that fails or is gone is simply not drawn; the body failing
 * says so with *Try again*. A one-purpose bounded read of the outlines is a server ask.
 */

export type HeadMapState = Loadable<HeadMapInput | null>;

type Neighbor = { id: Id<'waterBodies'>; name: string };

const MAX_NEIGHBORS = 3;

/** A stored body as the embed draws it, or `null` when it holds nothing drawable. */
export function embedBodyOf(doc: Pick<BodyDoc, '_id' | 'name' | 'polygon'>): EmbedBody | null {
  const outline = embedOutline(doc.polygon);
  return outline === null ? null : { id: doc._id, name: doc.name, outline };
}

/** `waterBodies.get`'s answer, as the stored record it holds (gone or unlisted: none). */
type GetAnswer = { available: false } | { available: true; body: BodyDoc } | null;
const docOf = (answer: GetAnswer): BodyDoc | null => (answer?.available ? answer.body : null);

/** The legend's words for the body's outline: whose drawing it is. */
export function outlineLabelOf(doc: Pick<BodyDoc, 'geometrySource'>): string {
  const source = doc.geometrySource;
  return W.outline(source === undefined ? null : CATALOG_TAGS[source]);
}

/** The reads' answers as the view's state: the body decides it; the neighbors only add. */
export function headMapState(
  body: Loadable<GetAnswer>,
  neighbors: readonly Loadable<GetAnswer>[],
  legend: boolean,
): HeadMapState {
  if (body === undefined || isFailed(body)) return body;
  const doc = docOf(body);
  const own = doc === null ? null : embedBodyOf(doc);
  if (doc === null || own === null) return null;
  const drawn = neighbors.flatMap((n) => {
    if (n === undefined || isFailed(n)) return [];
    const d = docOf(n);
    const e = d === null ? null : embedBodyOf(d);
    return e === null ? [] : [e];
  });
  return {
    body: own,
    neighbors: drawn,
    ...(legend ? { outlineLabel: outlineLabelOf(doc) } : {}),
  };
}

export function CorpusHeadMap({
  bodyId,
  neighbors,
  height,
  square = false,
  legend = false,
}: {
  bodyId: Id<'waterBodies'>;
  neighbors: readonly Neighbor[];
  /** The map's height, px: the board's. */
  height: number;
  /** Square (beside the pane head's block): its width is its height. */
  square?: boolean;
  /** Draw the legend plate naming whose outline it is (4.3). */
  legend?: boolean;
}): ReactNode {
  const near = neighbors.slice(0, MAX_NEIGHBORS);
  const { reads, retry, pending } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId: bodyId }),
    n0: near[0] ? read(api.waterBodies.get, { waterBodyId: near[0].id }) : null,
    n1: near[1] ? read(api.waterBodies.get, { waterBodyId: near[1].id }) : null,
    n2: near[2] ? read(api.waterBodies.get, { waterBodyId: near[2].id }) : null,
  });
  const { resolvedTheme } = useTheme();
  const { narrow = false } = useInspectorContext();
  const mode = resolvedTheme === 'light' ? 'light' : 'dark';
  const state = headMapState(
    reads.body,
    [reads.n0, reads.n1, reads.n2].slice(0, near.length),
    legend,
  );
  return (
    <CorpusHeadMapView
      state={state}
      height={height}
      square={square}
      onRetry={retry}
      retrying={pending}
      renderMap={(view) => <InboxMap view={view} mode={mode} height={height} viewOnly={narrow} />}
    />
  );
}

/** The head map's states, from props: loading, failed, nothing to draw, or the embed. */
export function CorpusHeadMapView({
  state,
  height,
  square = false,
  onRetry,
  retrying = false,
  renderMap,
  className,
}: {
  state: HeadMapState;
  height: number;
  square?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  renderMap: (view: InboxMapView) => ReactNode;
  className?: string;
}): ReactNode {
  const box = cn('min-w-0', square ? 'shrink-0' : 'w-full', className);
  const size = square ? { width: height, height } : { height };
  if (state === undefined) {
    return (
      <SkeletonBlock
        data-slot="head-map-loading"
        aria-label={W.loading}
        className={box}
        style={size}
      />
    );
  }
  if (isFailed(state)) {
    return (
      <div
        data-slot="head-map-failed"
        className={cn(box, 'flex items-center px-gutter')}
        style={size}
      >
        <RetryNote onRetry={onRetry} pending={retrying}>
          {W.failed}
        </RetryNote>
      </div>
    );
  }
  if (state === null) return null;
  return (
    <div data-slot="head-map" data-square={square ? '' : undefined} className={box} style={size}>
      {renderMap(headMapScene(state))}
    </div>
  );
}
