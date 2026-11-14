import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { PublicAccessVerdict } from '@skating/core';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  retryAll,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import { AccessView } from './AccessView';
import {
  type AccessData,
  accessFrom,
  accessMapScene,
  RULING_HISTORY_LIMIT,
  rulingFrom,
} from './accessModel';

/**
 * Body › Access, wired. Reads: the body's record (the ruling, the posted rule), its access in one
 * round trip (`accessPoints.accessForBody`: put-ins, lots, alerts), its landmarks for where a launch
 * is (`landmarks.listForBody`), and the ruling's history for who ruled, what stood before and how
 * many rulings came earlier (`bodyConsole.history` by verb, `audit.read`). Writes, each behind its
 * capability and announced for undo: the ruling (`waterBodies.setPublicAccess`, `access.rule` — no
 * public access asks its reason), and a mapped launch made official or hidden (`putIns.setOfficial`
 * / `hide`, `body.access`). Placing put-ins and lots, linking a lot and the posted-rules editor are
 * task modes.
 */
/**
 * The Access tab's reads and its data — memoized on the reads, so the map's `useData` keeps its
 * identity until one changes. The record or the access read failing is the tab's failure; the
 * landmarks and the history each say so in place.
 */
export function useAccessRead(bodyId: string): {
  data: Loadable<AccessData>;
  retry: () => void;
  pending: boolean;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can, isLoading } = useRole();
  const readsAudit = can('audit.read');
  const { reads, retry, pending } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId }),
    access: read(api.accessPoints.accessForBody, { waterBodyId }),
    landmarks: read(api.landmarks.listForBody, { waterBodyId }),
    rulings: readsAudit
      ? read(api.bodyConsole.history, {
          waterBodyId,
          action: 'set_public_access',
          limit: RULING_HISTORY_LIMIT,
        })
      : null,
  });
  const { body: got, access, landmarks, rulings } = reads;
  const body = isFailed(got) ? got : got?.available ? got.body : undefined;
  // While the role loads, the history is on its way, not withheld.
  const history = readsAudit ? rulings : isLoading ? undefined : 'hidden';
  const data = useMemo<Loadable<AccessData>>(() => {
    if (isFailed(body) || isFailed(access)) return retryAll([body, access].filter(isFailed));
    if (body === undefined || access === undefined) return undefined;
    return accessFrom(
      access,
      rulingFrom(body.publicAccess, bodyId, history),
      body.postedAccess,
      landmarks,
    );
  }, [body, access, landmarks, history, bodyId]);
  return { data, retry, pending };
}

/** The drawing's data: the tab's, once its record and access are read. */
export function useAccessData(bodyId: string): AccessData | undefined {
  const { data } = useAccessRead(bodyId);
  return isFailed(data) ? undefined : data;
}

export function AccessTab({ bodyId, lit = null }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can } = useRole();
  const { data, retry, pending } = useAccessRead(bodyId);
  const setPublicAccess = useMutation(api.waterBodies.setPublicAccess);
  const setOfficial = useMutation(api.putIns.setOfficial);
  const hide = useMutation(api.putIns.hide);
  const { act, actInDialog } = useTabAction();
  const now = useDayClock();

  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const ruled = (v: PublicAccessVerdict | null) =>
    v === 'open'
      ? 'Ruled accessible'
      : v === 'none'
        ? 'Ruled no public access'
        : 'Cleared the ruling';

  return (
    <AccessView
      data={data}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      now={now}
      canPlace={can('body.access')}
      onRule={
        can('access.rule')
          ? (verdict, reason) => {
              const write = () =>
                setPublicAccess({ waterBodyId, verdict, ...(reason ? { reason } : {}) });
              const receipt = { title: ruled(verdict), target };
              return reason !== undefined
                ? actInDialog(write, receipt)
                : act(write, receipt).then((ok) => (ok ? null : 'Not saved'));
            }
          : undefined
      }
      onMakeOfficial={
        can('body.access')
          ? (p) =>
              void act(() => setOfficial({ waterBodyId, coord: p.at, name: p.name }), {
                title: `Made ${p.name} official`,
                target,
              })
          : undefined
      }
      onHide={
        can('body.access')
          ? (p, reason) =>
              actInDialog(() => hide({ waterBodyId, coord: p.at, reason }), {
                title: `Hid ${p.name}`,
                target,
              })
          : undefined
      }
    />
  );
}

/** The day a ruling's age is counted to, moved on once an hour (a day count is the finest it says). */
function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** The Access tab's registration in the frame's registry. */
export const ACCESS_TAB: BodyTabRegistration<AccessData> = {
  Wiring: AccessTab,
  map: { useData: useAccessData, describe: accessMapScene },
};
