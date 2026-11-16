import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { PublicAccessVerdict } from '@skating/core';
import { useMutation } from 'convex/react';
import { useMemo } from 'react';
import {
  isFailed,
  type Loadable,
  read,
  retryAll,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import { PICK_WHAT } from '../../consoleWords';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { type PickOutcome, useLatestPick } from '../latestPick';
import { useTickingNow } from '../tabParts';
import { useTabAction } from '../useTabAction';
import { AccessView } from './AccessView';
import {
  type AccessData,
  accessFrom,
  accessMapScene,
  RULING_HISTORY_LIMIT,
  rulingFrom,
  rulingWithPick,
} from './accessModel';

/**
 * Body › Access, wired. Reads: the body's record (the ruling, the posted rule), its access in one
 * round trip (`accessPoints.accessForBody`: put-ins, lots, alerts), its landmarks for where a launch
 * is (`landmarks.listForBody`), and the ruling's history for who ruled, what stood before and how
 * many rulings came earlier (`bodyConsole.history` by verb, `audit.read`). Writes, each behind its
 * capability and announced for undo: the ruling (`waterBodies.setPublicAccess`, `access.rule` — no
 * public access asks its reason), and a mapped launch made official in place (`putIns.promote`)
 * or hidden (`putIns.hide`), `body.access`. Placing
 * put-ins and lots, linking a lot and the posted-rules editor are task modes.
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
  const hide = useMutation(api.putIns.hide);
  const promote = useMutation(api.putIns.promote);
  const { act, actInDialog, attempt, sayRefused } = useTabAction(bodyId);
  const now = useTickingNow(3_600_000);

  const target = { targetType: 'waterbody' as const, targetId: bodyId };
  const ruled = (v: PublicAccessVerdict | null) =>
    v === 'open'
      ? 'Ruled accessible'
      : v === 'none'
        ? 'Ruled no public access'
        : 'Cleared the ruling';
  const loaded = data !== undefined && !isFailed(data) ? data : null;
  // **The latest press wins** (`useLatestPick`): the ruling pressed shows at once, presses are sent
  // one at a time in press order (one waiting behind the write out is replaced by a newer one), and
  // the record is drawn again once every press has been answered. Ruling
  // no public access is a press once its reason is confirmed; its dialog waits on its own answer.
  // One write for the buttons and the reason dialog, answering in the store's one shape: a refusal
  // goes to the dialog that asked while it is open, else is said once by someone still there.
  const send = (verdict: PublicAccessVerdict | null, reason: string | undefined) =>
    attempt(
      () => setPublicAccess({ waterBodyId, verdict, ...(reason ? { reason } : {}) }),
      { title: ruled(verdict), target },
      PICK_WHAT.ruling,
    );
  const rule = useLatestPick<PublicAccessVerdict | null, string>(
    `access-ruling:${bodyId}`,
    loaded?.ruling.verdict ?? null,
    { send, say: sayRefused(PICK_WHAT.ruling) },
  );
  /** The dialog's words for an outcome: `null` when landed or said elsewhere, else the refusal. */
  const forDialog = (o: PickOutcome | undefined) =>
    o === undefined || o.landed || o.said === true ? null : o.why;
  const shown = useMemo(() => {
    if (data === undefined || isFailed(data)) return data;
    const ruling = rulingWithPick(data.ruling, rule.shown, now);
    return ruling === data.ruling ? data : { ...data, ruling };
  }, [data, rule.shown, now]);

  return (
    <AccessView
      data={shown}
      onRetry={retry}
      retryPending={pending}
      lit={lit}
      now={now}
      canPlace={can('body.access')}
      onRule={
        can('access.rule')
          ? async (verdict, reason, asker) => {
              const sent = rule.press(verdict, reason, asker);
              if (sent !== null) return forDialog(await sent);
              // The verdict already shows (another moderator's ruling landed while the dialog was
              // open): a confirmed reason is still sent, never dropped as though it were saved.
              return reason === undefined ? null : forDialog(await send(verdict, reason));
            }
          : undefined
      }
      // `putIns.promote`: the launch made official on its own row — its point, bay, lot and walk
      // kept. No name is sent: the control asks for none, and the name the row shows may be the
      // server's compass fallback ("NW launch", `resolvePutInName`) or the tab's placeholder —
      // neither is the launch's own, and sending it would store it as one.
      onMakeOfficial={
        can('body.access')
          ? (p) =>
              void act(() => promote({ putInId: p.id as Id<'putIns'> }), {
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

/** The Access tab's registration in the frame's registry. */
export const ACCESS_TAB: BodyTabRegistration<AccessData> = {
  Wiring: AccessTab,
  map: { useData: useAccessData, describe: accessMapScene },
};
