import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { useMemo } from 'react';

import { useRole } from '@/lib/useRole';
import { NamesView } from './NamesView';
import { namesFromBody } from './namesModel';
import { useTabAction } from './useTabAction';

/**
 * Body › Names, wired: the body's record (`waterBodies.get`) and the one names write the server
 * has today, `waterBodies.setWaterBodyName` (`body.identity`), with its undo. What no read or
 * mutation serves yet is left out rather than faked — the aliases' editor, the class's change and
 * the catalogs' class claims, the towns and county, and the town lines on the map (the B01-3
 * server register).
 */
export function NamesTab({
  bodyId,
  lit = null,
}: {
  bodyId: string;
  /** The lit item, from the frame's URL. */
  lit?: string | null;
}) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const setName = useMutation(api.waterBodies.setWaterBodyName);
  const { act } = useTabAction();
  const { can } = useRole();
  const body = result?.available ? result.body : undefined;
  const data = useMemo(() => (body ? namesFromBody(body) : undefined), [body]);
  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const choose = can('body.identity')
    ? (name: string | null) =>
        void act(() => setName({ waterBodyId, name }), {
          title: name === null ? 'Back to the catalogs’ ranking' : `Displaying “${name}”`,
          target,
        })
    : undefined;
  return <NamesView data={data} lit={lit} onChooseName={choose} onCommunityName={choose} />;
}
