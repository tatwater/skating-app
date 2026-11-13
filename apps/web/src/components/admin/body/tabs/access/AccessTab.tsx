import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { PublicAccessVerdict } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { useRole } from '@/lib/useRole';

import type { BodyTabProps, BodyTabRegistration } from '../names/tabContract';
import { useTabAction } from '../names/useTabAction';
import { AccessView } from './AccessView';
import {
  type AccessData,
  accessFrom,
  accessMapScene,
  type RulingAction,
  rulingOf,
} from './accessModel';

/**
 * Body › Access, wired. Reads: the body's record (the ruling, the posted rule), its access in one
 * round trip (`accessPoints.accessForBody`: put-ins, lots, alerts), its landmarks for where a launch
 * is (`landmarks.listForBody`), and the ruling's audit rows for who ruled and what stood before
 * (`moderation.listActions`, `audit.read`). Writes, each behind its capability and announced for
 * undo: the ruling (`waterBodies.setPublicAccess`, `access.rule` — no public access asks its
 * reason), and a mapped launch made official or hidden (`putIns.setOfficial` / `hide`,
 * `body.access`). Placing put-ins and lots, linking a lot and the posted-rules editor are task modes.
 */
/**
 * The Access tab's data — the record's ruling and posted rule, the access read, the landmarks for
 * where a launch is, and the ruling's audit rows — memoized on the reads, so the map's `useData`
 * keeps its identity until one changes.
 */
export function useAccessData(bodyId: string): AccessData | undefined {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can } = useRole();
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const landmarks = useQuery(api.landmarks.listForBody, { waterBodyId });
  const rulings = useQuery(
    api.moderation.listActions,
    can('audit.read')
      ? { targetType: 'waterbody', targetId: bodyId, action: 'set_public_access', limit: 20 }
      : 'skip',
  );
  const body = result?.available ? result.body : undefined;
  return useMemo(() => {
    if (body === undefined || access === undefined) return undefined;
    const latest = rulings === undefined ? undefined : ((rulings[0] as RulingAction) ?? null);
    return accessFrom(
      access,
      rulingOf(body.publicAccess, latest),
      body.postedAccess,
      landmarks ?? null,
    );
  }, [body, access, rulings, landmarks]);
}

export function AccessTab({ bodyId, lit = null }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can } = useRole();
  const data = useAccessData(bodyId);
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
