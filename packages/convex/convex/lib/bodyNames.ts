/**
 * **A body's short list of its place names** (B01-3u, D282) — one `bodyNameLists` row per body: each
 * live landmark's id, kind, point and names, and each live bay's id and names. It exists so a list of
 * changes (History) can check the landmark undo's whole rule — a landmark already there under the old
 * names, or a bay that answers to one (`landmarkRows.landmarkEditRefusal`) — where that rule would
 * otherwise read the body's whole landmark list and every bay's outline per line.
 *
 * - **One writer, rebuilt whole** ({@link refreshBodyNames}): every function that writes a landmark's
 *   or a bay's names, kind, point, removal or body calls it beside its write, with the body id read
 *   off the stored row (`packages/guards`' `bodyNameWriters.test.ts` holds the list). A rebuild reads
 *   what the writes beside it already read: the body's live landmarks (`MAX_LANDMARKS_PER_BODY`) and
 *   its bays.
 * - **Bounded at the write** ({@link BODY_NAMES_MAX_BYTES}, by an estimate that never undercounts):
 *   past it the row says `capped` and holds nothing, and every reader answers as it did before the
 *   row existed — as it does for a body with no row yet (before the backfill reaches it).
 * - **What it answers** ({@link nameListRefusal}): the duplicate rule exactly (a landmark's names,
 *   kind and point are all here); the bay rule only as far as names go — a bay that answers to one
 *   of the names may or may not reach the point (`bayNaming` reads its outline), so that answer is
 *   "check it where one landmark is in view", never a guess.
 *
 * A name is a place someone might call the water by, never a claim about the ice (D3).
 */
import {
  type LandmarkKind,
  landmarkNameKey,
  landmarksAreSamePlace,
  MAX_LANDMARKS_PER_BODY,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

export type BodyNames = Doc<'bodyNameLists'>;

/**
 * What a row's lists may weigh, at most, by {@link namesBytes}' estimate — about a thousand landmarks
 * of a typical name and a spelling or two. Past it, the row is `capped`.
 */
export const BODY_NAMES_MAX_BYTES = 256 * 1024;

/** A string as stored, at most: four bytes a character and a little framing. */
const stringBytes = (s: string) => 4 * s.length + 16;
/** An entry's fixed part, at most: its id, its kind and point (a landmark), its field names. */
const LANDMARK_FIXED = 192;
const BAY_FIXED = 96;

/** The estimate the bound is held by — never below what the lists really weigh. */
export function namesBytes(
  landmarks: readonly { names: readonly string[] }[],
  bays: readonly { names: readonly string[] }[],
): number {
  let bytes = 0;
  for (const l of landmarks)
    bytes += LANDMARK_FIXED + l.names.reduce((n, s) => n + stringBytes(s), 0);
  for (const b of bays) bytes += BAY_FIXED + b.names.reduce((n, s) => n + stringBytes(s), 0);
  return bytes;
}

/**
 * A body's live landmarks, and one past the writers' cap (`MAX_LANDMARKS_PER_BODY`) — which no writer
 * leaves, but which the bound then caps rather than a list missing a name.
 */
function liveLandmarks(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  return ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined),
    )
    .take(MAX_LANDMARKS_PER_BODY + 1);
}

/** A body's bays, delisted ones included (the caller keeps the live). */
function bays(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  return ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
}

/** The lists one body's rows make — and whether they fit the bound. */
export function namesOf(
  landmarks: readonly Doc<'bodyLandmarks'>[],
  subAreas: readonly Doc<'waterBodySubAreas'>[],
): Pick<BodyNames, 'capped' | 'landmarks' | 'bays'> {
  const lists = {
    landmarks: landmarks
      .filter((row) => row.removedAt === undefined)
      .map((row) => ({
        id: row._id,
        kind: row.kind,
        point: { lat: row.point.lat, lng: row.point.lng },
        names: [row.name, ...row.aliases],
      })),
    bays: subAreas
      .filter((bay) => bay.removedAt === undefined)
      .map((bay) => ({ id: bay._id, names: [bay.name, ...(bay.aliases ?? [])] })),
  };
  // A full body's landmarks alone pass the bound (each entry is estimated at 192 bytes or more), so
  // a read past the writers' cap is capped by it too.
  if (namesBytes(lists.landmarks, lists.bays) > BODY_NAMES_MAX_BYTES) {
    return { capped: true, landmarks: [], bays: [] };
  }
  return { capped: false, ...lists };
}

