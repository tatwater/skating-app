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
import { ALIASES_KEPT_MOVING, PICK_WHAT, RECEIPTS } from '../../consoleWords';
import { listChanged, sayNotSaved, sendFor, useBodyHold } from '../../frame/currentBody';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useLatestPick } from '../latestPick';
import { chipChange, sameList, useListWriter } from '../listWriter';
import { useTabAction } from '../useTabAction';
import { NamesView } from './NamesView';
import {
  classChoice,
  classLabel,
  type NamesData,
  type NamesIdentity,
  nameChoice,
  namesFromBody,
  namesMapScene,
  namesWithPicks,
  type TownLinesRead,
} from './namesModel';

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
  const { act, attempt, sayRefused } = useTabAction(bodyId);
  const { can } = useRole();
  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const canEdit = can('body.identity');
  const write = (name: string | null, title: string) =>
    act(() => setName({ waterBodyId, name }), { title, target });
  const loaded = data !== undefined && !isFailed(data) ? data : null;
  // **The latest press wins** (`useLatestPick`): the name and the class each show the latest one
  // chosen at once, choices are sent one at a time in press order through the tab's one write path
  // (a choice waiting behind the write out is replaced by a newer one), and the server's answer is
  // drawn again once every choice has been answered — a second choice is never weighed against a
  // record that hasn't moved yet and dropped.
  const namePick = useLatestPick<string | null>(
    `names-name:${bodyId}`,
    loaded === null ? null : nameChoice(loaded),
    {
      send: (n) =>
        attempt(
          () => setName({ waterBodyId, name: n }),
          {
            title: n === null ? 'Back to the catalogs’ ranking' : `Displaying “${n}”`,
            target,
          },
          PICK_WHAT.name,
        ),
      say: sayRefused(PICK_WHAT.name),
    },
  );
  const choose = canEdit ? (name: string | null) => namePick.press(name) : undefined;
  // A body no catalog names has no ranking to go back to: clearing leaves it nameless.
  const community = canEdit
    ? (name: string | null) =>
        void write(name, name === null ? 'Cleared the name' : `Named “${name}”`)
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
          receipt: (subject) => announce({ title: RECEIPTS.aliasesSaved, target, subject }),
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
  const classPick = useLatestPick<WaterBodyClass | null>(
    `names-class:${bodyId}`,
    loaded === null ? null : classChoice(loaded),
    {
      send: (bodyClass) =>
        attempt(
          () => setClass({ waterBodyId, bodyClass }),
          {
            title:
              bodyClass === null ? RECEIPTS.classCleared : RECEIPTS.classSet(classLabel(bodyClass)),
            target,
          },
          PICK_WHAT.cls,
        ),
      say: sayRefused(PICK_WHAT.cls),
    },
  );
  return (
    <NamesView
      data={
        loaded === null
          ? data
          : namesWithPicks(loaded, { name: namePick.shown, cls: classPick.shown })
      }
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
            onClassChange: (cls: WaterBodyClass) => classPick.press(cls),
            onClassClear: () => classPick.press(null),
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
