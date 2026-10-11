/**
 * Landmark proposals (D202) — a skater names a spot no map has, and the name goes to a moderator.
 *
 * Filed by the report write, not by a button: a point in a report's `where` that carries a typed
 * name and no landmark id *is* the proposal — "a wind hole west of the bird poop rock" — so the
 * skater asks without a second step, and the queue sees the report that used the name. It is a
 * `name_landmark` request (D179's lane), answered on the lake editor, where adding the landmark
 * approves every ask for the same place.
 *
 * Quiet by design: a report must never fail because its proposal could not be filed. A place a
 * landmark already is, a name a bay answers to, the same place already asked for by this person, or
 * a person past their budget simply files nothing, and the report posts. "The same place" is a
 * name *and* a spot (`landmarkAnswersAsk`, `landmarkAsksAreSamePlace`): the Long Point across the
 * lake from a known one is still a proposal (Greptile P1 on #84).
 */

import {
  type LandmarkAsk,
  landmarkAnswersAsk,
  landmarkAsksAreSamePlace,
  landmarkNameKey,
  landmarkNamesMeet,
  MAX_OPEN_LANDMARK_REQUESTS_PER_USER,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { landmarksForBody } from './landmarkRows';
import { landmarkAskOf, QUEUE_CAP } from './requestDecisions';

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
  // of an old report that named it. A bay is known by name alone — it is the whole bay.
  const landmarks = await landmarksForBody(ctx, body._id);
  const asked: LandmarkAsk[] = open
    .filter((r) => r.kind === 'name_landmark' && r.waterBodyId === body._id)
    .map(landmarkAskOf);
  let filed = 0;
  for (const spot of spots) {
    if (budget <= 0) break;
    const key = landmarkNameKey(spot.name);
    const ask = { names: [spot.name], coord: spot.coord };
    if (
      !key ||
      landmarkNamesMeet([spot.name], bayNames) ||
      landmarks.some((l) => landmarkAnswersAsk(l, ask)) ||
      asked.some((a) => landmarkAsksAreSamePlace(a, ask))
    ) {
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
    asked.push(ask);
    budget--;
    filed++;
  }
  return filed;
}
