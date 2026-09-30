/**
 * Landmark proposals (D202) — a skater names a spot no map has, and the name goes to a moderator.
 *
 * Filed by the report write, not by a button: a point in a report's `where` that carries a typed
 * name and no landmark id *is* the proposal — "a wind hole west of the bird poop rock" — so the
 * skater asks without a second step, and the queue sees the report that used the name. It is a
 * `name_landmark` request (D179's lane), answered on the lake editor, where adding the landmark
 * approves every ask for the same place.
 *
 * Quiet by design: a report must never fail because its proposal could not be filed. A name a live
 * landmark or bay already answers to, the same ask already open from this person, or a person past
 * their budget simply files nothing, and the report posts.
 */

import { landmarkNameKey, MAX_OPEN_LANDMARK_REQUESTS_PER_USER } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { landmarksForBody } from './landmarkRows';
import { landmarkNamesMeet, QUEUE_CAP } from './requestDecisions';

export async function fileLandmarkProposals(
  ctx: MutationCtx,
  requesterId: Id<'profiles'>,
  body: Doc<'waterBodies'>,
  reportId: Id<'reports'>,
  spots: readonly { name: string; coord: { lat: number; lng: number } }[],
  /** Every name the body's live bays answer to — the caller has the bays in hand already. */
  bayNames: readonly string[],
): Promise<number> {
  if (spots.length === 0) return 0;
  const open = await ctx.db
    .query('waterBodyRequests')
    .withIndex('by_requester_status', (q) => q.eq('requesterId', requesterId).eq('status', 'open'))
    .take(QUEUE_CAP);
  let budget =
    MAX_OPEN_LANDMARK_REQUESTS_PER_USER - open.filter((r) => r.kind === 'name_landmark').length;
  // Removed landmarks count as known: a place a moderator took down is not re-proposed by an edit
  // of an old report that named it.
  const known = [
    ...(await landmarksForBody(ctx, body._id)).map((l) => [l.name, ...l.aliases]),
    [...bayNames],
  ];
  const asked = new Set(
    open
      .filter((r) => r.kind === 'name_landmark' && r.waterBodyId === body._id)
      .map((r) => r.nameKey ?? landmarkNameKey(r.name ?? '')),
  );
  let filed = 0;
  for (const spot of spots) {
    if (budget <= 0) break;
    const key = landmarkNameKey(spot.name);
    if (!key || asked.has(key) || known.some((names) => landmarkNamesMeet([spot.name], names))) {
      continue;
    }
    await ctx.db.insert('waterBodyRequests', {
      kind: 'name_landmark',
      status: 'open',
      requesterId,
      coord: spot.coord,
      waterBodyId: body._id,
      name: spot.name,
      nameKey: key,
      reportId,
      createdAt: Date.now(),
    });
    asked.add(key);
    budget--;
    filed++;
  }
  return filed;
}
