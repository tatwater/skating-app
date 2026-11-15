import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { WaterBodyClass } from '@skating/core';
import { useMutation } from 'convex/react';
import { useMemo, useState } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import { useUndo } from '../../../shell/undo';
import { listChanged, sayNotSaved, sendFor, useBodyHold } from '../../frame/currentBody';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { chipChange, sameList, useListWriter } from '../listWriter';
import { useTabAction } from '../useTabAction';
import { NamesView } from './NamesView';
import {
  classLabel,
  type NamesData,
  type NamesIdentity,
  namesFromBody,
  namesMapScene,
  type TownLinesRead,
} from './namesModel';

/** The aliases' change gave up: another moderator kept changing the list under it. */
export const ALIASES_KEPT_MOVING =
  'Another moderator kept changing these aliases while yours was saving. Your change wasn’t saved — try again.';

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
    identity: read(api.bodyConsole.identity, { waterBodyId }),
    townLines: read(api.bodyConsole.townLines, { waterBodyId }),
  });
  const { body: got, places, identity, townLines } = reads;
  const body = isFailed(got) ? got : got?.available ? got.body : undefined;
  const data = useMemo<Loadable<NamesData>>(
    () =>
      body === undefined || isFailed(body)
        ? body
        : namesFromBody(body, places, {
            identity: identity as Loadable<NamesIdentity>,
            townLinesRead: townLines as Loadable<TownLinesRead>,
          }),
    [body, places, identity, townLines],
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
 * — and the town lines on the map, from each town's stored outline (`bodyConsole.townLines`).
 */
export function NamesTab({ bodyId, lit = null }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { data, retry, pending } = useNamesRead(bodyId);
  const setName = useMutation(api.waterBodies.setWaterBodyName);
  const { act } = useTabAction(bodyId);
  const { can } = useRole();
  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const canEdit = can('body.identity');
  const write = (name: string | null, title: string) =>
    void act(() => setName({ waterBodyId, name }), { title, target });
  const choose = canEdit
    ? (name: string | null) =>
        write(name, name === null ? 'Back to the catalogs’ ranking' : `Displaying “${name}”`)
    : undefined;
  // A body no catalog names has no ranking to go back to: clearing leaves it nameless.
  const community = canEdit
    ? (name: string | null) => write(name, name === null ? 'Cleared the name' : `Named “${name}”`)
    : undefined;

  // **The aliases are a whole list** (`setAliases`, at most 20, each at most 120 characters): one
  // queue for the body, above the page, each save naming the list it was built on (`expected`);
  // a list another moderator moved is re-applied on top. The server's refusals are said in place.
  const setAliases = useMutation(api.waterBodies.setAliases);
  const setClass = useMutation(api.waterBodies.setClass);
  const hold = useBodyHold();
  const { announce } = useUndo();
  const [aliasesError, setAliasesError] = useState<string | null>(null);
  const shown = data !== undefined && !isFailed(data) ? data.aliases : [];
  const pushAliases = useListWriter<string>(
    `names-aliases:${bodyId}`,
    shown,
    async (next, base) => {
      setAliasesError(null);
      try {
        // `false`: refused off its console (said in a toast) — never taken as acknowledged.
        return await sendFor(hold, {
          body: bodyId,
          write: () => setAliases({ waterBodyId, aliases: [...next], expected: [...base] }),
          receipt: (subject) => announce({ title: 'Aliases saved', target, subject }),
          what: 'The aliases',
        });
      } catch (err) {
        const current = listChanged(err);
        if (current !== null) return { current: current as string[] };
        setAliasesError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    sameList,
    // A list that kept moving under the change is said, never dropped quietly: here while this
    // page is on screen, else in a toast naming the body.
    () => {
      if (hold.here()) setAliasesError(ALIASES_KEPT_MOVING);
      else sayNotSaved(hold, ALIASES_KEPT_MOVING);
    },
  );
  const editAliases = (aliases: string[]) => void pushAliases(chipChange(shown, aliases));
  const classWrite = (bodyClass: WaterBodyClass | null, title: string) =>
    void act(() => setClass({ waterBodyId, bodyClass }), { title, target });
  return (
    <NamesView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      onChooseName={choose}
      onCommunityName={community}
      canEditAliases={canEdit}
      canEditClass={canEdit}
      {...(canEdit
        ? {
            onAliasesChange: editAliases,
            aliasesError,
            onClassChange: (cls: WaterBodyClass) =>
              classWrite(cls, `Class set to ${classLabel(cls)}`),
            onClassClear: () => classWrite(null, 'Back to the catalogs’ class'),
          }
        : {})}
    />
  );
}

/** The Names tab's registration in the frame's registry. */
export const NAMES_TAB: BodyTabRegistration<NamesData> = {
  Wiring: NamesTab,
  map: { useData: useNamesData, describe: namesMapScene },
};
