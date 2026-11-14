import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { polygonBBox, waterBodyDisplayName } from '@skating/core';
import { useMemo, useState } from 'react';
import type { BBoxLike } from '@/lib/mapSurface';
import { useRole } from '@/lib/useRole';
import type { Completeness } from '../completeness';
import { type BodyMapBaseInput, bodyMapBase } from '../map/bodyMapBase';
import type { BodyMapScene } from '../map/mapDescriptors';
import {
  attentionTabs,
  type BodyAsk,
  type BodyHistoryView,
  type BodyIdentity,
  bodyAsks,
  bodyHistory,
  bodyIdentity,
  type HistoryAction,
  latestOnBody,
  type OutlineTrust,
  outlineTrust,
  type Removal,
  removalOf,
} from './bodyModel';
import type { BodyTabKey } from './bodySearch';
import {
  isFailed,
  type Loadable,
  loaded,
  mapLoadable,
  type ReadFailure,
  read,
  useConsoleReads,
} from './consoleReads';
import { retryAll, useNeighbors } from './touching';

/**
 * **The Body console's reads.** The body (`waterBodies.get`) decides which page this is; around it,
 * each block reads on its own and says so in its own place when its read fails:
 *
 * - **The map** — the bays, landmarks, put-ins and lots (the old editor's reads), and the bodies
 *   that touch this one (`touching.ts`), drawn as neighbors.
 * - **Completeness** — the answer the server stores for the body (`bodies.preview`'s `complete`:
 *   core's `bodyCompleteness`, the founder's ten). The console never decides it again; a body with
 *   no stored answer yet is *not recorded*.
 * - **The identity list's towns and the outline's trust** — `bodyConsole.consoleExtras`.
 * - **Asked of this body** — bay requests, the email place names, landmark proposals.
 * - **History** — `bodyConsole.history`: the body's whole family (bays, landmarks, put-ins, lots,
 *   absorbed bodies…), newest first. It can come back `capped` (on a very large lake, always), and
 *   is never drawn as whole when it is.
 *
 * **A body the reads can't serve** — rejected, or merged into another — is its own page: it says the
 * body has been removed (or merged, and into which) and what the record still holds. **`null` is
 * not recorded**, never a zero.
 */

/** How many history rows the frame reads (the server's most is 100). */
export const HISTORY_LIMIT = 50;
/** Rows of one verb read to find the body's own latest, when the main history stopped short. */
const VERB_LIMIT = 10;

/**
 * The most rows the two asks reads without a `more` flag return (the server's `QUEUE_CAP`s,
 * unexported: `corpusPlaceNames.openForBody` and `corpusRequests.openBayRequestsForBody`, whose
 * groups' `askers` sum to the rows read). A read that comes back this full may have stopped short,
 * so the asks are never counted as whole (a server request: a `more` flag on each).
 */
const PLACE_NAMES_READ_CAP = 400;
const BAY_REQUESTS_READ_CAP = 200;

/** A Convex id's shape, so a hand-edited link never reaches a read as junk. */
const ID_SHAPE = /^[0-9a-z]{30,34}$/;

/** A body the console can't open, and what the record still says about it. */
export interface BodyGoneData {
  /** The body it was merged into, when the merge can be followed; `null` for a rejected body. */
  survivor: { id: string; name: string } | null;
  /**
   * How it left, from the history read: `null` when the rows read don't say. Drawn only when the
   * viewer reads the audit trail (`history` isn't `null`).
   */
  removal: Loadable<Removal | null>;
  /** The towns it lies in (`null`: no boundary contains it), for a rejected body. */
  towns: Loadable<readonly string[] | null> | null;
  /** Its reports since the record began, for a rejected body; `null`: the read found no body. */
  reports: Loadable<{ count: number; capped: boolean } | null> | null;
  history: Loadable<BodyHistoryView> | null;
}

/** The map's reads that failed: named for the notice, and run again together. */
export interface MapFailures {
  /** What the map couldn't read, in words ("the bays", "the put-ins"). */
  what: readonly string[];
  retry: () => void;
}

export type BodyConsoleData =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; retry: () => void }
  | { state: 'gone'; gone: BodyGoneData }
  | {
      state: 'ready';
      identity: BodyIdentity;
      completeness: Loadable<Completeness | null>;
      towns: Loadable<readonly string[] | null>;
      trust: Loadable<OutlineTrust | null>;
      asks: Loadable<readonly BodyAsk[]>;
      /** More landmark proposals wait than the read returned. */
      asksMore: boolean;
      /** `null` when the viewer can't read the audit trail: the section isn't drawn. */
      history: Loadable<BodyHistoryView> | null;
      attention: ReadonlySet<BodyTabKey>;
      bbox: BBoxLike;
      scene: BodyMapScene;
      mapFailures: MapFailures | null;
      lastCampaign: string | null;
      canSetBoost: boolean;
    };

