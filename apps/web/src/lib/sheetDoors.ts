/**
 * The doors onto the console (A10-5 / §10.1) as the route's search params: a lake (`?body=`), a
 * published Report to edit (`?edit=`), or nothing (a blank Post, the lake picked in the console).
 *
 * Web has fewer doors than the phone and that is the right answer, not a gap: there is no GPS fix
 * worth trusting at a desk, no local recording, and no draft queue (§10.3). What web has instead
 * is the **restore** — a reload lands back on the Post that was being written.
 *
 * Every door builds the same `PostSheet` through the pure model, as mobile's `sheetDoors` does;
 * this is only where the browser's facts are read.
 */

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  openPostSheet,
  type PostSheet,
  postSheetForEdit,
  resolveShowPutInDefault,
} from '@skating/core';
import type { ConvexReactClient } from 'convex/react';

export interface WebDoorParams {
  body?: string;
  name?: string;
  edit?: string;
}

/** Ids are minted here so the pure model never has to guess one. */
const mint = () => crypto.randomUUID();

/**
 * Build the sheet for the door. `null` when a door names something that is gone — a Report that was
 * deleted, or one that is not the viewer's to edit — which the route turns into a message rather
 * than a blank console.
 */
export async function openWebDoor(
  convex: ConvexReactClient,
  params: WebDoorParams,
  showPutInDefault: boolean | undefined,
  now: number,
): Promise<PostSheet | null> {
  const showPutIn = resolveShowPutInDefault(showPutInDefault);

  if (params.edit) {
    const reportId = params.edit as Id<'reports'>;
    const report = await convex.query(api.reports.get, { reportId }).catch(() => null);
    if (!report) return null;
    const words = await convex.query(api.posts.getForReport, { reportId }).catch(() => null);
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
      mint,
    );
  }

  if (params.body) {
    let bodyName = params.name;
    if (bodyName === undefined) {
      const body = await convex
        .query(api.waterBodies.get, { waterBodyId: params.body as Id<'waterBodies'> })
        .catch(() => null);
      if (body?.available) bodyName = body.body.name;
    }
    return openPostSheet(
      'body',
      { waterBodyId: params.body, ...(bodyName !== undefined ? { bodyName } : {}), showPutIn },
      now,
      mint,
    );
  }

  // The blank Post: the words lead and the lake is picked in the console (§4.3's picker, web's).
  return openPostSheet('page', { showPutIn }, now, mint);
}

/** Does a restored sheet still answer this door? A `?body=` or `?edit=` the restore disagrees with wins. */
export function restoreMatchesDoor(restored: PostSheet, params: WebDoorParams): boolean {
  if (params.edit !== undefined) {
    return restored.mode.kind === 'edit' && restored.mode.reportId === params.edit;
  }
  if (restored.mode.kind === 'edit') return false;
  if (params.body === undefined) return true;
  return restored.reports.some((r) => r.sheet.waterBodyId === params.body);
}
