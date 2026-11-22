/**
 * **What a body merge would move, and whether it fits one transaction** (B01-5d, fork 3 ruled (A);
 * made a bound in every dimension after the real-backend proof, R11).
 *
 * A merge stays atomic: `mergeBodyInto` re-points every child of the loser in one transaction, so a
 * merge never strands half a body. The price is a ceiling, and this module is **the one function**
 * that says where it is — {@link mergeLoadOf} — read by the Shape tab's preview
 * (`bodyConsole.mergePreview`), asked by the write (`waterBodies.merge`, `inboxWrites.mergeDrawn`)
 * before it writes, and by the ETL's absorb per pair (`retireAbsorbedBodies`). One answer, never two
 * estimates; one sentence ({@link MERGE_TOO_BIG}, code `tooBig`) whichever dimension refuses.
 *
 * **A bound, not a guess.** Each moved row is charged, per kind, what the merge's code does for it on
 * every axis the real backend limits — {@link TX_LIMITS}, Convex's documented per-transaction limits —
 * with the arithmetic written beside each kind ({@link PER_ROW}). The backend counts **every database
 * call against the index-range cap**: each range read, each read by id, and each `patch`, `replace`,
 * `insert` and `delete` (the R11 proof: 3,900 launches used 4,043 ranges — one a row, 143 fixed). A
 * merge is refused once its projected spend passes {@link SAFETY} (75 %) of any limit.
 *
 * **Execution time** (1 s, the limit no metric reports) is bounded by a proxy: the outline points the
 * merge's geometry passes through ({@link MERGE_GEOMETRY_POINTS}). Every bay is re-clipped against
 * the survivor's outline (its points and the survivor's), and the Inbox's merge first measures the
 * drawing's share of its survivor (both outlines). Measured locally, a clip costs ≈ 9 µs a point
 * (17,000 + 200 points: 162 ms; 58,000 + 50,000: 880 ms), so 30,000 points is ≈ 300 ms — under a third
 * of the limit, leaving room for an isolate up to 1.5× slower and the merge's other work.
 *
 * **How it reads.** Each kind is streamed from its index, one document at a time, charged as it comes;
 * the moment the projection passes a threshold the read stops (`capped`), so the check itself reads a
 * fraction of a transaction however heavy the loser.
 */

import { MAX_LANDMARKS_PER_BODY, REQUEST_KINDS, REQUEST_STATUSES } from '@skating/core';
import { getDocumentSize } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { OPEN_FLAG_STATUSES } from './openFlags';

/** The one sentence a merge too heavy for one transaction is refused with, preview and write alike. */
export const MERGE_TOO_BIG =
  'Too much moves for one merge here. Merge it from the duplicates queue in parts, or ask an admin.';

/** The most asks of one kind and status a merge re-targets — far past any body's asks. */
export const RETARGET_CAP = 1_000;

/** The kinds of row a merge moves, as the preview counts them. */
export const MERGE_MOVE_KINDS = [
  'reports',
  'hazards',
  'bounties',
  'bodyFeatures',
  'putIns',
  'favorites',
  'requests',
  'placeNames',
  'flags',
  'subAreas',
  'landmarks',
  'gpsActivities',
] as const;
export type MergeMoveKind = (typeof MERGE_MOVE_KINDS)[number];

/** A count read to a bound: `capped` when the read stopped first, so `count` is a floor. */
export type MergeCount = { count: number; capped: boolean };

/** One transaction's spend, on every axis Convex limits — execution time by its proxy. */
export type MergeCost = {
  bytesRead: number;
  bytesWritten: number;
  documentsRead: number;
  documentsWritten: number;
  /** Database calls: ranges, reads by id, patches, replaces, inserts, deletes. */
  databaseQueries: number;
  /** Outline points the merge's geometry passes through — execution time's proxy. */
  geometryPoints: number;
};

const MiB = 1 << 20;

/**
 * **Convex's documented per-transaction limits** (`docs.convex.dev/production/state/limits`), in one
 * place — execution time (1 s) as its point proxy ({@link MERGE_GEOMETRY_POINTS}).
 */
export const TX_LIMITS: Omit<MergeCost, 'geometryPoints'> = {
  bytesRead: 16 * MiB,
  bytesWritten: 16 * MiB,
  documentsRead: 32_000,
  documentsWritten: 16_000,
  databaseQueries: 4_096,
};

/**
 * A merge is refused past this share of any limit: the per-row arithmetic is counted from the code,
 * but the fixed part varies with what each body carries (inline library refreshes, the Inbox's batch
 * refresh, partners, pinned facts), so a quarter of every limit is kept back — every merge this lets
 * through passes with room to spare.
 */
export const SAFETY = 0.75;

