import { bodyConsoleHref } from '../../../body/frame/bodySearch';
import { useUndo } from '../../../shell/undo';
import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { ItemMap } from '../../map/ItemMap';
import { useStillHere } from '../Flag/useStillHere';
import { requestSlots } from './RequestView';
import type { RequestItem } from './requestModel';
import { useRequestServer, useRequestWrites } from './useRequestWrites';

/**
 * **The request handler** (board 2.3 and the kinds derived from it), registered for the `request`
 * key (`register.tsx`): the item drawn inside `InspectorFrame`, its writes bound (`useRequestWrites`
 * → `corpusRequests.*`: refusals to a toast, receipts to the undo toast), *Open in Body →* to the
 * body's page for a request on a body we hold, the bar's keys on the inspector pane, and the item's
 * map (`ItemMap`: the catalog outline and the asks for an admit, the body and the asks else).
 */
export function RequestHandler({ item, locked, now }: InboxHandlerProps) {
  // The registry hands this handler only `request` items (its one key).
  if (item.kind !== 'request') return null;
  return <RequestInspector item={item} locked={locked} now={now} />;
}

/** The body's page, with the way back to this Inbox place (the Body console's own `from`). */
export function bodyPath(waterBodyId: string): string {
  const from =
    typeof window === 'undefined'
      ? undefined
      : `${window.location.pathname}${window.location.search}`;
  return bodyConsoleHref(waterBodyId, from);
}

function RequestInspector({
  item,
  locked,
  now,
}: Omit<InboxHandlerProps, 'item'> & { item: RequestItem }) {
  const { pane, linkFor } = useInspectorContext();
  const { announce } = useUndo();
  const server = useRequestServer();
  const stillHere = useStillHere(item.itemId);
  const onWrite = useRequestWrites({ item, server, announce, here: stillHere });
  const body = item.body;
  const {
    head,
    actions,
    body: content,
  } = requestSlots({
    item,
    now,
    map: <ItemMap item={item} />,
    // The inspector's own link for a console path (the route's router link), with the way back.
    bodyLink: body === null || linkFor === undefined ? null : linkFor(bodyPath(body.waterBodyId)),
    onWrite,
    pane,
  });
  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      {content}
    </InspectorFrame>
  );
}
