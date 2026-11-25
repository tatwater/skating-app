import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { OPERATOR_PUT_IN_SNAP_MAX_M } from '@skating/core';
import { useMutation } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type MapToolClaim, useClaimMapTool } from '../../frame/mapTool';
import { useTabAction } from '../useTabAction';
import { AccessTask } from './AccessTask';
import {
  type AccessDraft,
  draftShape,
  type LinkTarget,
  modeBarOf,
  pickedLot,
  saveBlocker,
  savedTitle,
  startLink,
  startLot,
  startPutIn,
  withPick,
} from './accessDraft';
import { type LotRow, litId } from './accessModel';

/**
 * **The Access tab's map tasks, wired** (B01-6b, D300): the draft (`accessDraft`), its claim on the
 * console map (`frame/mapTool`'s point engine), and its save through the tab's writer
 * (`useTabAction`, a receipt with Undo; a refusal is a toast, and the task stays).
 *
 * - **A put-in**: the point snaps to the body's outline while hovering (the server snaps it again);
 *   saved with `putIns.setOfficial`. Its receipt is on the body, where its audit row is.
 * - **A lot**: the point where the click is; saved with `accessPoints.setOfficialParking`, serving
 *   this lake. Its receipt is on the lot.
 * - **A link**: a click picks the nearest lot (`nearestLot`), the map's mark moved onto it; *No
 *   parking* clears it; the hike-in assertion is sent only when it changes. Saved with
 *   `accessPoints.setPutInAccess` — the server's D144 gate refuses a long walk left unasserted, in a
 *   toast. Any put-in can be re-linked, an official one included. Its receipt is on the put-in.
 *
 * Once a save lands, what it made is lit. A save outlives its task (`act` settles after the tab
 * unmounts, by design): clearing the draft and lighting happen only while that task is still open.
 */
/** A link's choice, as a session key. */
const choiceKey = (choice: Extract<AccessDraft, { kind: 'link' }>['choice']) =>
  choice === null ? '' : choice === 'none' ? 'none' : choice.lotId;