/**
 * **The one writer**: rebuild a body's row from its live landmarks and bays as they stand in this
 * transaction, writing only when it changed. Says whether it wrote, and how many rows it read (the
 * backfill sizes its passes by it). Call it beside every write of a landmark's or a bay's names,
 * kind, point, removal or body, with the body id off the stored row — both bodies when a row moves.
 */
export async function refreshBodyNames(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ wrote: boolean; read: number }> {
  const [landmarks, subAreas, existing] = await Promise.all([
    liveLandmarks(ctx, waterBodyId),
    bays(ctx, waterBodyId),
    ctx.db
      .query('bodyNameLists')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first(),
  ]);
  const next = namesOf(landmarks, subAreas);
  const read = landmarks.length + subAreas.length;
  if (existing !== null && sameLists(existing, next)) {
    return { wrote: false, read };
  }
  const row = { waterBodyId, ...next, updatedAt: Date.now() };
  if (existing === null) await ctx.db.insert('bodyNameLists', row);
  else await ctx.db.replace(existing._id, row);
  return { wrote: true, read };
}

/** Whether a stored row already holds these lists (a stored object's keys come back in their own order). */
function sameLists(a: Pick<BodyNames, 'capped' | 'landmarks' | 'bays'>, b: typeof a): boolean {
  const names = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((n, i) => n === y[i]);
  return (
    a.capped === b.capped &&
    a.landmarks.length === b.landmarks.length &&
    a.bays.length === b.bays.length &&
    a.landmarks.every((l, i) => {
      const m = b.landmarks[i] as (typeof b.landmarks)[number];
      return (
        l.id === m.id &&
        l.kind === m.kind &&
        l.point.lat === m.point.lat &&
        l.point.lng === m.point.lng &&
        names(l.names, m.names)
      );
    }) &&
    a.bays.every((bay, i) => {
      const other = b.bays[i] as (typeof b.bays)[number];
      return bay.id === other.id && names(bay.names, other.names);
    })
  );
}

/** Why the list says a check can't be made from it: a bay answers to one of the names. */
export const NAMES_NEED_THE_BAY = 'bay';

/**
 * The landmark edit's rule (`landmarkEditRefusal`) as far as a body's short list can answer it: the
 * duplicate's refusal, word for word (the same rule, `landmarksAreSamePlace`, over the same fields);
 * {@link NAMES_NEED_THE_BAY} when a live bay answers to one of the names (its outline decides, and
 * the list holds none); `null` when neither can refuse. A capped list answers nothing (`undefined`).
 */
export function nameListRefusal(
  list: Pick<BodyNames, 'capped' | 'landmarks' | 'bays'>,
  candidate: {
    kind: LandmarkKind;
    point: { lat: number; lng: number };
    name: string;
    aliases: readonly string[];
  },
  exceptId: Id<'bodyLandmarks'>,
): string | null | undefined {
  if (list.capped) return undefined;
  const identity = {
    kind: candidate.kind,
    point: candidate.point,
    names: [candidate.name, ...candidate.aliases],
  };
  const clash = list.landmarks.find(
    (entry) =>
      entry.id !== exceptId &&
      landmarksAreSamePlace({ kind: entry.kind, point: entry.point, names: entry.names }, identity),
  );
  if (clash) return `"${clash.names[0]}" is already a landmark here`;
  const keys = new Set(identity.names.map(landmarkNameKey));
  if (list.bays.some((bay) => bay.names.some((n) => keys.has(landmarkNameKey(n))))) {
    return NAMES_NEED_THE_BAY;
  }
  return null;
}