/** The outline points one merge's geometry may pass through (see the module doc for the measure). */
export const MERGE_GEOMETRY_POINTS = 30_000;

/** The thresholds a merge's projection is held under. */
export const THRESHOLDS: MergeCost = {
  bytesRead: SAFETY * TX_LIMITS.bytesRead,
  bytesWritten: SAFETY * TX_LIMITS.bytesWritten,
  documentsRead: SAFETY * TX_LIMITS.documentsRead,
  documentsWritten: SAFETY * TX_LIMITS.documentsWritten,
  databaseQueries: SAFETY * TX_LIMITS.databaseQueries,
  geometryPoints: MERGE_GEOMETRY_POINTS,
};

/**
 * What a merge spends whatever it moves, beyond the two bodies' own weight ({@link bodiesCost}): the
 * audit row, its snapshot, the drawing's Inbox item and the batch refresh of the items asks join, the
 * up-to-four inline library refreshes `writeAudit` makes, both summaries, the cells, the name lists,
 * the geometry facts, the partners' flags and the scheduled jobs. Measured: 143 ranges for a bare
 * merge (R11); 400 kept for bodies with partners, pins and lists.
 */
export const MERGE_FIXED: MergeCost = {
  bytesRead: MiB,
  bytesWritten: MiB / 2,
  documentsRead: 2_000,
  documentsWritten: 600,
  databaseQueries: 400,
  geometryPoints: 0,
};

/**
 * The two bodies, read and written whole over and over: the caller's reads, the lists' union, each
 * patch a read and a write of the whole document (the survivor's lists, its stamp, its summary, its
 * cells; the loser's tombstone, summary and cells) — R11 measured a 1 MiB outline on each side at
 * 15.6 MB read, ≈ 7.4 reads a body; charged 10 reads each, and 6 writes of the survivor, 3 of the
 * loser. So two outlines of 1 MiB are refused on bytes alone.
 */
function bodiesCost(survivor: Doc<'waterBodies'>, loser: Doc<'waterBodies'>): MergeCost {
  const s = getDocumentSize(survivor as never);
  const l = getDocumentSize(loser as never);
  return {
    bytesRead: 10 * (s + l),
    bytesWritten: 6 * s + 3 * l,
    documentsRead: 20,
    documentsWritten: 9,
    databaseQueries: 20,
    geometryPoints: 0,
  };
}

/** The points of an outline (every ring, every part). */
export function outlinePoints(polygon: unknown): number {
  const g = polygon as { type?: string; coordinates?: unknown } | null | undefined;
  if (!g?.coordinates) return 0;
  const rings =
    g.type === 'MultiPolygon'
      ? (g.coordinates as number[][][][]).flat()
      : (g.coordinates as number[][][]);
  return rings.reduce((n, ring) => n + ring.length, 0);
}

/**
 * One row's spend, given the row: `reads` and `writes` multiply its own size; the rest are counts.
 * Index ranges count every call — a range read, a read by id, a patch, an insert, a delete.
 */
type PerRow = (row: Record<string, unknown>) => {
  reads: number;
  writes: number;
  documentsRead: number;
  documentsWritten: number;
  databaseQueries: number;
};

/** The two Inbox calls a ruled access flag or an ask re-keys through, as `RECONCILE_COST` measures. */
const REKEY = { documentsRead: 8, databaseQueries: 8, documentsWritten: 4 };

/**
 * **Each kind's arithmetic, from the code** (`mergeBodyInto`, `retargetAsks`, the bay and landmark
 * moves). "Read" counts are whole reads of the row (the check's stream, the merge's range, a patch's
 * read); "calls" are the index-range cap's.
 */
