import { Link } from '@tanstack/react-router';

import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { ItemMap } from '../../map/ItemMap';
import { useHereHref } from '../Drawn/useHereHref';
import { placeSlots } from './PlaceHandlerView';
import type { PlaceItem } from './placeModel';
import { usePlaceServer, usePlaceWrites } from './usePlaceWrites';

/**
 * **The place handler** (board 2.4), registered for the `place` key (`register.tsx`): a landmark
 * or a bay ask drawn inside `InspectorFrame`, its writes bound (`usePlaceWrites` →
 * `corpusRequests.approve` / `decline`), *Open in Body →* to the body's Places tab, *Draw in Body →*
 * to the old editor in a new tab (a page outside the console), the bar's keys on the inspector
 * pane, and the item's map (`ItemMap`).
 */
export function PlaceHandler({ item, locked, now }: InboxHandlerProps) {
  // The registry hands this handler only `place` items (its one key).
  const place = item as PlaceItem;
  const { pane, timeZone } = useInspectorContext();
  const here = useHereHref();
  const server = usePlaceServer();
  const { samePlace, approve, decline, pending } = usePlaceWrites(place, server);
  const { head, actions, body } = placeSlots({
    item: place,
    now,
    map: <ItemMap item={item} />,
    bodyLink: (
      <Link
        to="/admin/body/$id"
        params={{ id: place.body.waterBodyId }}
        search={{ tab: 'places', from: here }}
      />
    ),
    editorHref: `/admin/water/${encodeURIComponent(place.body.waterBodyId)}`,
    onSamePlace: samePlace,
    onApprove: approve,
    onDecline: decline,
    pending,
    pane,
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      {body}
    </InspectorFrame>
  );
}
