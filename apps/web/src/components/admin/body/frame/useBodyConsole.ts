import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { polygonBBox } from '@skating/core';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import { useRole } from '@/lib/useRole';

import { type BodyMapBaseInput, bodyMapBase } from '../map/bodyMapBase';
import type { BodyMapScene } from '../map/mapDescriptors';
import type { BBoxLike } from '../map/mapSurface';
import {
  attentionTabs,
  type BodyAsk,
  type BodyIdentity,
  bodyAsks,
  bodyHistory,
  bodyIdentity,
  type HistoryAction,
  type HistoryEntry,
} from './bodyModel';
import type { BodyTabKey } from './bodySearch';

/**
 * The Body console's reads — the ones the old body editor (`admin.water.$id.tsx`) already makes, so
 * nothing new is asked of the server: the body, its bays, its landmarks, its put-ins and lots, what
 * is asked of it (bay requests, the email place names, landmark proposals) and its audit history.
 * What no read serves yet — the towns a body lies in, whether it has bathymetry — is `null` (not
 * recorded), and is drawn as absent; each is a seam request.
 */

/** How many audit rows History reads (the server's own cap is the bound). */
const HISTORY_LIMIT = 50;

export type BodyConsoleData =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'unlisted' }
  | {
      state: 'ready';
      identity: BodyIdentity;
      asks: readonly BodyAsk[] | undefined;
      /** `null` when the viewer can't read the audit trail: the section isn't drawn. */
      history: { entries: readonly HistoryEntry[]; capped: boolean } | null | undefined;
      attention: ReadonlySet<BodyTabKey>;
      bbox: BBoxLike;
      scene: BodyMapScene;
      lastCampaign: string | null;
      canSetBoost: boolean;
    };

export function useBodyConsole(bodyId: string, timeZone?: string): BodyConsoleData {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const { can } = useRole();
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const landmarks = useQuery(api.landmarks.listForEditor, { waterBodyId });
  const putIns = useQuery(api.putIns.listForBody, { waterBodyId });
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const bayAsks = useQuery(api.corpusRequests.openBayRequestsForBody, { waterBodyId });
  const placeNames = useQuery(api.corpusPlaceNames.openForBody, { waterBodyId });
  const landmarkAsks = useQuery(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId });
  const actions = useQuery(
    api.moderation.listActions,
    can('audit.read')
      ? { targetType: 'waterbody', targetId: bodyId, limit: HISTORY_LIMIT }
      : 'skip',
  );

  const body = result?.available ? result.body : null;
  const history = (actions ?? []) as readonly HistoryAction[];

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
    };
    return bodyMapBase(input);
  }, [body, subAreas, landmarks, putIns, access]);

  if (result === undefined) return { state: 'loading' };
  if (result === null) return { state: 'missing' };
  if (!result.available || body === null || scene === null) return { state: 'unlisted' };

  const identity = bodyIdentity(body, {
    history,
    hasBathymetry: null,
    towns: null,
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  const asks =
    bayAsks === undefined || placeNames === undefined || landmarkAsks === undefined
      ? undefined
      : bodyAsks({ bays: bayAsks, placeNames, landmarks: landmarkAsks.proposals });
  const box = polygonBBox(body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon);

  return {
    state: 'ready',
    identity,
    asks,
    history: !can('audit.read')
      ? null
      : actions === undefined
        ? undefined
        : { entries: bodyHistory(history), capped: history.length >= HISTORY_LIMIT },
    attention: attentionTabs(identity.completeness),
    bbox: box,
    scene,
    lastCampaign: body.lastCampaignId ?? null,
    canSetBoost: can('body.identity'),
  };
}