export const PER_ROW: Record<MergeMoveKind | 'survivorSubAreas' | 'survivorLandmarks', PerRow> = {
  // read by the check and the merge's range, patched (read + write): 3 reads, 1 write; calls: the
  // patch 1, the bay join's range 1, a patch per join row (`mirrorReportSubAreas`) — J = its bays.
  reports: (r) => {
    const joins = (r.subAreaIds as unknown[] | undefined)?.length ?? 1;
    return {
      reads: 4,
      writes: 1,
      documentsRead: 2 + joins,
      documentsWritten: 1 + joins,
      databaseQueries: 2 + joins,
    };
  },
  // check + range + patch: 3 reads, 1 write; calls: the patch 1 (R11: 3,900 launches, 3,900 + 143).
  hazards: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  bounties: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  bodyFeatures: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  putIns: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  gpsActivities: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  placeNames: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 1,
    databaseQueries: 1,
  }),
  // the twin lookup 1 + the patch or the delete 1 = 2 calls (R11: 1,800 favorites, 3,600 + 143).
  favorites: () => ({
    reads: 3,
    writes: 1,
    documentsRead: 1,
    documentsWritten: 1,
    databaseQueries: 2,
  }),
  // the patch 1 + its re-key (the reconcile's 8 calls, `RECONCILE_COST`) + the patch of its member 1:
  // 10; a landmark ask also reads its body's open asks for the same-place rule (LANDMARK_SCAN 8, twice).
  requests: (r) => {
    const place = r.kind === 'name_landmark' ? 16 : 0;
    return {
      reads: 4,
      writes: 1,
      documentsRead: 2 + REKEY.documentsRead + place,
      documentsWritten: 1 + REKEY.documentsWritten,
      databaseQueries: 2 + REKEY.databaseQueries + place,
    };
  },
  // its flagger's flag on the survivor, a point read per open status (2), the patch 1, the re-key 8:
  // 11 — linear, each a point read (the R11 fix: never a scan of the survivor's flags).
  flags: () => ({
    reads: 4,
    writes: 1,
    documentsRead: OPEN_FLAG_STATUSES.length + REKEY.documentsRead,
    documentsWritten: 1 + REKEY.documentsWritten,
    databaseQueries: OPEN_FLAG_STATUSES.length + 1 + REKEY.databaseQueries,
  }),
  // read by the check, `subAreasBefore`, the repoint's and the re-clip's reads and the change set's
  // look (5) and patched up to three times (re-point, re-derive, delist): 8 reads, 4 writes with its
  // snapshot; calls: 3 patches, its cells' range and up to 8 cell inserts/deletes, a delist's audit row
  // (insert, its target, its link's range and insert, an inline library refresh ≈ 10): 25.
  subAreas: () => ({
    reads: 8,
    writes: 4,
    documentsRead: 30,
    documentsWritten: 22,
    databaseQueries: 25,
  }),
  // the survivor's own bays: re-clipped (a re-derive and a note: 2 patches), cells (1 + 8), a
  // retirement's audit row ≈ 10: 21 calls; read by the check, the before-image read, the re-clip and
  // the change set's look, written twice and snapshotted.
  survivorSubAreas: () => ({
    reads: 7,
    writes: 3,
    documentsRead: 28,
    documentsWritten: 20,
    databaseQueries: 21,
  }),
  // a moved label: read by the check, `landmarksBefore`, the move's read, the twin's index and the
  // change set's get (5), patched (and its twin) and snapshotted: 6 reads, 3 writes; calls: its get 1,
  // 2 patches, a fold's or retirement's audit row ≈ 10: 13.
  landmarks: () => ({
    reads: 6,
    writes: 3,
    documentsRead: 14,
    documentsWritten: 6,
    databaseQueries: 13,
  }),
  // the survivor's labels: read by the check and in ranges by the move (no call each), snapshotted, a
  // get by the change set's look 1 — a retirement as a bay is the rare one, charged in the fixed part.
  survivorLandmarks: () => ({
    reads: 4,
    writes: 1,
    documentsRead: 0,
    documentsWritten: 0,
    databaseQueries: 1,
  }),
};

/** What {@link mergeLoadOf} found: each kind's count, the projection, and whether it fits. */
export type MergeLoad = {
  moves: Record<MergeMoveKind, MergeCount>;
  /** The projected spend, at the point the read stopped. */
  cost: MergeCost;
  /** Past a threshold on any axis: the merge is refused. */
  tooBig: boolean;
};

/** Whether `cost` stays under every threshold (`SAFETY` of each limit, and the geometry's points). */
export function fitsOneTransaction(cost: MergeCost): boolean {
  return (Object.keys(THRESHOLDS) as (keyof MergeCost)[]).every((k) => cost[k] <= THRESHOLDS[k]);
}

function add(cost: MergeCost, more: MergeCost): void {
  for (const k of Object.keys(cost) as (keyof MergeCost)[]) cost[k] += more[k];
}

/**
 * **The one answer for "what would merging `loser` into `survivor` move, and does it fit"** — see the
 * module doc. Bounded by construction: it stops reading as soon as the projection passes a threshold.
 * `overlap`: the caller measures the drawing's share of its survivor in this transaction too (the
 * Inbox's merge), so both outlines' points are the geometry's as well.
 */
