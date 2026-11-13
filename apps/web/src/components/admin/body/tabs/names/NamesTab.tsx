import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { useMemo } from 'react';

import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import { NamesView } from './NamesView';
import { type NamesData, namesFromBody, namesMapScene } from './namesModel';

/**
 * The Names tab's data from the body's record (`waterBodies.get`), memoized on the record so the
 * map's `useData` keeps its identity until the record changes.
 */
export function useNamesData(bodyId: string): NamesData | undefined {
  const result = useQuery(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> });
  const body = result?.available ? result.body : undefined;
  return useMemo(() => (body ? namesFromBody(body) : undefined), [body]);
}

/**
 * Body › Names, wired: the body's record and the one names write the server has today,
 * `waterBodies.setWaterBodyName` (`body.identity`), with its undo. What no read or mutation serves
 * yet is left out rather than faked — the aliases' editor, the class's change and the catalogs'
 * class claims, the towns and county, and the town lines on the map (the B01-3 server register).
 */
export function NamesTab({ bodyId, lit = null }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const data = useNamesData(bodyId);
  const setName = useMutation(api.waterBodies.setWaterBodyName);
  const { act } = useTabAction();
  const { can } = useRole();
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

/** The Names tab's registration in the frame's registry. */
export const NAMES_TAB: BodyTabRegistration<NamesData> = {
  Wiring: NamesTab,
  map: { useData: useNamesData, describe: namesMapScene },
};
