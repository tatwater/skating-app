/**
 * **What a body merge would move, and whether it fits one transaction** (B01-5d, fork 3 ruled (A)).
 *
 * A merge stays atomic: `mergeBodyInto` re-points every child of the loser in one transaction, so a
 * merge never strands half a body. The price is a ceiling. This module is **the one function** that
 * says where it is — {@link mergeLoadOf} — read by the Shape tab's preview (`bodyConsole.mergePreview`)
 * and asked by the write (`waterBodies.merge`, `inboxWrites.mergeDrawn`) before it writes, so the
 * preview's *too big* and the write's refusal are one answer, never two estimates.
 *
 * **How it reads.** Each kind of row the merge touches is streamed from its index, one document at a
 * time, and each document's real size is added to a running cost ({@link MergeCost}): what the merge
 * then reads, writes and queries for that row (its re-point, its Inbox re-key, its bay join, its
 * snapshot). The moment the projected cost passes Convex's own limits the read stops and the merge is
 * *too big*, so the check itself never reads more than a fraction of a transaction, however heavy the
 * loser. Counts read after a stop are floors (`capped`).
 *
 * **The asks' cap.** A merge re-targets at most `RETARGET_CAP` (1,000) asks of one kind and status;
 * past that a group would stay behind on the loser, unrecorded (fork 3). This check refuses long
 * before: an ask's re-key costs its Inbox reconcile, so a few hundred asks already pass the queries
 * a transaction allows. The merge itself refuses a group past the cap with the same sentence
 * (`retargetAsks`' `refuse`), the guard for the ETL's merges, which don't ask this.
 *
 * The ETL's batch merges (`retireAbsorbedBodies`) don't ask this: several share a transaction, and
 * each absorbed duplicate is a bare catalog row. Their one guard is the asks' cap, inside the merge.
 */

import { MAX_LANDMARKS_PER_BODY, REQUEST_KINDS, REQUEST_STATUSES } from '@skating/core';
import { getDocumentSize } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { OPEN_FLAG_STATUSES } from './openFlags';

/** The one sentence a merge too heavy for one transaction is refused with, preview and write alike. */
export const MERGE_TOO_BIG =
  'Too much moves for one merge here. Merge it from the duplicates queue in parts, or ask an admin.';

/**
 * The most rows of one kind a merge moves (B01-5d): under Convex's 8,192-item array limit, so no list a
 * merge holds or records of one kind can reach it. Rows that cost no index range of their own (a
 * launch, a skate) could otherwise pass the transaction's other limits in their thousands.
 */
export const MERGE_ROWS_PER_KIND = 8_000;

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

/** One transaction's spend, on the axes Convex limits. */
export type MergeCost = {
  bytesRead: number;
  bytesWritten: number;
  documentsRead: number;
  documentsWritten: number;
  databaseQueries: number;
};

const MiB = 1 << 20;

/** Convex's per-transaction limits (`docs.convex.dev/production/state/limits`), as the harness holds them. */
export const TX_LIMITS: MergeCost = {
  bytesRead: 16 * MiB,
  bytesWritten: 16 * MiB,
  documentsRead: 32_000,
  documentsWritten: 16_000,
  databaseQueries: 4_096,
};

/**
 * What a merge spends whatever it moves: both bodies read several times over (the caller's reads,
 * the lists' union, each patch writing a body back whole — an outline can weigh close to the document
 * limit), their cells, summaries, name rows, library rows and facts, the audit row, the Inbox's own
 * refresh, and room for what this model doesn't itemize. Generous on purpose: a merge it lets through
 * must complete.
 */
export const MERGE_FIXED: MergeCost = {
  bytesRead: 8 * MiB,
  bytesWritten: 6 * MiB,
  documentsRead: 2_000,
  documentsWritten: 600,
  databaseQueries: 800,
};

/**
 * Each moved row's spend beyond its own bytes: reads past the first (the check's, the merge's), its
 * write, and the queries and small rows its helpers touch — a report's bay joins, an ask's or a flag's
 * Inbox re-key (`RECONCILE_COST`, and a flag's look for its flagger's flag on the survivor), a
 * favorite's twin lookup, a bay's re-clip and cells, a landmark's fold and its audit row.
 */
