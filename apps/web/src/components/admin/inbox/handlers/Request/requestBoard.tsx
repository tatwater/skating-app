import { type RefObject, useRef } from 'react';

import type { HandlerKey, InboxHandler } from '../../inspector/handlerRegistry';
import { type DecidedState, InspectorFrame } from '../../inspector/InspectorFrame';
import { InspectorProvider, useInspectorContext } from '../../inspector/inspectorContext';
import { InboxMapStill } from '../../map/InboxMap';
import { ItemMapView } from '../../map/ItemMap';
import type { ServerItemMap } from '../../map/itemMapAdapters';
import { ACTIVATE_MAP, ADMIT_MAP } from '../../map/itemMapFixtures';
import { requestSlots } from './RequestView';
import { REQUEST_NOW, REQUEST_TZ } from './requestFixtures';
import type { RequestItem, RequestWrite } from './requestModel';

/**
 * **Story support for the request handler**: its slots over fixtures inside the real
 * `InspectorFrame` — alone at the boards' inspector size (788 × 874 of the 1440 × 900 board), or in
 * the whole Inbox page through a story registry — with the map a still over `inbox.itemMap`'s
 * fixture answers. Only stories import this.
 */

/** The map's fixture answer for an item: the catalog outline for an admit, the body else. */
export function mapFor(item: RequestItem): ServerItemMap {
  if (item.requestKind !== 'admit') return ACTIVATE_MAP;
  return item.candidate === null ? { ...ADMIT_MAP, candidate: null, others: [] } : ADMIT_MAP;
}

/** The map slot over its still, at the width it is drawn. */
export function StoryMap({ item, width }: { item: RequestItem; width: number }) {
  return (
    <ItemMapView
      item={item}
      state={{ map: mapFor(item), pending: false }}
      renderMap={(view) => <InboxMapStill view={view} width={width} />}
      timeZone={REQUEST_TZ}
    />
  );
}

/** A story's anchor for the body link. */
const bodyLink = (item: RequestItem) =>
  item.body === null ? null : (
    // biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
    <a href={`#/admin/body/${item.body.waterBodyId}`} onClick={(e) => e.preventDefault()} />
  );

/** The handler's slots in the frame, inside a provider's pane. */
function Slots({
  item,
  now,
  locked,
  onWrite,
  pane,
  mapWidth,
}: {
  item: RequestItem;
  now: number;
  locked: DecidedState | null;
  onWrite: (write: RequestWrite) => Promise<boolean>;
  pane: RefObject<HTMLElement | null>;
  mapWidth: number;
}) {
  const { head, actions, body } = requestSlots({
    item,
    now,
    map: <StoryMap item={item} width={mapWidth} />,
    bodyLink: bodyLink(item),
    onWrite,
    pane,
  });
  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      {body}
    </InspectorFrame>
  );
}

/** The inspector stand-in: the pane (its keys' element), the frame, at the board's size. */
export function StoryRequestInspector({
  item,
  onWrite,
  locked = null,
  width = 788,
  height = 874,
}: {
  item: RequestItem;
  onWrite: (write: RequestWrite) => Promise<boolean>;
  locked?: DecidedState | null;
  width?: number;
  height?: number;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label="Inspector"
      data-pane="inspector"
      className="relative flex overflow-hidden bg-bg outline-none"
      style={{ width, height }}
    >
      <InspectorProvider
        value={{ pane, decidedOnOpen: false, now: REQUEST_NOW, timeZone: REQUEST_TZ }}
      >
        <Slots
          item={item}
          now={REQUEST_NOW}
          locked={locked}
          onWrite={onWrite}
          pane={pane}
          mapWidth={width}
        />
      </InspectorProvider>
    </section>
  );
}

/** The handler for a story registry: the page's own inspector context gives the pane. */
export function storyRequestRegistry(
  onWrite: (write: RequestWrite) => Promise<boolean>,
  /** The map still's width: the board's inspector (788), or a phone's page (360). */
  mapWidth = 788,
): [HandlerKey, InboxHandler][] {
  const Handler: InboxHandler = ({ item, now, locked }) => {
    const { pane } = useInspectorContext();
    if (item.kind !== 'request') return null;
    return (
      <Slots
        item={item}
        now={now}
        locked={locked}
        onWrite={onWrite}
        pane={pane}
        mapWidth={mapWidth}
      />
    );
  };
  return [['request', Handler]];
}
