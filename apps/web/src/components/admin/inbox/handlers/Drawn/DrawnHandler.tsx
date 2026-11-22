import { Link } from '@tanstack/react-router';

import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { ItemMap } from '../../map/ItemMap';
import { drawnSlots } from './DrawnHandlerView';
import type { DrawnItem } from './drawnModel';
import { useDrawnServer, useDrawnWrites } from './useDrawnWrites';
import { useHereHref } from './useHereHref';

/**
 * **The drawn handler** (board 2.5), registered for the `drawn` key (`register.tsx`): the item drawn
 * inside `InspectorFrame`, its writes bound (`useDrawnWrites` → `waterBodies.approve` / `reject`),
 * *Open in Body →* to the drawing's own console, the old editor for a merge (a new tab, the console's
 * rule for a page outside it), the bar's keys on the inspector pane, and the item's map (`ItemMap`).
 */
export function DrawnHandler({ item, locked, now }: InboxHandlerProps) {
  // The registry hands this handler only `drawn` items (its one key).
  const drawn = item as DrawnItem;
  const { pane, timeZone } = useInspectorContext();
  const here = useHereHref();
  const server = useDrawnServer();
  const { approve, reject, pending } = useDrawnWrites(drawn, server);
  const { head, actions, body } = drawnSlots({
    item: drawn,
    now,
    map: <ItemMap item={item} />,
    bodyLink: (
      <Link to="/admin/body/$id" params={{ id: drawn.body.waterBodyId }} search={{ from: here }} />
    ),
    editorLink: <Link to="/admin/water/$id" params={{ id: drawn.body.waterBodyId }} />,
    onApprove: approve,
    onReject: reject,
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
