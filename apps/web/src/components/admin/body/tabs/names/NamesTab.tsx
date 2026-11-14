import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useMemo } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import { NamesView } from './NamesView';
import { type NamesData, namesFromBody, namesMapScene } from './namesModel';

/**
 * The Names tab's reads and its data: the body's record (`waterBodies.get`) and the boundaries it
 * lies in (`bodyConsole.places`), memoized on the reads so the map's `useData` keeps its identity
 * until one changes. The record still loading — or not available, which the frame says itself — is
 * loading; the record failing is the tab's failure.
 */
export function useNamesRead(bodyId: string): {
  data: Loadable<NamesData>;
  retry: () => void;
  pending: boolean;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { reads, retry, pending } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId }),
    places: read(api.bodyConsole.places, { waterBodyId }),
  });
  const { body: got, places } = reads;
  const body = isFailed(got) ? got : got?.available ? got.body : undefined;
  const data = useMemo<Loadable<NamesData>>(
    () => (body === undefined || isFailed(body) ? body : namesFromBody(body, places)),
    [body, places],
  );
  return { data, retry, pending };
}

/** The drawing's data: the tab's, once the record is read. */
export function useNamesData(bodyId: string): NamesData | undefined {
  const { data } = useNamesRead(bodyId);
  return isFailed(data) ? undefined : data;
}

/**
 * Body › Names, wired: the body's record, the boundaries it lies in, and the one names write the
 * server has today, `waterBodies.setWaterBodyName` (`body.identity`), with its undo. What no read
 * or mutation serves yet is drawn and says so — the aliases' editor and the class's change are
 * *Not available yet* for a viewer who could use them, each catalog's own claims *Not recorded yet*
 * — and the town lines on the map wait on a read of their own (the B01-3 server register).
 */
export function NamesTab({ bodyId, lit = null }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { data, retry, pending } = useNamesRead(bodyId);
  const setName = useMutation(api.waterBodies.setWaterBodyName);
  const { act } = useTabAction();
  const { can } = useRole();
  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const canEdit = can('body.identity');
  const choose = canEdit
    ? (name: string | null) =>
        void act(() => setName({ waterBodyId, name }), {
          title: name === null ? 'Back to the catalogs’ ranking' : `Displaying “${name}”`,
          target,
        })
    : undefined;
  return (
    <NamesView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      onChooseName={choose}
      onCommunityName={choose}
      canEditAliases={canEdit}
      canEditClass={canEdit}
    />
  );
}

/** The Names tab's registration in the frame's registry. */
export const NAMES_TAB: BodyTabRegistration<NamesData> = {
  Wiring: NamesTab,
  map: { useData: useNamesData, describe: namesMapScene },
};
