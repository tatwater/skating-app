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
 *   {@link BODY_NAMES_READ_MAX_BYTES}; past that the row is `capped`. Every rebuild in a transaction
 *   draws from one read allowance; one that can't finish in what is left is deferred to a
 *   transaction of its own, its row `capped` meanwhile ({@link setNamesAllowance}).
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
import { internal } from '../_generated/api';
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
 * What one body's rows may weigh for its list, by their real size: past it the row is `capped` (the
 * answer every reader gave before the row existed) — the same answer whichever path rebuilds it.
 */
export const BODY_NAMES_READ_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The bounds in force — a test seam (a test shrinks them to small rows, then puts them back):
 * - `readMaxBytes` — one body's cap, above;
 * - `txBytes` — what rebuilds may add to a transaction that hasn't said otherwise
 *   ({@link setNamesAllowance}): a single write's rebuild, and an undo's;
 * - `passBytes` — the names backfill's pass;
 * - `loadBytes` — a catalog load's batch, its own reads and its rebuilds together: under the
 *   transaction's 16 MiB read limit with room for the writes' own reads (`landmarks.importBatch`).
 */
export const NAMES_BOUNDS = {
  readMaxBytes: BODY_NAMES_READ_MAX_BYTES,
  txBytes: BODY_NAMES_READ_MAX_BYTES,
  passBytes: 2 * BODY_NAMES_READ_MAX_BYTES,
  loadBytes: 12 * 1024 * 1024,
};

/**
 * Rows a rebuild reads at a time: a landmark is small in fact; a bay carries its whole outline (a
 * document at most), so one at a time — a read stops at most a chunk past its allowance.
 */
export const READ_CHUNK = { landmarks: 16, bays: 1 } as const;

/**
 * **One read allowance per transaction** for every rebuild in it (keyed by the transaction's
 * context): {@link NAMES_BOUNDS}.`txBytes` unless the transaction sets its own — a catalog load the
 * read limit less what its own reads took ({@link drawNamesAllowance}), a body merge or a batch
 * loader none. A rebuild that can't finish in what is left is **deferred**: its body's row is made
 * `capped` now (so no reader trusts a list the writes beside it just changed) and a standalone
 * rebuild is scheduled, in a transaction of its own.
 */
const ALLOWANCES = new WeakMap<object, { bytes: number; deferred: Set<string> }>();

function allowanceOf(ctx: object) {
  let allowance = ALLOWANCES.get(ctx);
  if (allowance === undefined) {
    allowance = { bytes: NAMES_BOUNDS.txBytes, deferred: new Set() };
    ALLOWANCES.set(ctx, allowance);
  }
  return allowance;
}

/** Set what rebuilds may read in this transaction from now on (0: every rebuild deferred). */
export function setNamesAllowance(ctx: object, bytes: number): void {
  allowanceOf(ctx).bytes = bytes;
}

/** This transaction's own reads, drawn from the same allowance (a catalog load's per body). */
export function drawNamesAllowance(ctx: object, bytes: number): void {
  allowanceOf(ctx).bytes -= bytes;
}

/** What rebuilds may still read in this transaction. */
export function namesAllowanceLeft(ctx: object): number {
  return allowanceOf(ctx).bytes;
}

/**
 * A body's live landmarks or its bays, chunk by chunk: the body's cap first (`spent` past
 * `readMaxBytes` → `cap`, final), then the transaction's allowance (`drawn` past what was left →
 * `allowance`, deferred). Checked before each chunk, so a read stops at most a chunk past either.
 */
async function weighedRows<D extends { _creationTime: number }>(
  take: (after: number | null, n: number) => Promise<D[]>,
  chunk: number,
  spent: { bytes: number },
  drawn: { bytes: number; left: number },
): Promise<{ rows: D[]; stop: 'cap' | 'allowance' | null }> {
  const rows: D[] = [];
  const stopped = () =>
    spent.bytes > NAMES_BOUNDS.readMaxBytes
      ? ('cap' as const)
      : drawn.left <= 0 || drawn.bytes > drawn.left
        ? ('allowance' as const)
        : null;
  for (let after: number | null = null; ; ) {
    const stop = stopped();
    if (stop !== null) return { rows, stop };
    const page = await take(after, chunk);
    for (const row of page) {
      const size = getDocumentSize(row as never);
      spent.bytes += size;
      drawn.bytes += size;
    }
    rows.push(...page);
    if (page.length < chunk) {
      return { rows, stop: spent.bytes > NAMES_BOUNDS.readMaxBytes ? 'cap' : null };
    }
    after = (page[page.length - 1] as D)._creationTime;
  }
}

