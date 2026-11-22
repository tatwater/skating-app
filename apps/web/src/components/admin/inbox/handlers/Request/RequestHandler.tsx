import { Link, useRouterState } from '@tanstack/react-router';

import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { ItemMap } from '../../map/ItemMap';
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

function RequestInspector({
  item,
  locked,
  now,
}: Omit<InboxHandlerProps, 'item'> & { item: RequestItem }) {
  const { pane } = useInspectorContext();
  // Where the console is, for the Body console's way back (`from`), as every handler builds it.
  const here = useRouterState({ select: (s) => s.location.href });
  const server = useRequestServer();
  const onWrite = useRequestWrites({ item, server });
  const body = item.body;
  const {
    head,
    actions,
    body: content,
  } = requestSlots({
    item,
    now,
    map: <ItemMap item={item} />,
    bodyLink:
      body === null ? null : (
        <Link to="/admin/body/$id" params={{ id: body.waterBodyId }} search={{ from: here }} />
      ),
    onWrite,
    pane,
  });
  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      {content}
    </InspectorFrame>
  );
}
