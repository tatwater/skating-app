/**
 * The doors onto the sheet (A10 §4.2 / D187) as the tab's params: a body (`?body=`), a finished
 * recording (`?track=`), an unreported skate (`?activity=`), a saved draft (`?draft=`), a
 * published Report to edit (`?edit=`), or nothing (the tab: your location's lake, else the
 * picker). Each builds the same `PostSheet` through the pure model; this is where the device's
 * facts — the GPS fix, the queued track, the cached lake — are read. Native glue, untested;
 * the model it feeds is.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { resolveShowPutInDefault, snapPutIn, trackStats } from '@skating/core';
import { randomUUID } from 'expo-crypto';
import * as Location from 'expo-location';
import { resolveCachedBody } from './bodyCache';
import { convex } from './convex';
import { getDraft, getTrack } from './draftStore';
import { getSuggestedSkateWindow } from './dwellTracker';
import {
  openPostSheet,
  type PostSheet,
  postSheetForEdit,
  postSheetFromDraft,
  updateReport,
} from './sheetModel';

export interface DoorParams {
  body?: string;
  name?: string;
  track?: string;
  activity?: string;
  draft?: string;
  edit?: string;
  /**
   * The opening's own stamp (`doorHref` mints it): the tab keeps its last params, so the same lake's
   * *Add a report* after a Post, or *Edit report* twice on one Report, would otherwise be the door
   * that is already open and never reopen. Absent on a bare link, which is a door once.
   */
  at?: string;
}

/** A door's identity, so the tab reopens the sheet only when the door — or the opening — changes. */
export function doorKey(p: DoorParams): string {
  return [
    p.edit && `edit:${p.edit}`,
    p.draft && `draft:${p.draft}`,
    p.track && `track:${p.track}`,
    p.activity && `activity:${p.activity}`,
    p.body && `body:${p.body}`,
    p.at && `at:${p.at}`,
  ]
    .filter(Boolean)
    .join('|');
}

/** Where a door navigates: the tab, the door's params, and a fresh stamp for this opening. */
export function doorHref(params: Omit<DoorParams, 'at'>): {
  pathname: '/report';
  params: Record<string, string>;
} {
  const out: Record<string, string> = { at: String(Date.now()) };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return { pathname: '/report', params: out };
}

/**
 * Build the sheet for the door. Async because the track door snaps its start to a launch (D198)
 * and the edit door reads the published Report; the page door reads GPS. `null` when a door
 * names something that is gone (a draft deleted, a Report not the author's).
 */
