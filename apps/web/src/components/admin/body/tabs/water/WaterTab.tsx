import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import type { BodyTabProps, BodyTabRegistration } from '../names/tabContract';
import { WaterView } from './WaterView';
import { type WaterData, waterFrom, waterMapScene } from './waterModel';

/**
 * The Water tab's data from the body's record (`waterBodies.get`) — depth and its sources, the
 * interior point, any hand-set sample points and the box — memoized on the record, so the map's
 * `useData` keeps its identity until the record changes.
 */
export function useWaterData(bodyId: string): WaterData | undefined {
  const result = useQuery(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> });
  const body = result?.available ? result.body : undefined;
  return useMemo(() => (body ? waterFrom(body) : undefined), [body]);
}

/**
 * Body › Water, wired. Read-only today: the board's two edits (choosing a depth source, filing a
 * survey) wait on server writes, and the other depth lever the old editor has — typing an operator
 * reading or rejecting one — is not on this board (the B01-3 server register). The depth candidates
 * and the bathymetry state wait on their reads; until then the ladder shows the sources in use and
 * Bathymetry says it isn't recorded.
 */
export function WaterTab({ bodyId, lit = null }: BodyTabProps) {
  return <WaterView data={useWaterData(bodyId)} lit={lit} />;
}

/** The Water tab's registration in the frame's registry. */
export const WATER_TAB: BodyTabRegistration<WaterData> = {
  Wiring: WaterTab,
  map: { useData: useWaterData, describe: waterMapScene },
};