type PerRow = {
  /** Times the row is read whole (the check's read included). */
  reads: number;
  /** Times it is written whole (its patch; a bay's or a landmark's snapshot too). */
  writes: number;
  /** Small rows it reads beyond itself (a get counts as a query too — Convex's database calls). */
  documentsRead: number;
  /** Documents it writes: its own patch, and its helpers' rows (an Inbox re-key, cells, audit rows). */
  documentsWritten: number;
  databaseQueries: number;
};
/** A row the merge reads, re-points with one patch, and lists in its change set by id. */
const ROW: PerRow = {
  reads: 2,
  writes: 1,
  documentsRead: 0,
  documentsWritten: 1,
  databaseQueries: 0,
};
/** A bay or a label: read again for the snapshot and the change set's after-look, snapshotted whole. */
const SHAPE: PerRow = {
  reads: 4,
  writes: 2,
  documentsRead: 0,
  documentsWritten: 1,
  databaseQueries: 2,
};
const PER_ROW: Record<MergeMoveKind | 'survivorSubAreas' | 'survivorLandmarks', PerRow> = {
  reports: { ...ROW, documentsRead: 4, documentsWritten: 4, databaseQueries: 2 },
  hazards: ROW,
  bounties: ROW,
  bodyFeatures: ROW,
  putIns: ROW,
  favorites: { ...ROW, documentsRead: 1, databaseQueries: 1 },
  requests: { ...ROW, reads: 3, documentsRead: 10, documentsWritten: 5, databaseQueries: 9 },
  placeNames: ROW,
  flags: { ...ROW, reads: 3, documentsRead: 12, documentsWritten: 5, databaseQueries: 11 },
  // A moved bay: re-pointed, maybe re-clipped or delisted (its cells, an audit row).
  subAreas: { ...SHAPE, writes: 3, documentsRead: 12, documentsWritten: 12, databaseQueries: 8 },
  // A moved label: re-pointed, maybe folded into a twin or retired (the twin's patch, an audit row).
  landmarks: { ...SHAPE, writes: 3, documentsRead: 4, documentsWritten: 4, databaseQueries: 5 },
  gpsActivities: ROW,
  // The survivor's own bays are all re-clipped (most unchanged: their cells re-synced).
  survivorSubAreas: { ...SHAPE, documentsRead: 8, documentsWritten: 8, databaseQueries: 6 },
  // The survivor's labels are read and matched in memory; few change (a fold's twin, a retirement).
  survivorLandmarks: { ...SHAPE, writes: 1, documentsWritten: 0, databaseQueries: 1 },
};

/** What {@link mergeLoadOf} found: each kind's count, and whether the merge fits one transaction. */
export type MergeLoad = {
  moves: Record<MergeMoveKind, MergeCount>;
  /** The projected spend, at the point the read stopped. */
  cost: MergeCost;
  /** Past one transaction's budget: the merge is refused. */
  tooBig: boolean;
};

/** Whether `cost` stays inside every one of Convex's limits. */
export function fitsOneTransaction(cost: MergeCost): boolean {
  return (Object.keys(TX_LIMITS) as (keyof MergeCost)[]).every((k) => cost[k] <= TX_LIMITS[k]);
}

/** One row's spend added to `cost`. */
function charge(cost: MergeCost, per: PerRow, bytes: number): void {
  cost.bytesRead += per.reads * bytes;
  cost.bytesWritten += per.writes * bytes;
  cost.documentsRead += per.reads + per.documentsRead;
  cost.documentsWritten += per.documentsWritten;
  cost.databaseQueries += per.databaseQueries;
}

/**
 * **The one answer for "what would merging `loser` into `survivor` move, and does it fit"** — see the
 * module doc. Bounded by construction: it stops reading as soon as the projected spend passes a limit,
 * so its own reads stay a fraction of one transaction's. A query or a mutation may ask it.
 */
