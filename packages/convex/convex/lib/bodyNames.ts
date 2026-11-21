/**
 * **A body's short list of its place names** (B01-3u, D282) — one `bodyNameLists` row per body: each
 * live landmark's id, kind, point and names, and each live bay's id and names. It exists so a list of
 * changes (History) can check the landmark undo's whole rule — a landmark already there under the old
 * names, or a bay that answers to one (`landmarkRows.landmarkEditRefusal`) — where that rule would
 * otherwise read the body's whole landmark list and every bay's outline per line.
 *
 * - **One writer, rebuilt whole** ({@link refreshBodyNames}): every function that writes a landmark's
 *   or a bay's names, kind, point, removal or body calls it beside its write (or once after its
 *   loop), with the body id read off the stored row (`packages/guards`' `bodyNameWriters.test.ts`
 *   holds the list). A rebuild reads the body's live landmarks and its bays by real size, to
 *   {@link BODY_NAMES_READ_MAX_BYTES}; past that the row is `capped`.
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
import { type LandmarkKind, landmarkNameKey, landmarksAreSamePlace } from '@skating/core';
import { getDocumentSize } from 'convex/values';
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
 * What one rebuild may read of a body's rows, by their real size: past it the row is `capped` (the
 * answer every reader gave before the row existed), so a rebuild — a writer's or the backfill's —
 * never reads a giant's every bay outline and landmark in one transaction. The rows come in chunks,
 * so a rebuild reads at most this plus one chunk ({@link READ_CHUNK}).
 */
export const BODY_NAMES_READ_MAX_BYTES = 4 * 1024 * 1024;

/** The bounds in force — a test seam (a test shrinks them to small rows, then puts them back). */
export const NAMES_BOUNDS = { readMaxBytes: BODY_NAMES_READ_MAX_BYTES, passBytes: 4 * 1024 * 1024 };

/** Rows a rebuild reads at a time: a landmark is small in fact; a bay carries its whole outline. */
export const READ_CHUNK = { landmarks: 64, bays: 4 } as const;

/** A body's live landmarks or its bays, chunk by chunk while the read stays under the bound. */
async function weighedRows<D extends { _creationTime: number }>(
  take: (after: number | null, n: number) => Promise<D[]>,
  chunk: number,
  spent: { bytes: number },
): Promise<{ rows: D[]; over: boolean }> {
  const rows: D[] = [];
  for (let after: number | null = null; ; ) {
    if (spent.bytes > NAMES_BOUNDS.readMaxBytes) return { rows, over: true };
    const page = await take(after, chunk);
    for (const row of page) spent.bytes += getDocumentSize(row as never);
    rows.push(...page);
    if (page.length < chunk) {
      return { rows, over: spent.bytes > NAMES_BOUNDS.readMaxBytes };
    }
    after = (page[page.length - 1] as D)._creationTime;
  }
}

function liveLandmarks(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>, spent: { bytes: number }) {
  return weighedRows(
    (after, n) =>
      ctx.db
        .query('bodyLandmarks')
        .withIndex('by_water_body_removed', (q) => {
          const live = q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined);
          return after === null ? live : live.gt('_creationTime', after);
        })
        .take(n),
    READ_CHUNK.landmarks,
    spent,
  );
}

/** A body's bays, delisted ones included (the caller keeps the live). */
function bays(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>, spent: { bytes: number }) {
  return weighedRows(
    (after, n) =>
      ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => {
          const parent = q.eq('waterBodyId', waterBodyId);
          return after === null ? parent : parent.gt('_creationTime', after);
        })
        .take(n),
    READ_CHUNK.bays,
    spent,
  );
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
 * transaction, writing only when it changed. Says whether it wrote, and how many bytes of rows it
 * read (the backfill sizes its passes by it) — at most {@link BODY_NAMES_READ_MAX_BYTES} and a chunk. Call it beside every write of a landmark's or a bay's names,
 * kind, point, removal or body, with the body id off the stored row — both bodies when a row moves.
 */
export async function refreshBodyNames(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ wrote: boolean; read: number }> {
  const spent = { bytes: 0 };
  const existing = await ctx.db
    .query('bodyNameLists')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  // One after the other, so the bound is the read's whole: the landmarks, then the bays with what
  // the landmarks left. Past it, `capped`.
  const landmarks = await liveLandmarks(ctx, waterBodyId, spent);
  const subAreas = landmarks.over ? { rows: [], over: true } : await bays(ctx, waterBodyId, spent);
  const next =
    landmarks.over || subAreas.over
      ? { capped: true, landmarks: [], bays: [] }
      : namesOf(landmarks.rows, subAreas.rows);
  const read = spent.bytes;
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