/** The minute a body was opened at, held while it stays open: the clock its reads are asked at. */
function useOpenedAt(bodyId: string): number {
  const [clock, setClock] = useState(() => ({ bodyId, at: minute(Date.now()) }));
  if (clock.bodyId !== bodyId) {
    const next = { bodyId, at: minute(Date.now()) };
    setClock(next);
    return next.at;
  }
  return clock.at;
}

const minute = (at: number) => Math.floor(at / 60_000) * 60_000;

export function useBodyConsole(bodyId: string, timeZone?: string): BodyConsoleData {
  const valid = ID_SHAPE.test(bodyId);
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can, isLoading } = useRole();
  const canRead = can('body.read');
  const canAudit = can('audit.read');
  // A read the viewer's role withholds: on its way while the role loads (`can` says no until it
  // lands), never `null` — which says *not recorded*, a claim about the body.
  const withheld = isLoading ? undefined : null;
  const now = useOpenedAt(bodyId);
  const on = valid;
  const r = useConsoleReads({
    body: on ? read(api.waterBodies.get, { waterBodyId }) : null,
    subAreas: on ? read(api.subAreas.listForBody, { waterBodyId }) : null,
    landmarks: on ? read(api.landmarks.listForEditor, { waterBodyId }) : null,
    putIns: on ? read(api.putIns.listForBody, { waterBodyId }) : null,
    access: on ? read(api.accessPoints.accessForBody, { waterBodyId }) : null,
    bayAsks: on ? read(api.corpusRequests.openBayRequestsForBody, { waterBodyId }) : null,
    placeNames: on ? read(api.corpusPlaceNames.openForBody, { waterBodyId }) : null,
    landmarkAsks: on ? read(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId }) : null,
    extras: on && canRead ? read(api.bodyConsole.consoleExtras, { waterBodyId }) : null,
    facts: on && canRead ? read(api.bodies.preview, { waterBodyId, now }) : null,
    history:
      on && canAudit ? read(api.bodyConsole.history, { waterBodyId, limit: HISTORY_LIMIT }) : null,
  });

  const result = loaded(r.body);
  const body = result?.available === true && result.body._id === bodyId ? result.body : null;
  const historyRows = loaded(r.history);
  const rows = (historyRows?.entries ?? []) as readonly HistoryAction[];

  // The main history read stopped short of the body's own ruling or boost: read that verb alone.
  const needs = (verb: 'set_public_access' | 'set_curated_boost', recorded: boolean) =>
    body !== null &&
    recorded &&
    historyRows?.capped === true &&
    latestOnBody(rows, bodyId, verb) === null;
  const verbs = useConsoleReads({
    ruling: needs('set_public_access', body?.publicAccess !== undefined)
      ? read(api.bodyConsole.history, {
          waterBodyId,
          action: 'set_public_access',
          limit: VERB_LIMIT,
        })
      : null,
    boost: needs('set_curated_boost', body?.curatedBoost !== undefined)
      ? read(api.bodyConsole.history, {
          waterBodyId,
          action: 'set_curated_boost',
          limit: VERB_LIMIT,
        })
      : null,
  });

  const extras = r.extras;
  const neighbors = useNeighbors(body === null ? undefined : loaded(extras));

  const subAreas = loaded(r.subAreas);
  const landmarks = loaded(r.landmarks);
  const putIns = loaded(r.putIns);
  const access = loaded(r.access);
  const neighborList = loaded(neighbors);
  const scene = useMemo<BodyMapScene | null>(() => {
    if (!body) return null;
    const input: BodyMapBaseInput = {
      bodyId: body._id,
      polygon: body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
      bays: (subAreas ?? [])
        .filter((s) => !s.removed)
        .map((s) => ({
          id: s._id,
          name: s.name,
          polygon: s.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
          mouth: s.mouth ? { a: s.mouth.a, b: s.mouth.b } : null,
        })),
      landmarks: (landmarks ?? [])
        .filter((l) => l.removedAt === undefined)
        .map((l) => ({
          id: l._id,
          name: l.name,
          kind: l.kind,
          point: l.point,
          source: l.source,
        })),
      putIns: (putIns ?? []).flatMap((p, i) =>
        p.coord
          ? [{ id: p.id ?? `derived-${i}`, coord: p.coord, ...(p.name ? { name: p.name } : {}) }]
          : [],
      ),
      lots: (access?.parking ?? []).map((lot) => ({
        id: lot.id,
        coord: lot.coord,
        ...(lot.name ? { name: lot.name } : {}),
      })),
      samplePoints: body.weatherSamplePoints ?? [],
      neighbors: neighborList ?? [],
    };
    return bodyMapBase(input);
  }, [body, subAreas, landmarks, putIns, access, neighborList]);

  if (!valid) return { state: 'missing' };
  if (r.body === undefined) return { state: 'loading' };
  if (isFailed(r.body)) return { state: 'failed', retry: r.body.retry };
  if (r.body === null) return { state: 'missing' };

  const history: Loadable<BodyHistoryView> | null = !canAudit
    ? withheld
    : mapLoadable(r.history, (h) => ({
        entries: bodyHistory(h.entries as readonly HistoryAction[]),
        capped: h.capped,
      }));

  if (body === null || scene === null) {
    const survivor = r.body.available
      ? { id: r.body.body._id, name: waterBodyDisplayName(r.body.body.name) }
      : null;
    return {
      state: 'gone',
      gone: {
        survivor,
        removal: mapLoadable(r.history, (h) =>
          removalOf(h.entries as readonly HistoryAction[], bodyId, timeZone),
        ),
        // A merged body's facts went with it to the survivor; a rejected one's are still its own.
        towns:
          survivor !== null ? null : !canRead ? withheld : mapLoadable(r.extras, (e) => e.towns),
        reports:
          survivor !== null
            ? null
            : !canRead
              ? withheld
              : mapLoadable(r.facts, (f) => (f === null ? null : f.allTime)),
        history,
      },
    };
  }

  // The body's own ruling and boost rows: the main read's, else the one verb's own read.
  const verbRows = [loaded(verbs.ruling), loaded(verbs.boost)].flatMap(
    (h) => (h?.entries ?? []) as readonly HistoryAction[],
  );
  const identity = bodyIdentity(body, {
    history: [...rows, ...verbRows],
    ...(timeZone !== undefined ? { timeZone } : {}),
  });

  const completeness: Loadable<Completeness | null> = !canRead
    ? withheld
    : mapLoadable(r.facts, (f) => f?.complete ?? null);

  const askReads = [r.bayAsks, r.placeNames, r.landmarkAsks];
  const askFailures = askReads.filter(isFailed);
  const bayAsks = loaded(r.bayAsks);
  const placeNames = loaded(r.placeNames);
  const landmarkAsks = loaded(r.landmarkAsks);
  const asks: Loadable<readonly BodyAsk[]> =
    askFailures.length > 0
      ? retryAll(askFailures)
      : bayAsks === undefined || placeNames === undefined || landmarkAsks === undefined
        ? undefined
        : bodyAsks({ bays: bayAsks, placeNames, landmarks: landmarkAsks.proposals });

  const mapReads: [Loadable<unknown>, string][] = [
    [r.subAreas, 'the bays'],
    [r.landmarks, 'the landmarks'],
    [r.putIns, 'the put-ins'],
    [r.access, 'the lots'],
    [neighbors, 'the bodies that touch it'],
  ];
  const mapFailed = mapReads.filter(([v]) => isFailed(v)) as [ReadFailure, string][];
  const mapFailures: MapFailures | null =
    mapFailed.length === 0
      ? null
      : { what: mapFailed.map(([, w]) => w), retry: retryAll(mapFailed.map(([f]) => f)).retry };

  const done = completeness !== undefined && !isFailed(completeness) ? completeness : null;
  return {
    state: 'ready',
    identity,
    completeness,
    towns: !canRead ? withheld : mapLoadable(extras, (e) => e.towns),
    trust: !canRead ? withheld : mapLoadable(extras, (e) => outlineTrust(e, timeZone)),
    asks,
    // Only the proposals' read says it stopped short; the other two are full at their cap.
    asksMore:
      landmarkAsks?.more === true ||
      (placeNames?.length ?? 0) >= PLACE_NAMES_READ_CAP ||
      (bayAsks ?? []).reduce((n, b) => n + b.askers, 0) >= BAY_REQUESTS_READ_CAP,
    history,
    attention: attentionTabs(done?.missing ?? []),
    bbox: polygonBBox(body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon),
    scene,
    mapFailures,
    lastCampaign: body.lastCampaignId ?? null,
    canSetBoost: can('body.identity'),
  };
}
