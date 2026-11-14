/**
 * What a read can weigh — the one place the D248 erasure and record code keeps its bound.
 *
 * A Convex transaction may read 16 MiB; one document may weigh 1 MiB. A job that continues across
 * transactions (the erasure sweep, the photo settlement, the backfills) charges **every** read it makes
 * — the rows of a page, a `get`, a `first()` existence check, and a second touch of a row it patches or
 * deletes — at the worst its table allows ({@link ROW_MAX}) against one {@link ReadBudget} per
 * transaction. A read the plan did not leave room for throws instead of running past the limit, so a
 * planning mistake fails a test rather than a deployment. A row's worst case is its capped fields in
 * UTF-8 (four bytes a character) plus room for the rest; **any uncapped string or array makes it the
 * 1 MiB document limit** — a Report's notes, a flag's note, a photo's caption, a request's polygon, a
 * hazard's or an alert's `idempotencyKey`, a put-in's name, a moderator's reason.
 *
 * Every read in the files D248 touched, its bound, its worst case and what rests on its answer, is the
 * table in `plans/phases/B01-admin-console.md` §12.8 ("B01-1b: every read, weighed").
 */
import { COMMENT_BODY_MAX_LENGTH, POST_BODY_MAX_CHARS, POST_TITLE_MAX_CHARS } from '@skating/core';

/** Convex's per-document size limit — the worst any row can weigh. */
export const DOC_MAX = 1 << 20;
/** Convex's per-transaction read limit. */
export const TX_READ_LIMIT = 16 * DOC_MAX;
/**
 * What one transaction charges itself: the limit less headroom for what no helper charges — index
 * entries, the scheduler's own rows, the audit rows it inserts.
 */
export const TX_BUDGET = 12 * DOC_MAX;
/** A row's fields other than its capped text, generously. */
const SLACK = 8 * 1024;

/** The worst case of one row, by what it is. */
export const ROW_MAX = {
  comment: COMMENT_BODY_MAX_LENGTH * 4 + SLACK,
  report: DOC_MAX,
  post: DOC_MAX,
  hazard: DOC_MAX,
  contentFlag: DOC_MAX,
  waterBodyRequest: DOC_MAX,
  accessAlert: DOC_MAX,
  // A Post's snapshot is its title and prose (both capped); a Report's carries its uncapped notes.
  postRevision: (POST_TITLE_MAX_CHARS + POST_BODY_MAX_CHARS) * 4 + SLACK,
  reportRevision: DOC_MAX,
  // The approach path is capped, the name and external id are not.
  putIn: DOC_MAX,
  photo: DOC_MAX,
  // The recorded path and the provider's payload are uncapped.
  activity: DOC_MAX,
  profile: DOC_MAX,
  // The reason a moderator types and the metadata are uncapped.
  moderationAction: DOC_MAX,
  // Geometry and a suppression reason are uncapped.
  hazardRecurrence: DOC_MAX,
  // A photo settlement owed: an erased item's photo ids, as many as its row held.
  photoSettlement: DOC_MAX,
  // Ids, literals, numbers and a coordinate — no free text.
  verdict: SLACK,
  small: SLACK,
} as const;
export type RowKind = keyof typeof ROW_MAX;

/** Thrown when a transaction reads past what it planned: a bug in the plan, never a data condition. */
export class OverBudget extends Error {}

/**
 * One transaction's read budget. `charge` before a read; a read it cannot afford throws. `rows` asks
 * how many of a kind are affordable while keeping `reserve` bytes back for what must follow.
 */
export class ReadBudget {
  constructor(private left: number = TX_BUDGET) {}

  get bytes(): number {
    return this.left;
  }

  affords(bytes: number): boolean {
    return this.left >= bytes;
  }

  /** Rows of `kind` affordable after keeping `reserve` back, each costing `perRow` (default: its weight). */
  rows(kind: RowKind, cap = Number.POSITIVE_INFINITY, reserve = 0, perRow = ROW_MAX[kind]): number {
    return Math.max(0, Math.min(cap, Math.floor((this.left - reserve) / perRow)));
  }

