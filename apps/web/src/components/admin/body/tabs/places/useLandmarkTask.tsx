import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { LatLng } from '@skating/core';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isFailed, loaded, read, useConsoleReads } from '@/components/admin/reads/consoleReads';
import { sayRefusal } from '@/components/admin/said';
import { returnPathOf, validateBodySearch } from '../../frame/bodySearch';
import { type MapToolClaim, useClaimMapTool } from '../../frame/mapTool';
import { heldEngine, useTaskDraft } from '../../frame/taskDraft';
import { useTabAction } from '../useTabAction';
import { LandmarkDrop } from './LandmarkDrop';
import {
  aliasList,
  dropModeBar,
  droppedReceipt,
  type LandmarkDraft,
  landmarkSaveBlocker,
  moveModeBar,
  startLandmarkDraft,
  withPoint,
} from './landmarkDraft';
import { type LandmarkRow, litId, type PlaceNameAsk, type ProposalAsk } from './placesModel';

/**
 * **The landmark tools, wired** (B01-6b): dropping a landmark and moving one, on the console map's
 * point tool (`frame/mapTool`, `lib/pointDraw`).
 *
 * - **Drop** (`startDrop`, L): the drop card (`LandmarkDrop`) over the list, and the map's point
 *   tool: a click places the point, another click or a drag moves it. *Add to the map* sends
 *   `landmarks.create` through the tab's writer, the receipt names the landmark with Undo, and the
 *   new landmark is lit. An emailed name (`placeName`) or a skater's proposal (`addProposal`) opens
 *   the same card filled — a proposal's point where the skater put it — and the save sends the ask
 *   it answers (`corpusNameId`, `requestId`).
 * - **An Inbox arrival** (`?landmarkAsk=<request id>`): the proposal's card, read by the ask's id
 *   (`openLandmarkRequestsForBody`'s `including`); taken once and dropped from the address; the
 *   save goes back to the Inbox item. An ask no longer open says so in a toast.
 * - **Move** (`toggleMove`, M on the lit landmark's card): the point tool holding the landmark's
 *   point. A click anywhere puts it there, a drag of the mark moves it; each pick saves at once
 *   (`landmarks.update` with the point, its Undo the server's). The tool stays until Esc, the mode
 *   bar's cap, Move again, or the card closing, so a second adjustment is one more click.
 * - **One claim at a time**: a drop and a move never hold the map together — starting one ends the
 *   other.
 */
/** A point as a key: the move's session follows the landmark's point as the server holds it. */
const pointKey = (p: LatLng) => `${p.lat},${p.lng}`;

