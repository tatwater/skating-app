import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMemo } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { WaterView } from './WaterView';
import { type WaterData, waterFrom, waterMapScene } from './waterModel';

/**
 * The Water tab's reads and its data: the body's record (`waterBodies.get` — depth and its sources,
 * the interior point, any hand-set sample points, the box) and whether contours were drawn for it
 * (`bodyConsole.consoleExtras`), memoized on the reads so the map's `useData` keeps its identity
 * until one changes. The record failing is the tab's failure; the bathymetry state says so in place.
 */
export function useWaterRead(bodyId: string): {
  data: Loadable<WaterData>;
  retry: () => void;
  pending: boolean;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { reads, retry, pending } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId }),
    extras: read(api.bodyConsole.consoleExtras, { waterBodyId }),
  });
  const { body: got, extras } = reads;
  const body = isFailed(got) ? got : got?.available ? got.body : undefined;
  const data = useMemo<Loadable<WaterData>>(
    () => (body === undefined || isFailed(body) ? body : waterFrom(body, extras)),
    [body, extras],
  );
  return { data, retry, pending };
}

/** The drawing's data: the tab's, once the record is read. */
export function useWaterData(bodyId: string): WaterData | undefined {
  const { data } = useWaterRead(bodyId);
  return isFailed(data) ? undefined : data;
}

/**
 * Body › Water, wired: the record and the bathymetry state. Read-only today — the board's two edits
 * (choosing a depth source, filing a survey) wait on server writes, so for a viewer who could make
 * them (`body.water`) each is drawn where the board draws it and says *Not available yet*. The
 * other sources' depths aren't stored (the loader keeps each measurement's winner) and what was
 * searched for contours isn't recorded: each says *Not recorded yet*.
 */
export function WaterTab({ bodyId, lit = null }: BodyTabProps) {
  const { data, retry, pending } = useWaterRead(bodyId);
  const { can } = useRole();
  const canEdit = can('body.water');
  return (
    <WaterView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      canChooseDepth={canEdit}
      canFileSurvey={canEdit}
    />
  );
}

/** The Water tab's registration in the frame's registry. */
export const WATER_TAB: BodyTabRegistration<WaterData> = {
  Wiring: WaterTab,
  map: { useData: useWaterData, describe: waterMapScene },
};
