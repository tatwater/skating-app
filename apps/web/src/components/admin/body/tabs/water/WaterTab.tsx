import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';
import { WaterView } from './WaterView';
import { waterFrom } from './waterModel';

/**
 * Body › Water, wired: the body's record (`waterBodies.get`) — depth, its sources, the interior
 * point, any hand-set sample points and the box. Read-only today: the board's two edits (choosing
 * a depth source, filing a survey) wait on server writes, and the other depth lever the old editor
 * has — typing an operator reading or rejecting one — is not on this board (the B01-3 server
 * register). The depth candidates and the bathymetry state wait on their reads; until then the
 * ladder shows the sources in use and Bathymetry says it isn't recorded.
 */
export function WaterTab({ bodyId, lit = null }: { bodyId: string; lit?: string | null }) {
  const result = useQuery(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> });
  const body = result?.available ? result.body : undefined;
  const data = useMemo(() => (body ? waterFrom(body) : undefined), [body]);
  return <WaterView data={data} lit={lit} />;
}
