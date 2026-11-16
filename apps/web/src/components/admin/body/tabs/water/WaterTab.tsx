import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { DepthSource } from '@skating/core';
import { useMutation } from 'convex/react';
import { useMemo } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  readState,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import { RECEIPTS } from '../../consoleWords';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import { WaterView } from './WaterView';
import {
  type DepthChoicesRead,
  sourceWords,
  type WaterData,
  waterFrom,
  waterMapScene,
} from './waterModel';

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
    choices: read(api.bodyConsole.depthChoices, { waterBodyId }),
  });
  const { body: got, extras, choices } = reads;
  const body = isFailed(got) ? got : got?.available ? got.body : undefined;
  const data = useMemo<Loadable<WaterData>>(
    () =>
      body === undefined || isFailed(body)
        ? body
        : // Every source's offer, once the loader keeps them (`depthCandidates`); a body whose
          // candidates were never stored is not recorded — a read on its way or failed is said so.
          waterFrom(
            body,
            extras,
            readState(
              choices as Loadable<DepthChoicesRead & { recorded: boolean }>,
              (c) => !c.recorded,
            ),
          ),
    [body, extras, choices],
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
  const choose = useMutation(api.waterBodies.chooseDepthSource);
  const { act } = useTabAction(bodyId);
  const state = data !== undefined && !isFailed(data) ? data.state : null;
  return (
    <WaterView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      canChooseDepth={canEdit}
      canFileSurvey={canEdit}
      {...(canEdit
        ? {
            // `chooseDepthSource`: the measure follows this source (a depth is the basin's; it says
            // nothing about ice). The server refuses a source with no value or a mean deeper than
            // the max, said in a toast in its words.
            onChooseDepth: (measure: 'mean' | 'max', source: DepthSource) =>
              void act(
                () => choose({ waterBodyId: bodyId as Id<'waterBodies'>, measure, source }),
                {
                  title: RECEIPTS.depthFrom(measure, sourceWords(source, state).name),
                  target: { targetType: 'waterbody', targetId: bodyId },
                },
              ),
          }
        : {})}
    />
  );
}

/** The Water tab's registration in the frame's registry. */
export const WATER_TAB: BodyTabRegistration<WaterData> = {
  Wiring: WaterTab,
  map: { useData: useWaterData, describe: waterMapScene },
};