export function useLandmarkTask({
  bodyId,
  landmarks,
  lit,
  onLitChange,
  canAnswerAsk,
}: {
  bodyId: string;
  landmarks: readonly LandmarkRow[];
  lit: string | null;
  onLitChange: ((lit: string | null) => void) | undefined;
  /**
   * The viewer may place a skater's ask (`body.places` and `inbox.request`, as the server asks):
   * an Inbox arrival opens its card only then. `undefined` while the role is read.
   */
  canAnswerAsk: boolean | undefined;
}): {
  draft: LandmarkDraft | null;
  drop: ReactNode;
  /** The landmark being moved, while the tool holds it. */
  moving: string | null;
  startDrop: () => void;
  placeName: (ask: PlaceNameAsk) => void;
  addProposal: (ask: ProposalAsk) => void;
  toggleMove: (landmarkId: string) => void;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => validateBodySearch(raw), [raw]);
  const navigate = useNavigate();
  const router = useRouter();
  // Held still while a save is out: its edits wait (`useTaskDraft`).
  const { draft, setDraft, edit, saving, setSaving } = useTaskDraft<LandmarkDraft>();
  /** An Inbox arrival: the save goes back to where it came from. */
  const [returnAfter, setReturnAfter] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);

  const reads = useConsoleReads({
    asks:
      search.landmarkAsk !== undefined
        ? read(api.corpusRequests.openLandmarkRequestsForBody, {
            waterBodyId,
            including: search.landmarkAsk as Id<'waterBodyRequests'>,
          })
        : null,
  });
  const asks = loaded(reads.asks);
  const asksFailed = isFailed(reads.asks);

  // Taken once, then dropped from the address (a reload or Back never re-arms it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, when the asks are read.
  useEffect(() => {
    const id = search.landmarkAsk;
    if (id === undefined) return;
    const drop = () =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => {
          const { landmarkAsk: _a, ...rest } = prev;
          return rest;
        },
        replace: true,
      } as never);
    // Until the role is read, wait; a viewer who couldn't save it isn't handed a card to fill.
    if (canAnswerAsk === undefined) return;
    if (!canAnswerAsk) {
      sayRefusal({
        title: 'Nothing to place',
        description:
          'Placing a skater’s ask takes both the Places and the Inbox permissions, and this account doesn’t have both.',
      });
      drop();
      return;
    }
    if (asksFailed) {
      sayRefusal({
        title: 'Nothing to place',
        description:
          'This lake’s landmark asks couldn’t be read. Open the ask from the Inbox again.',
      });
      drop();
      return;
    }
    if (asks === undefined) return;
    const row = asks.proposals.find(
      (p) => p.requestId === id || (p.requestIds as readonly string[]).includes(id),
    );
    if (row === undefined) {
      // The read names the ask arrived for even past its bound, so a miss is an ask closed since.
      sayRefusal({ title: 'Nothing to place', description: 'That ask isn’t open any more.' });
    } else {
      // The arrival's address lights nothing (`arrivalSearch`): the drop is the one card open.
      setMovingId(null);
      setDraft(
        startLandmarkDraft(
          { kind: 'proposal', requestId: id, askers: row.askers },
          { name: row.name, aliases: row.aliases, point: row.coord },
        ),
      );
      setReturnAfter(search.from !== undefined);
    }
    drop();
  }, [search.landmarkAsk, asks, asksFailed, canAnswerAsk]);

  const discard = useCallback(() => {
    setDraft(null);
    setReturnAfter(false);
  }, [setDraft]);
  const stopMove = useCallback(() => setMovingId(null), []);

  // A move belongs to the lit landmark's card: the card closing, or the landmark leaving the list
  // (removed, merged away), lets the tool go.
  const moving = movingId !== null && lit === litId.landmark(movingId) ? movingId : null;
  const movingRow = moving === null ? undefined : landmarks.find((l) => l.id === moving);
  useEffect(() => {
    if (movingId !== null && (moving === null || (landmarks.length > 0 && !movingRow))) {
      setMovingId(null);
    }
  }, [movingId, moving, movingRow, landmarks.length]);

  const update = useMutation(api.landmarks.update);
  const create = useMutation(api.landmarks.create);
  const { act } = useTabAction(bodyId);

  /** The point the move started from: the camera goes there once, not after every move. */
  const startedAt = useRef<string | null>(null);
  /**
   * Bumped when a move doesn't land: the point the server holds didn't change, so the drawing starts
   * over from it — the mark goes back to where the landmark is, not left where the refused move put it.
   */
  const [refusedMoves, setRefusedMoves] = useState(0);

  const move = useCallback(
    (row: LandmarkRow, point: LatLng) =>
      void act(() => update({ landmarkId: row.id as Id<'bodyLandmarks'>, point }), {
        title: `Moved · ${row.name}`,
        target: { targetType: 'bodyLandmark', targetId: row.id },
      }).then((landed) => {
        if (!landed) setRefusedMoves((n) => n + 1);
      }),
    [act, update],
  );

  const claim = useMemo((): MapToolClaim | null => {
    if (draft !== null) {
      const bar = dropModeBar(draft);
      return {
        session: `landmark:drop:${draft.session}`,
        engine: heldEngine(saving, {
          kind: 'point',
          // The point as it stands, so a map re-created mid-task (a theme switch) puts it back.
          ...(draft.point !== null ? { point: draft.point } : {}),
          onPick: (p) => edit((d) => withPoint(d, p)),
        }),
        mode: bar.mode,
        line: bar.line,
        focus: draft.focus,
        onExit: discard,
      };
    }
    if (movingRow !== undefined) {
      const bar = moveModeBar(movingRow.name);
      const key = pointKey(movingRow.point);
      return {
        // The landmark's point as the server holds it: a move landing, or an Undo, puts the mark
        // where the landmark now is — and a move refused puts it back there too.
        session: `landmark:move:${movingRow.id}:${key}:${refusedMoves}`,
        engine: { kind: 'point', point: movingRow.point, onPick: (p) => move(movingRow, p) },
        mode: bar.mode,
        line: bar.line,
        focus: startedAt.current === `${key}:${refusedMoves}` ? { point: movingRow.point } : null,
        onExit: stopMove,
      };
    }
    return null;
  }, [draft, movingRow, discard, stopMove, move, refusedMoves, edit, saving]);
  useClaimMapTool(claim);

  // A save outlives its card (`act` settles after the tab unmounts, by design): what it does after
  // the write — close the card, light the landmark, go back to the Inbox — happens only while that
  // same drop is still the one open. The write and its receipt land regardless.
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
    if (draft === null || saving || landmarkSaveBlocker(draft) !== null) return;
    const d = draft;
    const t = d.target;
    const aliases = aliasList(d);
    let savedId: string | null = null;
    setSaving(true);
    try {
      const landed = await act(
        async () => {
          const id = await create({
            waterBodyId,
            name: d.name.trim(),
            kind: d.kind as NonNullable<LandmarkDraft['kind']>,
            point: d.point as LatLng,
            ...(aliases.length > 0 ? { aliases } : {}),
            ...(t.kind === 'place-name'
              ? { corpusNameId: t.corpusNameId as Id<'corpusPlaceNames'> }
              : {}),
            ...(t.kind === 'proposal' ? { requestId: t.requestId as Id<'waterBodyRequests'> } : {}),
          });
          savedId = id;
          return id;
        },
        (id) => ({
          ...droppedReceipt(d),
          target: { targetType: 'bodyLandmark', targetId: id },
        }),
      );
      if (!landed || openSession.current !== d.session) return;
      setDraft(null);
      if (returnAfter) {
        setReturnAfter(false);
        router.history.push(returnPathOf(search));
        return;
      }
      if (savedId !== null) onLitChange?.(litId.landmark(savedId));
    } finally {
      setSaving(false);
    }
  };

  const begin = (next: LandmarkDraft) => {
    setMovingId(null);
    setReturnAfter(false);
    // The card covers the list, and a lit landmark's card with it: the drop is the one thing open.
    if (lit !== null) onLitChange?.(null);
    setDraft(next);
  };

  const drop =
    draft === null ? null : (
      <LandmarkDrop
        draft={draft}
        saving={saving}
        onName={(name) => edit((d) => ({ ...d, name }))}
        onAliases={(aliases) => edit((d) => ({ ...d, aliases }))}
        onKind={(kind) => edit((d) => ({ ...d, kind }))}
        onSave={() => void save()}
        onDiscard={discard}
      />
    );

  return {
    draft,
    drop,
    moving,
    startDrop: () => begin(startLandmarkDraft({ kind: 'new' })),
    placeName: (ask) =>
      begin(
        startLandmarkDraft(
          { kind: 'place-name', corpusNameId: ask.id, messages: ask.messages },
          { name: ask.name, aliases: ask.aliases },
        ),
      ),
    addProposal: (ask) =>
      begin(
        startLandmarkDraft(
          { kind: 'proposal', requestId: ask.id, askers: ask.askers },
          { name: ask.name, aliases: ask.aliases, point: ask.point },
        ),
      ),
    toggleMove: (landmarkId) => {
      if (movingId === landmarkId) {
        setMovingId(null);
        return;
      }
      const row = landmarks.find((l) => l.id === landmarkId);
      if (row === undefined) return;
      discard();
      startedAt.current = `${pointKey(row.point)}:${refusedMoves}`;
      setMovingId(landmarkId);
    },
  };
}
