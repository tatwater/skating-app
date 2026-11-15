import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { polygonBBox, waterBodyClassLabel, waterBodyDisplayName } from '@skating/core';
import { useMemo } from 'react';
import {
  isFailed,
  type Loadable,
  loaded,
  mapLoadable,
  type ReadFailure,
  read,
  retryAll,
  useConsoleReads,
} from '@/components/admin/reads/consoleReads';
import type { BBoxLike } from '@/lib/mapSurface';
import { useRole } from '@/lib/useRole';
import type { Completeness } from '../completeness';
import { type BodyMapBaseInput, bodyMapBase } from '../map/bodyMapBase';
import type { BodyMapScene } from '../map/mapDescriptors';
import {
  acresText,
  attentionTabs,
  type BodyAsk,
  type BodyHistoryView,
  type BodyIdentity,
  bodyAsks,
  bodyHistory,
  bodyIdentity,
  firstName,
  type HistoryAction,
  latestOnBody,
  NOT_COMPUTED,
  type OutlineTrust,
  outlineTrust,
  type Removal,
  removalOf,
  statusDate,
} from './bodyModel';
import { type BodyTabKey, ID_SHAPE } from './bodySearch';
import { neighborsOf } from './touching';

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
 *   bodies merged into it), newest first, each row naming its target (`targetLabel`). `capped`
 *   means only that more rows exist than were returned, and then it is never drawn as whole. When
 *   it stopped short of who ruled on access or who set the boost, that verb is read on the body
 *   alone (`bodyOnly`), its latest rows — the absorbed bodies' own rows come with it.
 *
 * **A body the reads can't serve** — rejected, or merged into another — is its own page: it says the
 * body has been removed (or merged, and into which) and what the record still holds. **`null` is
 * not recorded**, never a zero.
 */

/** How many history rows the frame reads (the server's most is 100). */
export const HISTORY_LIMIT = 50;
/**
 * Rows of one verb read to find the body's own latest: who ruled on access, who set the boost.
 * Never one: `bodyOnly` still reads each body merged into this one on its own rows, so a newer
 * ruling on an absorbed body can come first, and the body's own must still be among the rows.
 */
const VERB_LIMIT = 10;

/** A body the console can't open, and what the record still says about it. */
export interface BodyGoneData {
  /** The body it was merged into, when the merge can be followed; `null` for a rejected body. */
  survivor: { id: string; name: string } | null;
  /**
   * How it left, from the history read: `null` when the rows read don't say. Drawn only when the
   * viewer reads the audit trail (`history` isn't `null`).
   */
  removal: Loadable<Removal | null>;
  /** The towns it lies in (empty: in no town), for a rejected body; not computed yet, said so. */
  towns: Loadable<readonly string[] | typeof NOT_COMPUTED | null> | null;
  /** Its reports since the record began, for a rejected body; `null`: the read found no body. */
  reports: Loadable<{ count: number; capped: boolean } | null> | null;
  history: Loadable<BodyHistoryView> | null;
  /**
   * What the stored record still says of a body that left (`bodyConsole.removedFacts`): its name,
   * class, states and area. `null` for a merged body (the survivor's page has them), or none read.
   */
  record?: Loadable<{
    name: string;
    kind: string;
    states: readonly string[];
    area: string | null;
  } | null>;
}