export async function openDoor(
  params: DoorParams,
  showPutInDefault: boolean | undefined,
  now: number,
): Promise<PostSheet | null> {
  const showPutIn = resolveShowPutInDefault(showPutInDefault);

  if (params.edit) {
    const report = await convex.query(api.reports.get, { reportId: params.edit as Id<'reports'> });
    if (!report) return null;
    const words = await convex
      .query(api.posts.getForReport, { reportId: params.edit as Id<'reports'> })
      .catch(() => null);
    const body = await convex
      .query(api.waterBodies.get, { waterBodyId: report.waterBodyId })
      .catch(() => null);
    return postSheetForEdit(
      {
        reportId: report._id,
        waterBodyId: report.waterBodyId,
        ...(body?.available ? { bodyName: body.body.name } : {}),
        skateEndTime: report.skateEndTime,
        ...(report.skateStartTime !== undefined ? { skateStartTime: report.skateStartTime } : {}),
        ...(report.skateEndPrecision !== undefined
          ? { skateEndPrecision: report.skateEndPrecision }
          : {}),
        ...(report.observedFrom !== undefined ? { observedFrom: report.observedFrom } : {}),
        ...(report.sighting !== undefined ? { sighting: report.sighting } : {}),
        iceTypes: report.iceTypes,
        surfaceTags: report.surfaceTags,
        ...(report.skateQuality !== undefined ? { skateQuality: report.skateQuality } : {}),
        ...(report.suitability !== undefined ? { suitability: report.suitability } : {}),
        ...(report.iceThickness !== undefined ? { iceThickness: report.iceThickness } : {}),
        ...(report.snow !== undefined ? { snow: report.snow } : {}),
        ...(report.conditions !== undefined ? { conditions: report.conditions } : {}),
        ...(report.notes !== undefined ? { notes: report.notes } : {}),
        point: report.point,
        ...(report.putInId !== undefined ? { putInId: report.putInId } : {}),
        ...(report.showPutIn !== undefined ? { showPutIn: report.showPutIn } : {}),
        photoIds: report.photoIds,
        hazardIds: report.hazardIdsCreated,
      },
      words ? { postId: words.postId, title: words.title, body: words.body } : null,
      now,
      randomUUID,
    );
  }

  if (params.draft) {
    const draft = getDraft(params.draft);
    return draft ? postSheetFromDraft(draft, now) : null;
  }

  if (params.track) {
    const track = getTrack(params.track);
    const stats = track ? trackStats(track.points) : null;
    const start = track?.points[0];
    let post = openPostSheet(
      'track',
      {
        ...(params.body !== undefined ? { waterBodyId: params.body } : {}),
        ...(params.name !== undefined ? { bodyName: params.name } : {}),
        trackDraftId: params.track,
        showPutIn,
        ...(stats?.endTime !== null && stats?.endTime !== undefined
          ? {
              gpsWindow: {
                endMs: stats.endTime,
                ...(stats.startTime !== null ? { startMs: stats.startTime } : {}),
              },
            }
          : {}),
      },
      now,
      randomUUID,
    );
    // The start snaps to a known launch inside the radius, else the sheet asks (D198).
    if (start && params.body) {
      const snapped = await snapStart(params.body, { lat: start.lat, lng: start.lng });
      const first = post.reports[0];
      if (first) {
        post = updateReport(post, first.id, (r) => ({
          ...r,
          sheet: {
            ...r.sheet,
            scalars: {
              ...r.sheet.scalars,
              point: { lat: start.lat, lng: start.lng },
              ...(snapped !== null ? { putInId: snapped } : {}),
            },
          },
        }));
      }
      post = { ...post, dirty: false };
    }
    return post;
  }

  if (params.activity) {
    const mine = await convex.query(api.gpsActivities.listMine, {}).catch(() => []);
    const activity = mine.find((a) => a.activityId === params.activity);
    const path = activity?.path?.type === 'LineString' ? activity.path.coordinates : undefined;
    const start = path?.[0];
    let post = openPostSheet(
      'activity',
      {
        ...(params.body !== undefined ? { waterBodyId: params.body } : {}),
        ...(params.name !== undefined ? { bodyName: params.name } : {}),
        activityId: params.activity,
        showPutIn,
        ...(activity?.endTime !== undefined && activity.endTime !== null
          ? { gpsWindow: { endMs: activity.endTime, startMs: activity.startTime } }
          : {}),
      },
      now,
      randomUUID,
    );
    if (start && params.body) {
      const [lng, lat] = start as [number, number];
      const snapped = await snapStart(params.body, { lat, lng });
      const first = post.reports[0];
      if (first) {
        post = updateReport(post, first.id, (r) => ({
          ...r,
          sheet: {
            ...r.sheet,
            scalars: {
              ...r.sheet.scalars,
              point: { lat, lng },
              ...(snapped !== null ? { putInId: snapped } : {}),
            },
          },
        }));
      }
      post = { ...post, dirty: false };
    }
    return post;
  }

  if (params.body) {
    const post = openPostSheet(
      'body',
      {
        waterBodyId: params.body,
        ...(params.name !== undefined ? { bodyName: params.name } : {}),
        showPutIn,
      },
      now,
      randomUUID,
    );
    return withDwell(post, params.body);
  }

  // The tab itself: the lake under your feet if the cache knows it, else a body-less sheet the
  // picker fills — the coord rides along so the flush can still resolve it (D30).
  const located = await locate();
  const match = located ? resolveCachedBody(located) : null;
  const post = openPostSheet(
    'page',
    {
      ...(match ? { waterBodyId: match.waterBodyId, bodyName: match.name } : {}),
      ...(located ? { coord: located } : {}),
      showPutIn,
    },
    now,
    randomUUID,
  );
  return match ? withDwell(post, match.waterBodyId) : post;
}

/** Today's dwell on the lake (Phase 09b) as the end time — editable, never authoritative. */
function withDwell(post: PostSheet, waterBodyId: string): PostSheet {
  const suggestion = getSuggestedSkateWindow(waterBodyId);
  if (suggestion.end === undefined) return post;
  const first = post.reports[0];
  if (!first) return post;
  const start =
    suggestion.start !== undefined && suggestion.start < suggestion.end
      ? suggestion.start
      : undefined;
  const next = updateReport(post, first.id, (r) => ({
    ...r,
    sheet: {
      ...r.sheet,
      fields: {
        ...r.sheet.fields,
        endTime: {
          ...r.sheet.fields.endTime,
          chips: [
            {
              key: 'dwell',
              value: { ms: suggestion.end as number, precision: 'half_hour' },
              tier: 'solid',
            },
          ],
        },
      },
      ...(start !== undefined ? { scalars: { ...r.sheet.scalars, skateStartTime: start } } : {}),
    },
  }));
  return { ...next, dirty: false };
}

async function snapStart(
  waterBodyId: string,
  start: { lat: number; lng: number },
): Promise<string | null> {
  const access = await convex
    .query(api.accessPoints.accessForBody, { waterBodyId: waterBodyId as Id<'waterBodies'> })
    .catch(() => null);
  if (!access) return null;
  const hit = snapPutIn(
    access.putIns.map((p) => ({ id: p.id as string, coord: p.coord })),
    start,
  );
  return hit?.id ?? null;
}

async function locate(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
    const pos = last ?? (await Location.getCurrentPositionAsync({}));
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}