export function useAccessTask({
  bodyId,
  parent,
  lots,
  onLitChange,
}: {
  bodyId: string;
  /** The body's outline, which a put-in snaps to; until it is read, no put-in can be placed. */
  parent: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  lots: readonly LotRow[];
  onLitChange?: ((lit: string | null) => void) | undefined;
}): {
  draft: AccessDraft | null;
  task: ReactNode;
  addPutIn: () => void;
  addLot: () => void;
  linkLot: (putIn: LinkTarget) => void;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const discard = useCallback(() => setDraft(null), []);
  // The latest lots, for a click's pick: the claim's callbacks are read through the engine's ref.
  const lotsRef = useRef(lots);
  lotsRef.current = lots;

  const claim = useMemo((): MapToolClaim | null => {
    if (draft === null || (draft.kind === 'putIn' && parent === null)) return null;
    const bar = modeBarOf(draft);
    const onPick = (p: { lat: number; lng: number }, scale?: { metersPerPixel?: number }) =>
      setDraft((d) => (d === null ? d : withPick(d, p, lotsRef.current, scale?.metersPerPixel)));
    // A link's mark sits on the lot picked: the drawing starts over on each pick (and each miss, so
    // a click beside every lot doesn't leave the mark there).
    const lot = pickedLot(draft, lots);
    const point = draft.kind === 'link' ? lot?.at : (draft.point ?? undefined);
    const session =
      draft.kind === 'link'
        ? `access:${draft.session}:${choiceKey(draft.choice)}:${draft.misses}`
        : `access:${draft.session}`;
    return {
      session,
      engine: {
        kind: 'point',
        ...(point !== undefined ? { point } : {}),
        // Snapped while hovering, as the server snaps — within the server's reach only, so a click
        // far from the water stays put and the save's refusal says why.
        ...(draft.kind === 'putIn' && parent !== null
          ? { snapTo: parent, snapWithinM: OPERATOR_PUT_IN_SNAP_MAX_M }
          : {}),
        onPick,
      },
      mode: bar.mode,
      line: bar.line,
      step: bar.step,
      draft: draftShape(draft, lots),
      // To the put-in when a link starts; a placement keeps the operator's view.
      focus:
        draft.kind === 'link' && draft.choice === null && draft.misses === 0
          ? { point: draft.putIn.at }
          : null,
      onExit: discard,
    };
  }, [draft, parent, lots, discard]);
  useClaimMapTool(claim);

  const setOfficial = useMutation(api.putIns.setOfficial);
  const setParking = useMutation(api.accessPoints.setOfficialParking);
  const setPutInAccess = useMutation(api.accessPoints.setPutInAccess);
  const { act } = useTabAction(bodyId);

  const openSession = useRef<number | null>(null);
  useEffect(() => {
    openSession.current = draft?.session ?? null;
  }, [draft?.session]);
  useEffect(
    () => () => {
      openSession.current = null;
    },
    [],
  );

  const save = async () => {
    if (draft === null || saving || saveBlocker(draft) !== null) return;
    const d = draft;
    const title = savedTitle(d, lots);
    let lit: string | null = null;
    setSaving(true);
    try {
      let landed = false;
      if (d.kind === 'putIn' && d.point !== null) {
        const coord = d.point;
        const name = d.name.trim();
        landed = await act(
          async () => {
            const id = await setOfficial({ waterBodyId, coord, ...(name ? { name } : {}) });
            lit = litId.putIn(id);
            return id;
          },
          { title, target: { targetType: 'waterbody', targetId: bodyId } },
        );
      } else if (d.kind === 'lot' && d.point !== null) {
        const coord = d.point;
        const name = d.name.trim();
        landed = await act(
          async () => {
            const id = await setParking({
              coord,
              ...(name ? { name } : {}),
              amenities: [],
              waterBodyIds: [waterBodyId],
            });
            lit = litId.lot(id);
            return id;
          },
          (id) => ({ title, target: { targetType: 'parkingArea', targetId: id } }),
        );
      } else if (d.kind === 'link' && d.choice !== null) {
        const choice = d.choice;
        const putInId = d.putIn.id as Id<'putIns'>;
        // *No parking* sends no assertion: its checkbox is hidden, so nothing it holds is sent.
        const assert =
          choice === 'none' || d.hikeIn === d.putIn.hikeIn
            ? {}
            : d.hikeIn
              ? { approachKindOverride: 'hike_in' as const }
              : { clearApproachOverride: true };
        // The lot it has already, with only the assertion changed: the lot isn't sent again, so the
        // walk already measured from it (routed, with its line) is kept rather than reset to a
        // straight line and walked again.
        const sameLot = choice !== 'none' && choice.lotId === d.putIn.lotId;
        landed = await act(
          () =>
            setPutInAccess({
              putInId,
              ...(choice === 'none'
                ? { clearParking: true }
                : sameLot
                  ? {}
                  : { parkingAreaId: choice.lotId as Id<'parkingAreas'> }),
              ...assert,
            }),
          { title, target: { targetType: 'putIn', targetId: d.putIn.id } },
        );
        lit = litId.putIn(d.putIn.id);
      }
      if (!landed || openSession.current !== d.session) return;
      setDraft(null);
      if (lit !== null) onLitChange?.(lit);
    } finally {
      setSaving(false);
    }
  };

  const task =
    draft === null ? null : (
      <AccessTask
        draft={draft}
        lots={lots}
        saving={saving}
        onName={(name) => setDraft((d) => (d === null || d.kind === 'link' ? d : { ...d, name }))}
        onNoParking={() =>
          // The hike-in checkbox goes with the lot: back to what the put-in has, so a box ticked
          // and then hidden is never what the save sends.
          setDraft((d) =>
            d === null || d.kind !== 'link' ? d : { ...d, choice: 'none', hikeIn: d.putIn.hikeIn },
          )
        }
        onHikeIn={(hikeIn) =>
          setDraft((d) => (d === null || d.kind !== 'link' ? d : { ...d, hikeIn }))
        }
        onSave={() => void save()}
        onDiscard={discard}
      />
    );

  return {
    draft,
    task,
    addPutIn: () => setDraft(startPutIn()),
    addLot: () => setDraft(startLot()),
    linkLot: (putIn) => setDraft(startLink(putIn)),
  };
}