/** The map's reads that failed: named for the notice, and run again together. */
export interface MapFailures {
  /** What the map couldn't read, in words ("the bays", "the put-ins"). */
  what: readonly string[];
  retry: () => void;
  /** Tried again; the fresh answers aren't in. */
  pending: boolean;
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
      /** The towns it lies in: empty when in no town; not computed yet until its geometry is. */
      towns: Loadable<readonly string[] | typeof NOT_COMPUTED | null>;
      trust: Loadable<OutlineTrust | null>;
      asks: Loadable<readonly BodyAsk[]>;
      /** More is asked than the reads returned (their own `more`): the list is a floor. */
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

export function useBodyConsole(bodyId: string, timeZone?: string): BodyConsoleData {
  const valid = ID_SHAPE.test(bodyId);
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can, isLoading } = useRole();
  const canRead = can('body.read');
  const canAudit = can('audit.read');
  // A read the viewer's role withholds: on its way while the role loads (`can` says no until it
  // lands), never `null` — which says *not recorded*, a claim about the body.
  const withheld = isLoading ? undefined : null;
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
    history:
      on && canAudit ? read(api.bodyConsole.history, { waterBodyId, limit: HISTORY_LIMIT }) : null,
  });

  // A body that left (rejected: the body's read answers only that it is unavailable): what its
  // record still holds — its towns with their states, its report floor, how it left —
  // `bodyConsole.removedFacts`, read only for such a body.
  const left = loaded(r.body)?.available === false;
  const removed = useConsoleReads({
    facts: on && canRead && left ? read(api.bodyConsole.removedFacts, { waterBodyId }) : null,
  }).facts;
  const result = loaded(r.body);
  const body = result?.available === true && result.body._id === bodyId ? result.body : null;
  const historyRows = loaded(r.history);
  const rows = (historyRows?.entries ?? []) as readonly HistoryAction[];

  // Who ruled on access and who set the boost: the main read's rows when they hold the body's own;
  // else, when that read stopped short, the body's own latest row of the verb (`bodyOnly`).
  const verb = (action: 'set_public_access' | 'set_curated_boost', recorded: boolean) =>
    body !== null &&
    recorded &&
    historyRows?.capped === true &&
    latestOnBody(rows, bodyId, action) === null
      ? read(api.bodyConsole.history, { waterBodyId, action, bodyOnly: true, limit: VERB_LIMIT })
      : null;
  const verbs = useConsoleReads({
    ruling: verb('set_public_access', body?.publicAccess !== undefined),
    boost: verb('set_curated_boost', body?.curatedBoost !== undefined),
  });

  const extras = r.extras;
  // The neighbors come with the extras (their names and simplified rings): no read of their own.
  const extrasValue = loaded(extras);
  const neighborList = useMemo(
    () => (extrasValue === undefined ? undefined : neighborsOf(extrasValue)),
    [extrasValue],
  );

  const subAreas = loaded(r.subAreas);
  const landmarks = loaded(r.landmarks);
  const putIns = loaded(r.putIns);
  const access = loaded(r.access);
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

  const facts = loaded(removed);
  const removedLeft: Removal | null =
    facts?.left == null
      ? null
      : {
          verb: facts.left.action === 'remove' ? 'Removed' : 'Rejected',
          when: statusDate(facts.left.at, timeZone),
          who: facts.left.by === null ? null : firstName(facts.left.by.displayName),
          reason: facts.left.reason === '' ? null : facts.left.reason,
        };
  if (body === null || scene === null) {
    const survivor = r.body.available
      ? { id: r.body.body._id, name: waterBodyDisplayName(r.body.body.name) }
      : null;
    return {
      state: 'gone',
      gone: {
        survivor,
        // How it left: the row its standing names (`removedFacts.left`, who decided by name), else
        // the history read's own rows.
        removal:
          removedLeft !== null
            ? removedLeft
            : mapLoadable(r.history, (h) =>
                removalOf(h.entries as readonly HistoryAction[], bodyId, timeZone),
              ),
        record:
          survivor !== null
            ? null
            : !canRead
              ? withheld
              : mapLoadable(removed, (f) =>
                  f === null
                    ? null
                    : {
                        name: waterBodyDisplayName(f.name),
                        kind: waterBodyClassLabel(f.bodyClass),
                        states: f.states,
                        area: f.areaSqM === null ? null : acresText(f.areaSqM),
                      },
                ),
        // A merged body's facts went with it to the survivor; a rejected one's are still its own.
        towns:
          survivor !== null
            ? null
            : !canRead
              ? withheld
              : mapLoadable(removed, (f) =>
                  f === null || f.towns === null
                    ? NOT_COMPUTED
                    : f.towns.map((t) => (t.state === null ? t.name : `${t.name}, ${t.state}`)),
                ),
        reports:
          survivor !== null
            ? null
            : !canRead
              ? withheld
              : mapLoadable(removed, (f) => (f === null ? null : f.reports)),
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

  // The library row's completeness, on the extras (`consoleExtras.complete`): one small field, no
  // longer `bodies.preview` and its report scan.
  const completeness: Loadable<Completeness | null> = !canRead
    ? withheld
    : mapLoadable(r.extras, (e) => (e.complete ?? null) as Completeness | null);

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
        : bodyAsks({
            bays: bayAsks.bays,
            placeNames: placeNames.names,
            landmarks: landmarkAsks.proposals,
          });

  const mapReads: [Loadable<unknown>, string][] = [
    [r.subAreas, 'the bays'],
    [r.landmarks, 'the landmarks'],
    [r.putIns, 'the put-ins'],
    [r.access, 'the lots'],
    // The neighbors come with the extras: when that read failed, the map says it drew none.
    [extras, 'the bodies that touch it'],
  ];
  const mapFailed = mapReads.filter(([v]) => isFailed(v)) as [ReadFailure, string][];
  const mapFailures: MapFailures | null =
    mapFailed.length === 0
      ? null
      : (({ retry, pending }) => ({ what: mapFailed.map(([, w]) => w), retry, pending }))(
          retryAll(mapFailed.map(([f]) => f)),
        );

  const done = completeness !== undefined && !isFailed(completeness) ? completeness : null;
  return {
    state: 'ready',
    identity,
    completeness,
    towns: !canRead ? withheld : mapLoadable(extras, townsOf),
    trust: !canRead ? withheld : mapLoadable(extras, (e) => outlineTrust(e, timeZone)),
    asks,
    // Each read says itself when it stopped short (`more`): no cap mirrored here.
    asksMore: landmarkAsks?.more === true || placeNames?.more === true || bayAsks?.more === true,
    history,
    attention: attentionTabs(done?.missing ?? []),
    bbox: polygonBBox(body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon),
    scene,
    mapFailures,
    lastCampaign: body.lastCampaignId ?? null,
    canSetBoost: can('body.identity'),
  };
}

/** The towns from the extras: not computed yet until the body's geometry is; empty is no town. */
function townsOf(e: {
  towns: readonly string[] | null;
  townsWithState?: readonly { name: string; state: string | null }[] | null;
  geoComputedAt: number | null;
}): readonly string[] | typeof NOT_COMPUTED {
  if (e.geoComputedAt === null || e.towns === null) return NOT_COMPUTED;
  // Each town with its own state, as the boundaries store it ("Franklin, VT" and "Franklin, NH" are
  // two) — never a state inferred from the body's; a town whose state isn't stored reads bare.
  if (e.townsWithState != null) {
    return e.townsWithState.map((t) => (t.state === null ? t.name : `${t.name}, ${t.state}`));
  }
  return e.towns;
}
