import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { SubAreaMouth } from '@skating/core';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isFailed, loaded, read, useConsoleReads } from '@/components/admin/reads/consoleReads';
import { sayRefusal } from '@/components/admin/said';
import type { BBoxLike } from '@/lib/mapSurface';
import { askClosedLine } from '../../consoleWords';
import { returnPathOf, validateBodySearch } from '../../frame/bodySearch';
import { type MapToolClaim, useClaimMapTool } from '../../frame/mapTool';
import { heldEngine, useTaskDraft } from '../../frame/taskDraft';
import { useTabAction } from '../useTabAction';
import { BayTask } from './BayTask';
import {
  aliasList,
  type BayDraft,
  bayModeBar,
  saveBlocker,
  savedTitle,
  startDraft,
  withChord,
  withPaste,
  withRing,
  withWay,
} from './bayDraft';
import type { BayWay } from './ShapeTab';

/**
 * **The bay task, wired** (B01-6a): the Shape tab's draft (`bayDraft`), its claim on the console
 * map (`frame/mapTool`), its arrivals, and its save.
 *
 * - **Starting**: a way from *Add a bay*; *Redraw* or the mouth on a lit bay; or an arrival — an
 *   Inbox bay ask (`?task=`, its name, spellings and point from `openBayRequestsForBody`) or a
 *   landmark to draw as a bay (`?promote=`, from `landmarks.listForEditor`). An arrival is taken
 *   once and dropped from the address; an ask that is no longer open says so in a toast.
 * - **The claim**: while a draft is up the map draws with its way's engine, the mode bar says what
 *   to do next, and the shape as it stands is drawn as the draft. Esc (or the bar's cap) discards.
 * - **Saving** goes through the tab's writer (`useTabAction`): a new bay by chord
 *   (`subAreas.createFromChord`) or by shape (`subAreas.create`), each with the ask it answers and
 *   the landmark it retires; a redraw (`subAreas.redraw`); a mouth (`subAreas.updateChord`). The
 *   receipt names the bay, with Undo as the server offers it. Once it lands the bay is lit; an
 *   Inbox arrival goes back to the Inbox item it came from.
 */

/** A bay row as `subAreas.listForBody` reads it, as far as the tools need. */
export interface BayToolRow {
  _id: string;
  name: string;
  removed: boolean;
  polygon?: unknown;
  bbox?: BBoxLike;
  mouth?: SubAreaMouth;
}