function liveLandmarks(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  spent: { bytes: number },
  drawn: { bytes: number; left: number },
  /** The rows as a dry run says they would stand, in the index's order: read in place of the table. */
  proposed?: readonly Doc<'bodyLandmarks'>[],
) {
  return weighedRows(
    (after, n) =>
      proposed !== undefined
        ? Promise.resolve(
            proposed.filter((row) => after === null || row._creationTime > after).slice(0, n),
          )
        : ctx.db
            .query('bodyLandmarks')
            .withIndex('by_water_body_removed', (q) => {
              const live = q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined);
              return after === null ? live : live.gt('_creationTime', after);
            })
            .take(n),
    READ_CHUNK.landmarks,
    spent,
    drawn,
  );
}

/** A body's bays, delisted ones included (the caller keeps the live). */
function bays(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  spent: { bytes: number },
  drawn: { bytes: number; left: number },
) {
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
    drawn,
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
 * transaction, writing only when it changed — or, when this transaction's read allowance can't cover
 * the rebuild, make the row `capped` now and schedule a standalone rebuild (`deferred`). Call it
 * beside every write of a landmark's or a bay's names, kind, point, removal or body (or once after
 * a loop), with the body id off the stored row — both bodies when a row moves.
 *
 * `bays`: the body's bays as this transaction already read them, unchanged since (a catalog load,
 * which writes no bay) — counted toward the body's cap as if read, never read again. `dryRun`: read
 * and decide, write and schedule nothing (a dry run's reads are the applied run's).
 */
export async function refreshBodyNames(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  opts: {
    bays?: readonly Doc<'waterBodySubAreas'>[];
    dryRun?: boolean;
    /**
     * A dry run's live landmarks as the load would leave them (`landmarks.landmarksAfter`), read
     * through the same chunks as the table — so it weighs, draws and defers as the applied run will.
     */
    landmarks?: readonly Doc<'bodyLandmarks'>[];
  } = {},
): Promise<{ wrote: boolean; read: number; deferred: boolean }> {
  const allowance = allowanceOf(ctx);
  const spent = { bytes: 0 };
  const drawn = { bytes: 0, left: allowance.bytes };
  const existing = await ctx.db
    .query('bodyNameLists')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  let landmarks: Awaited<ReturnType<typeof liveLandmarks>>;
  let subAreas: { rows: Doc<'waterBodySubAreas'>[]; stop: 'cap' | 'allowance' | null };
  if (opts.bays !== undefined) {
    // Already in hand: toward the body's cap, never drawn from the allowance again.
    for (const bay of opts.bays) spent.bytes += getDocumentSize(bay as never);
    subAreas = {
      rows: [...opts.bays],
      stop: spent.bytes > NAMES_BOUNDS.readMaxBytes ? 'cap' : null,
    };
    landmarks =
      subAreas.stop === null
        ? await liveLandmarks(ctx, waterBodyId, spent, drawn, opts.landmarks)
        : { rows: [], stop: 'cap' };
  } else {
    landmarks = await liveLandmarks(ctx, waterBodyId, spent, drawn, opts.landmarks);
    subAreas =
      landmarks.stop === null
        ? await bays(ctx, waterBodyId, spent, drawn)
        : { rows: [], stop: landmarks.stop };
  }
  allowance.bytes -= drawn.bytes;
  const stop = landmarks.stop ?? subAreas.stop;
  const read = drawn.bytes;
  const deferred = stop === 'allowance';
  if (opts.dryRun === true) return { wrote: false, read, deferred };
  const next =
    stop === null
      ? namesOf(landmarks.rows, subAreas.rows)
      : { capped: true, landmarks: [], bays: [] };
  if (deferred && !allowance.deferred.has(waterBodyId)) {
    allowance.deferred.add(waterBodyId);
    await ctx.scheduler.runAfter(0, internal.landmarks.rebuildBodyNames, { waterBodyId });
  }
  if (existing !== null && sameLists(existing, next)) return { wrote: false, read, deferred };
  const row = { waterBodyId, ...next, updatedAt: Date.now() };
  if (existing === null) await ctx.db.insert('bodyNameLists', row);
  else await ctx.db.replace(existing._id, row);
  return { wrote: true, read, deferred };
}

/**
 * A body's stored row as it stands, or `null` — for a reader that compares stored facts (the merge's
 * dev proof census, B01-5d); the writer and History's undo check read it through their own paths.
 */
export function bodyNamesRow(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<BodyNames | null> {
  return ctx.db
    .query('bodyNameLists')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
}

/**
 * **A gone body's row removed** (B01-5d): for a writer that deletes the body itself — the dev seed's
 * clear, taking a body the seed drew with everything on it. Never for a live body, whose row
 * `refreshBodyNames` keeps. Returns whether there was a row.
 */
export async function dropBodyNames(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<boolean> {
  const row = await bodyNamesRow(ctx, waterBodyId);
  if (row === null) return false;
  await ctx.db.delete(row._id);
  return true;
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
