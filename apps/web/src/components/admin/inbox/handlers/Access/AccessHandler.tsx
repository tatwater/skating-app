import { Link, useRouterState } from '@tanstack/react-router';
import { InspectorFrame } from '../../../inspector/InspectorFrame';
import { useInspectorContext } from '../../../inspector/inspectorContext';
import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { ItemMap } from '../../map/ItemMap';
import { accessSlots } from './AccessHandlerView';
import type { AccessItem } from './accessModel';
import { useAccessWrites } from './useAccessWrites';

/**
 * **The access handler** (board 2.2), registered for the `access` key (`register.tsx`): the item
 * drawn inside `InspectorFrame`, with the ruling's writes bound (`useAccessWrites`), *Open in Body →*
 * to the body's Access tab, the bar's keys on the inspector pane (`useInspectorContext`), and the
 * item's map (`ItemMap`: the body and its put-ins and lots, read apart from the item).
 */
export function AccessHandler({ item, locked, now }: InboxHandlerProps) {
  // The registry hands this handler only `access` items (its one key).
  const access = item as AccessItem;
  const { pane, timeZone } = useInspectorContext();
  const here = useRouterState({ select: (s) => s.location.href });
  const { run, pending } = useAccessWrites({
    itemId: access.itemId,
    waterBodyId: access.body.waterBodyId,
    name: access.body.name,
  });
  const { head, actions, body } = accessSlots({
    item: access,
    now,
    map: <ItemMap item={item} />,
    bodyLink: (
      <Link
        to="/admin/body/$id"
        params={{ id: access.body.waterBodyId }}
        search={{ tab: 'access', from: here }}
      />
    ),
    onRule: run,
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