export function useBayTask({
  bodyId,
  parent,
  rows,
  onLitChange,
}: {
  bodyId: string;
  /** The body's outline; until it is read, nothing can be drawn. */
  parent: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  rows: readonly BayToolRow[] | undefined;
  onLitChange: (lit: string | null) => void;
}): {
  draft: BayDraft | null;
  task: ReactNode;
  startNew: (way: BayWay) => void;
  redraw: (bayId: string) => void;
  mouth: (bayId: string) => void;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => validateBodySearch(raw), [raw]);
  const navigate = useNavigate();
  const router = useRouter();
  // Held still while a save is out: its edits wait (`useTaskDraft`).
  const { draft, setDraft, edit, saving, setSaving } = useTaskDraft<BayDraft>();
  /** An Inbox arrival: the save goes back to where it came from. */
  const [returnAfter, setReturnAfter] = useState(false);

  const reads = useConsoleReads({
    asks:
      search.task !== undefined
        ? read(api.corpusRequests.openBayRequestsForBody, {
            waterBodyId,
            // The ask arrived for is read by its id when the bounded list leaves it out.
            including: search.task as Id<'waterBodyRequests'>,
          })
        : null,
    landmarks:
      search.promote !== undefined ? read(api.landmarks.listForEditor, { waterBodyId }) : null,
  });
  const asks = loaded(reads.asks);
  const landmarks = loaded(reads.landmarks);
  // A read that failed says so and lets the arrival go, rather than leaving it armed and silent.
  const asksFailed = isFailed(reads.asks);
  const landmarksFailed = isFailed(reads.landmarks);

  // Each arrival is taken once, then dropped from the address (a reload or Back never re-arms it).
  const dropArrival = () =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const { task: _t, promote: _p, ...rest } = prev;
        return rest;
      },
      replace: true,
    } as never);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, when the asks are read.
  useEffect(() => {
    if (search.task === undefined) return;
    if (asksFailed) {
      sayRefusal({
        title: 'Nothing to draw',
        description: 'This lake’s bay asks couldn’t be read. Open the ask from the Inbox again.',
      });
      dropArrival();
      return;
    }
    if (asks === undefined) return;
    const task = search.task;
    const row = asks.bays.find((b) => b.requestId === task || b.requestIds.includes(task as never));
    if (row === undefined) {
      // The read names the ask arrived for even past its bound, so a miss is an ask closed since.
      sayRefusal({ title: 'Nothing to draw', description: 'That ask isn’t open any more.' });
    } else {
      setDraft(
        startDraft(
          { kind: 'new', request: { requestId: task, asks: row.askers } },
          {
            name: row.name,
            aliases: row.aliases,
            focus: row.coord !== undefined ? { point: row.coord } : null,
          },
        ),
      );
      setReturnAfter(search.from !== undefined);
    }
    dropArrival();
  }, [search.task, asks, asksFailed]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, when the landmarks are read.
  useEffect(() => {
    if (search.promote === undefined) return;
    if (landmarksFailed) {
      sayRefusal({
        title: 'Nothing to draw',
        description: 'This lake’s landmarks couldn’t be read. Try Draw as a bay again.',
      });
      dropArrival();
      return;
    }
    if (landmarks === undefined) return;
    const id = search.promote;
    const landmark = landmarks.find((l) => l._id === id && l.removedAt === undefined);
    if (landmark === undefined) {
      sayRefusal({
        title: 'Nothing to draw',
        description: 'That landmark isn’t on this body any more.',
      });
    } else {
      setDraft(
        startDraft(
          { kind: 'new', promote: { landmarkId: id, name: landmark.name } },
          { aliases: landmark.aliases, focus: { point: landmark.point } },
        ),
      );
    }
    dropArrival();
  }, [search.promote, landmarks, landmarksFailed]);

  const rowOf = (bayId: string) => rows?.find((r) => `bay:${r._id}` === bayId && !r.removed);

  const discard = useCallback(() => {
    setDraft(null);
    setReturnAfter(false);
  }, [setDraft]);

  // The claim on the map, read off the draft.
  const claim = useMemo((): MapToolClaim | null => {
    if (draft === null || parent === null) return null;
    const bar = bayModeBar(draft);
    const t = draft.target;
    const engine: MapToolClaim['engine'] =
      draft.way === 'chord'
        ? {
            kind: 'chord',
            parent,
            // The mouth as it stands, so a map re-created mid-task (a theme switch) puts back
            // what was drawn or moved, not what the task started from.
            ...(draft.mouth !== null
              ? { mouth: draft.mouth }
              : t.kind === 'mouth' && t.mouth !== null
                ? { mouth: t.mouth }
                : {}),
            onChange: (state, mouth, preview) => edit((d) => withChord(d, state, mouth, preview)),
          }
        : draft.way === 'freehand' && !draft.ringUnavailable
          ? {
              kind: 'ring',
              // The ring as it stands, as the chord's mouth is.
              ...(draft.shape?.type === 'Polygon'
                ? { polygon: draft.shape }
                : t.kind === 'redraw' && t.polygon !== null
                  ? { polygon: t.polygon }
                  : {}),
              onChange: (polygon) => edit((d) => withRing(d, polygon)),
              onUnavailable: () => edit((d) => ({ ...d, ringUnavailable: true })),
            }
          : { kind: 'none' };
    return {
      session: `bay:${draft.session}:${draft.ringUnavailable ? 'paste' : draft.way}`,
      engine: heldEngine(saving, engine),
      mode: bar.mode,
      line: bar.line,
      ...(bar.step !== undefined ? { step: bar.step } : {}),
      // A chord's own marks show the line; the shape it cuts is the draft under them.
      draft: draft.shape,
      focus: draft.focus,
      onExit: discard,
    };
  }, [draft, parent, discard, edit, saving]);
  useClaimMapTool(claim);

  const create = useMutation(api.subAreas.create);
  const createFromChord = useMutation(api.subAreas.createFromChord);
  const redrawWrite = useMutation(api.subAreas.redraw);
  const updateChord = useMutation(api.subAreas.updateChord);
  const { act } = useTabAction(bodyId);

  // A save outlives its task (`act` settles after the tab unmounts, by design): what it does after
  // the write — clear the draft, light the bay, go back to the Inbox — is the task's, so it happens
  // only while that same task is still the one open. The write and its receipt land regardless.
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
    const t = d.target;
    const title = savedTitle(d);
    const subArea = (id: string) => ({ targetType: 'waterBodySubArea', targetId: id }) as const;
    let savedId: string | null = null;
    setSaving(true);
    try {
      let landed = false;
      if (t.kind === 'new') {
        const common = {
          waterBodyId,
          name: d.name.trim(),
          ...(aliasList(d).length > 0 ? { aliases: aliasList(d) } : {}),
          ...(t.request !== undefined
            ? { requestId: t.request.requestId as Id<'waterBodyRequests'> }
            : {}),
          ...(t.promote !== undefined
            ? { promoteLandmarkId: t.promote.landmarkId as Id<'bodyLandmarks'> }
            : {}),
        };
        landed =
          d.way === 'chord' && d.mouth !== null
            ? await act(
                async () => {
                  const answer = await createFromChord({
                    ...common,
                    mouth: d.mouth as SubAreaMouth,
                  });
                  savedId = answer.subAreaId;
                  return answer;
                },
                (answer) => ({
                  title,
                  target: subArea(answer.subAreaId),
                  ...(askClosedLine(answer.request)
                    ? { description: askClosedLine(answer.request) }
                    : {}),
                }),
              )
            : await act(
                async () => {
                  const answer = await create({ ...common, polygon: d.shape as never });
                  savedId = answer.subAreaId;
                  return answer;
                },
                // As the chord's: an ask decided elsewhere meanwhile keeps its answer, and says so.
                (answer) => ({
                  title,
                  target: subArea(answer.subAreaId),
                  ...(askClosedLine(answer.request)
                    ? { description: askClosedLine(answer.request) }
                    : {}),
                }),
              );
      } else if (t.kind === 'redraw') {
        savedId = t.subAreaId;
        landed = await act(
          () =>
            redrawWrite({
              subAreaId: t.subAreaId as Id<'waterBodySubAreas'>,
              polygon: d.shape as never,
            }),
          { title, target: subArea(t.subAreaId) },
        );
      } else {
        savedId = t.subAreaId;
        landed = await act(
          () =>
            updateChord({
              subAreaId: t.subAreaId as Id<'waterBodySubAreas'>,
              mouth: d.mouth as SubAreaMouth,
            }),
          { title, target: subArea(t.subAreaId) },
        );
      }
      if (!landed || openSession.current !== d.session) return;
      setDraft(null);
      if (returnAfter) {
        setReturnAfter(false);
        router.history.push(returnPathOf(search));
        return;
      }
      if (savedId !== null) onLitChange(`bay:${savedId}`);
    } finally {
      setSaving(false);
    }
  };

  const task =
    draft === null ? null : (
      <BayTask
        draft={draft}
        saving={saving}
        onName={(name) => edit((d) => ({ ...d, name }))}
        onAliases={(aliases) => edit((d) => ({ ...d, aliases }))}
        onWay={(way) => edit((d) => withWay(d, way))}
        onPaste={(paste) => edit((d) => withPaste(d, paste))}
        onSave={() => void save()}
        onDiscard={discard}
      />
    );

  return {
    draft,
    task,
    startNew: (way) => {
      setReturnAfter(false);
      setDraft(startDraft({ kind: 'new' }, { way }));
    },
    redraw: (bayId) => {
      const row = rowOf(bayId);
      if (row === undefined) return;
      const polygon = row.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined;
      setReturnAfter(false);
      setDraft(
        startDraft({
          kind: 'redraw',
          subAreaId: row._id,
          name: row.name,
          // Only a single ring can be handed to the vertex editor; a multi-part bay is traced anew.
          polygon: polygon?.type === 'Polygon' ? polygon : null,
          bbox: row.bbox ?? null,
        }),
      );
    },
    mouth: (bayId) => {
      const row = rowOf(bayId);
      if (row === undefined) return;
      setReturnAfter(false);
      setDraft(
        startDraft({
          kind: 'mouth',
          subAreaId: row._id,
          name: row.name,
          mouth: row.mouth ?? null,
          bbox: row.bbox ?? null,
        }),
      );
    },
  };
}