export async function mergeLoadOf(
  ctx: QueryCtx,
  loser: Doc<'waterBodies'>,
  survivor: Doc<'waterBodies'>,
  opts: { overlap?: boolean } = {},
): Promise<MergeLoad> {
  const loserId = loser._id;
  const survivorId = survivor._id;
  const cost: MergeCost = { ...MERGE_FIXED };
  add(cost, bodiesCost(survivor, loser));
  const survivorPoints = outlinePoints(survivor.polygon);
  if (opts.overlap) cost.geometryPoints += survivorPoints + outlinePoints(loser.polygon);
  const moves = Object.fromEntries(
    MERGE_MOVE_KINDS.map((k) => [k, { count: 0, capped: false }]),
  ) as Record<MergeMoveKind, MergeCount>;
  let stopped = !fitsOneTransaction(cost);

  /** Stream `rows` into `kind`'s count, charging each; false once the merge is too big. */
  const tally = async (
    kind: MergeMoveKind | 'survivorSubAreas' | 'survivorLandmarks',
    rows: AsyncIterable<Record<string, unknown>>,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<boolean> => {
    const into = kind === 'survivorSubAreas' || kind === 'survivorLandmarks' ? null : moves[kind];
    if (stopped) {
      if (into) into.capped = true;
      return false;
    }
    let seen = 0;
    for await (const row of rows) {
      // Past the merge's own read of this range: rows it never touches.
      if (seen >= limit) break;
      seen++;
      const size = getDocumentSize(row as never);
      const per = PER_ROW[kind](row);
      add(cost, {
        bytesRead: per.reads * size,
        bytesWritten: per.writes * size,
        documentsRead: per.reads + per.documentsRead,
        documentsWritten: per.documentsWritten,
        databaseQueries: per.databaseQueries,
        // A bay — the loser's or the survivor's own — is re-clipped against the survivor's outline.
        geometryPoints:
          kind === 'subAreas' || kind === 'survivorSubAreas'
            ? outlinePoints(row.polygon) + survivorPoints
            : 0,
      });
      if (into) into.count++;
      if (!fitsOneTransaction(cost)) {
        stopped = true;
        if (into) into.capped = true;
        return false;
      }
    }
    return true;
  };

  const db = ctx.db;
  const asRows = <T>(q: AsyncIterable<T>) => q as unknown as AsyncIterable<Record<string, unknown>>;
  // The asks first: their re-keys are the merge's most expensive rows. (A group past RETARGET_CAP
  // always passes a threshold first: 1,000 asks are 10,000 calls.)
  for (const kind of REQUEST_KINDS) {
    for (const status of REQUEST_STATUSES) {
      await tally(
        'requests',
        asRows(
          db
            .query('waterBodyRequests')
            .withIndex('by_water_body', (q) =>
              q.eq('waterBodyId', loserId).eq('kind', kind).eq('status', status),
            ),
        ),
      );
    }
  }
  await tally(
    'placeNames',
    asRows(
      db
        .query('corpusPlaceNames')
        .withIndex('by_water_body_status', (q) =>
          q.eq('waterBodyId', loserId).eq('status', 'open'),
        ),
    ),
  );
  for (const status of OPEN_FLAG_STATUSES) {
    await tally(
      'flags',
      asRows(
        db
          .query('contentFlags')
          .withIndex('by_target_status_reason', (q) =>
            q.eq('targetType', 'waterbody').eq('targetId', loserId).eq('status', status),
          ),
      ),
    );
  }
  await tally(
    'reports',
    asRows(
      db
        .query('reports')
        .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'hazards',
    asRows(db.query('hazards').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))),
  );
  await tally(
    'bounties',
    asRows(
      db.query('bounties').withIndex('by_water_body_status', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'bodyFeatures',
    asRows(
      db
        .query('bodyFeatures')
        .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'putIns',
    asRows(db.query('putIns').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))),
  );
  await tally(
    'favorites',
    asRows(
      db
        .query('waterBodyFavorites')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'gpsActivities',
    asRows(
      db.query('gpsActivities').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'subAreas',
    asRows(
      db.query('waterBodySubAreas').withIndex('by_parent', (q) => q.eq('waterBodyId', loserId)),
    ),
  );
  await tally(
    'survivorSubAreas',
    asRows(
      db.query('waterBodySubAreas').withIndex('by_parent', (q) => q.eq('waterBodyId', survivorId)),
    ),
  );
  // Both lakes' labels, live and removed, as the merge reads them (`landmarksForBody`): each range
  // to the cap it reads.
  for (const [kind, id] of [
    ['landmarks', loserId],
    ['survivorLandmarks', survivorId],
  ] as const) {
    await tally(
      kind,
      asRows(
        db
          .query('bodyLandmarks')
          .withIndex('by_water_body_removed', (q) =>
            q.eq('waterBodyId', id).eq('removedAt', undefined),
          ),
      ),
      MAX_LANDMARKS_PER_BODY,
    );
    await tally(
      kind,
      asRows(
        db
          .query('bodyLandmarks')
          .withIndex('by_water_body_removed', (q) => q.eq('waterBodyId', id).gt('removedAt', 0))
          .order('desc'),
      ),
      MAX_LANDMARKS_PER_BODY,
    );
  }
  return { moves, cost, tooBig: stopped };
}