export async function mergeLoadOf(
  ctx: QueryCtx,
  loser: Pick<Doc<'waterBodies'>, '_id'>,
  survivor: Pick<Doc<'waterBodies'>, '_id'>,
): Promise<MergeLoad> {
  const loserId = loser._id;
  const survivorId = survivor._id;
  const cost: MergeCost = { ...MERGE_FIXED };
  const moves = Object.fromEntries(
    MERGE_MOVE_KINDS.map((k) => [k, { count: 0, capped: false }]),
  ) as Record<MergeMoveKind, MergeCount>;
  let stopped = false;

  /**
   * Stream `rows` into `kind`'s count, charging each. Returns false once the merge is too big (every
   * later kind's count is then a floor of 0, marked capped).
   */
  const tally = async (
    kind: MergeMoveKind | 'survivorSubAreas' | 'survivorLandmarks',
    rows: AsyncIterable<{ _id: string }>,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<boolean> => {
    const into = kind === 'survivorSubAreas' || kind === 'survivorLandmarks' ? null : moves[kind];
    if (stopped) {
      if (into) into.capped = true;
      return false;
    }
    let inGroup = 0;
    for await (const row of rows) {
      // Past the merge's own read of this range: rows it never touches.
      if (inGroup >= limit) break;
      inGroup++;
      charge(cost, PER_ROW[kind], getDocumentSize(row as never));
      if (into) into.count++;
      if (!fitsOneTransaction(cost) || (into !== null && into.count > MERGE_ROWS_PER_KIND)) {
        stopped = true;
        if (into) into.capped = true;
        return false;
      }
    }
    return true;
  };

  const db = ctx.db;
  // The asks first: their re-keys are the merge's most expensive rows.
  for (const kind of REQUEST_KINDS) {
    for (const status of REQUEST_STATUSES) {
      await tally(
        'requests',
        db
          .query('waterBodyRequests')
          .withIndex('by_water_body', (q) =>
            q.eq('waterBodyId', loserId).eq('kind', kind).eq('status', status),
          ),
      );
    }
  }
  await tally(
    'placeNames',
    db
      .query('corpusPlaceNames')
      .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', loserId).eq('status', 'open')),
  );
  for (const status of OPEN_FLAG_STATUSES) {
    await tally(
      'flags',
      db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q.eq('targetType', 'waterbody').eq('targetId', loserId).eq('status', status),
        ),
    );
  }
  await tally(
    'reports',
    db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'hazards',
    db.query('hazards').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'bounties',
    db.query('bounties').withIndex('by_water_body_status', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'bodyFeatures',
    db.query('bodyFeatures').withIndex('by_water_body_active', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'putIns',
    db.query('putIns').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'favorites',
    db.query('waterBodyFavorites').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'gpsActivities',
    db.query('gpsActivities').withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'subAreas',
    db.query('waterBodySubAreas').withIndex('by_parent', (q) => q.eq('waterBodyId', loserId)),
  );
  await tally(
    'survivorSubAreas',
    db.query('waterBodySubAreas').withIndex('by_parent', (q) => q.eq('waterBodyId', survivorId)),
  );
  // Both lakes' labels, live and removed, as the merge reads them (`landmarksForBody`): each range
  // to the cap it reads.
  for (const [kind, id] of [
    ['landmarks', loserId],
    ['survivorLandmarks', survivorId],
  ] as const) {
    await tally(
      kind,
      db
        .query('bodyLandmarks')
        .withIndex('by_water_body_removed', (q) =>
          q.eq('waterBodyId', id).eq('removedAt', undefined),
        ),
      MAX_LANDMARKS_PER_BODY,
    );
    await tally(
      kind,
      db
        .query('bodyLandmarks')
        .withIndex('by_water_body_removed', (q) => q.eq('waterBodyId', id).gt('removedAt', 0))
        .order('desc'),
      MAX_LANDMARKS_PER_BODY,
    );
  }
  return { moves, cost, tooBig: stopped };
}

/** A merge's survivor and loser as the check and the write both name them. */
export type MergePair = { loserId: Id<'waterBodies'>; survivorId: Id<'waterBodies'> };