  charge(kind: RowKind, rows = 1): void {
    const cost = ROW_MAX[kind] * rows;
    if (cost > this.left) {
      throw new OverBudget(
        `read budget: ${rows} ${kind} row(s) past what this transaction planned`,
      );
    }
    this.left -= cost;
  }

  /** One row by id or a `first()` / `unique()`: charged whether or not it exists. */
  async one<T>(kind: RowKind, read: () => Promise<T>): Promise<T> {
    this.charge(kind);
    return read();
  }

  /** Up to `n` rows: `n` are charged, and what did not come back is returned to the budget. */
  async take<T>(kind: RowKind, n: number, read: (n: number) => Promise<T[]>): Promise<T[]> {
    if (n <= 0) return [];
    this.charge(kind, n);
    const rows = await read(n);
    this.left += (n - rows.length) * ROW_MAX[kind];
    return rows;
  }

  /** A `paginate` of up to `n` rows, charged as `take` is. `n` must be at least one. */
  async page<P extends { page: unknown[] }>(
    kind: RowKind,
    n: number,
    read: (n: number) => Promise<P>,
  ): Promise<P> {
    const size = Math.max(1, n);
    this.charge(kind, size);
    const result = await read(size);
    this.left += (size - result.page.length) * ROW_MAX[kind];
    return result;
  }

  /** A patch or delete of a row already read: charged as a second touch of it. */
  touch(kind: RowKind): void {
    this.charge(kind);
  }

  /**
   * One row's work in a continuing job's loop, held to the worst case the job declared for it — the
   * same number its page was sized by. A row that charges more than `allowance`, on whatever branch,
   * is a plan that understated a branch: it throws here, on the first row that takes that branch, in
   * any test that reaches it, rather than only when a full page of such rows overruns the budget.
   */
  async row<T>(allowance: number, work: () => Promise<T>): Promise<T> {
    if (!this.affords(allowance)) {
      throw new OverBudget(`read budget: a row's ${allowance} bytes were not left for it`);
    }
    const before = this.left;
    const result = await work();
    const spent = before - this.left;
    if (spent > allowance) {
      throw new OverBudget(
        `read budget: a row charged ${spent} bytes, past the ${allowance} its page was sized for`,
      );
    }
    return result;
  }
}

/**
 * Size a continuing job's page so a full page fits at worst: each row costs its own read plus
 * `work` (everything any branch of the loop may charge for it), with `reserve` kept back for what
 * follows the loop. At least one row — a `cap` below one (a test seam's 0) still asks for one, as
 * `page` always did — and if not even one fits the budget, that is a plan error, thrown now.
 */
export function sizePage(
  reads: ReadBudget,
  kind: RowKind,
  { cap, work = 0, reserve = 0 }: { cap: number; work?: number; reserve?: number },
): number {
  const n = reads.rows(kind, Math.max(cap, 1), reserve, ROW_MAX[kind] + work);
  if (n < 1) throw new OverBudget(`read budget: not one ${kind} row and its work fit a pass`);
  return n;
}

/**
 * Run one pass of a continuing job so that a failure is never silent: whatever it throws is logged
 * with the job's name and the position it was started at — the position a re-run resumes from, since
 * every job here is idempotent from its saved position — and rethrown, so Convex records the
 * scheduled function as failed. Positions are ids, cursors and times: no content.
 */
export async function traced<T>(
  job: string,
  position: unknown,
  pass: () => Promise<T>,
): Promise<T> {
  try {
    return await pass();
  } catch (error) {
    let at: string;
    try {
      at = JSON.stringify(position);
    } catch {
      // A position that can't be written out must not replace the failure it is reporting.
      at = String(position);
    }
    console.error(`${job}: a pass failed and its chain stopped; re-run it from ${at}`, error);
    throw error;
  }
}
