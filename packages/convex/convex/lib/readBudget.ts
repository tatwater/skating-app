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
 * 1 MiB document limit** — a request's polygon, a hazard's `idempotencyKey`, a put-in's name, a
 * moderator's reason. A Report's notes are capped now, but a Report stays at the limit for its other
 * fields.
 *
 * Every read in the files D248 touched, its bound, its worst case and what rests on its answer, is the
 * table in `plans/phases/B01-admin-console.md` §12.8 ("B01-1b: every read, weighed").
 */
import {
  ACCESS_ALERT_NOTE_MAX_CHARS,
  COMMENT_BODY_MAX_LENGTH,
  FLAG_NOTE_MAX_CHARS,
  IDEMPOTENCY_KEY_MAX_CHARS,
  PHOTO_CAPTION_MAX_CHARS,
  POST_BODY_MAX_CHARS,
  POST_TITLE_MAX_CHARS,
} from '@skating/core';
import { ConvexError, getDocumentSize } from 'convex/values';

/** Convex's per-document size limit — the worst any row can weigh. */
export const DOC_MAX = 1 << 20;
/** Convex's per-transaction read limit. */
export const TX_READ_LIMIT = 16 * DOC_MAX;
/**
 * What one transaction charges itself: the limit less headroom for what no helper charges — index
 * entries, the scheduler's own rows, the audit rows it inserts.
 */
export const TX_BUDGET = 12 * DOC_MAX;
/**
 * Calls and documents one transaction lets itself make — Convex's limits (4,096 database calls,
 * 32,000 documents scanned) less headroom for what no helper charges: the caller's own profile, an
 * index's own entries, a writer's reads.
 */
export const TX_CALLS = 3_500;
export const TX_DOCS = 28_000;
/** A row's fields other than its capped text, generously. */
const SLACK = 8 * 1024;

/** The worst case of one row, by what it is. */
export const ROW_MAX = {
  comment: COMMENT_BODY_MAX_LENGTH * 4 + SLACK,
  report: DOC_MAX,
  post: DOC_MAX,
  hazard: DOC_MAX,
  // A flag's one free text is its note, capped at every writer (a person's and the automatic one);
  // its target id resolves to a real row and its error class is a class name.
  contentFlag: FLAG_NOTE_MAX_CHARS * 4 + SLACK,
  waterBodyRequest: DOC_MAX,
  // An alert's note is cut at the write and its retry key capped; the rest are ids and literals.
  accessAlert: (ACCESS_ALERT_NOTE_MAX_CHARS + IDEMPOTENCY_KEY_MAX_CHARS) * 4 + SLACK,
  // A Post's snapshot is its title and prose (both capped); a Report's carries its uncapped notes.
  postRevision: (POST_TITLE_MAX_CHARS + POST_BODY_MAX_CHARS) * 4 + SLACK,
  reportRevision: DOC_MAX,
  // The approach path is capped, the name and external id are not.
  putIn: DOC_MAX,
  // Its caption is capped at the write; the rest are storage ids, a coordinate and numbers.
  photo: PHOTO_CAPTION_MAX_CHARS * 4 + SLACK,
  // The recorded path and the provider's payload are uncapped.
  activity: DOC_MAX,
  profile: DOC_MAX,
  // The reason a moderator types and the metadata are uncapped.
  moderationAction: DOC_MAX,
  // Geometry and a suppression reason are uncapped.
  hazardRecurrence: DOC_MAX,
  // A body's outline is uncapped (D258: the rollover's page is sized by it).
  waterBody: DOC_MAX,
  // A photo settlement owed: at most `SETTLE_CHUNK_IDS` photo ids (an erased item's list is written in
  // chunks of that many), about 40 bytes each.
  photoSettlement: 64 * 1024,
  // An uploader's place in the settlement queue: its position, and at most `SETTLE_CHUNK_IDS` photo ids
  // and a handful of debt ids taken on.
  settleQueue: 64 * 1024,
  // A support ticket: its body is capped at 5,000 characters (`support.create`); the rest is short.
  supportTicket: 5_000 * 4 + SLACK,
  // A People row: names, a handle, an avatar URL, a reason line cut to 280 characters.
  personRow: 4 * 1024,
  // A landmark's name and spellings, and a known feature's other fields, no writer caps.
  landmark: DOC_MAX,
  bodyFeature: DOC_MAX,
  // A Bodies library row carries the body's name, which no writer caps.
  bodyLibraryRow: DOC_MAX,
  // Ids, literals, numbers and a coordinate — no free text.
  verdict: SLACK,
  small: SLACK,
  // A bounty-create attempt: ids, a decision, a few numbers and a trust class — no free text.
  gateEvent: 2 * 1024,
  // A console presence row: a staffer's id and an instant.
  presence: 1024,
} as const;
export type RowKind = keyof typeof ROW_MAX;

/** Thrown when a transaction reads past what it planned: a bug in the plan, never a data condition. */
export class OverBudget extends Error {}

/**
 * One transaction's read budget. `charge` before a read; a read it cannot afford throws. `rows` asks
 * how many of a kind are affordable while keeping `reserve` bytes back for what must follow.
 */
export class ReadBudget {
  /** Database calls (each `get`, `first`, `take`, `paginate`) and documents this budget still allows. */
  private callsLeft = TX_CALLS;
  private docsLeft = TX_DOCS;

  constructor(private left: number = TX_BUDGET) {}

  get bytes(): number {
    return this.left;
  }

  affords(bytes: number): boolean {
    return this.left >= bytes;
  }

  /**
   * Whether `rows` more of `kind`, in one call, fit every axis the transaction is limited on: bytes
   * at their worst, the number of calls, the number of documents. A read loop asks this before each
   * read and stops — returning what it has, marked capped — rather than throw.
   */
  affordsRead(kind: RowKind, rows = 1): boolean {
    return this.left >= ROW_MAX[kind] * rows && this.callsLeft >= 1 && this.docsLeft >= rows;
  }

  /** One call reading up to `rows` documents: counted, and refused past either limit. */
  private call(rows: number): void {
    if (this.callsLeft < 1 || this.docsLeft < rows) {
      throw new OverBudget(
        'read budget: a call past the calls or documents this transaction planned',
      );
    }
    this.callsLeft -= 1;
    this.docsLeft -= rows;
  }

  /**
   * Rows of `kind` affordable in one call after keeping `reserve` back, each costing `perRow` (default:
   * its weight) — and no more than the documents left, and none once the calls are spent, so a `take`
   * sized by it never trips the calls or documents limit.
   */
  rows(kind: RowKind, cap = Number.POSITIVE_INFINITY, reserve = 0, perRow = ROW_MAX[kind]): number {
    if (this.callsLeft < 1) return 0;
    return Math.max(0, Math.min(cap, this.docsLeft, Math.floor((this.left - reserve) / perRow)));
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
    this.call(1);
    return read();
  }

  /** Up to `n` rows: `n` are charged, and what did not come back is returned to the budget. */
  async take<T>(kind: RowKind, n: number, read: (n: number) => Promise<T[]>): Promise<T[]> {
    if (n <= 0) return [];
    this.charge(kind, n);
    this.call(n);
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
    this.call(size);
    const result = await read(size);
    this.left += (size - result.page.length) * ROW_MAX[kind];
    return result;
  }

  /** Bytes another transaction spent on this one's behalf (a nested call's reads fold into ours). */
  spend(bytes: number): void {
    if (bytes > this.left) {
      throw new OverBudget(`read budget: ${bytes} bytes spent past what this transaction planned`);
    }
    this.left -= bytes;
  }

  /**
   * One row read **as it really weighs**: started only when its worst case fits every axis (so the
   * read can never pass the limit), then charged its actual size — for a row whose table has no worst
   * case below the document limit (an audit row's reason is uncapped) but which really weighs little,
   * read once per item in a loop. Returns `undefined`, reading nothing, when the worst case doesn't
   * fit: the caller stops there and says its answer is capped.
   */
  async measured<T>(kind: RowKind, read: () => Promise<T>): Promise<T | undefined> {
    if (!this.affordsRead(kind)) return undefined;
    this.call(1);
    const row = await read();
    const size = row === null || row === undefined ? 0 : getDocumentSize(row as never);
    this.left -= Math.min(size, ROW_MAX[kind]);
    return row;
  }

  /**
   * A read under its own real-weight cap (a `paginate` with `maximumBytesRead: bytes`, at most `rows`
   * documents): charged its cap, so it fits by construction whatever its rows weigh.
   */
  async capped<T>(bytes: number, rows: number, read: () => Promise<T>): Promise<T> {
    // Convex stops a page once the cap is reached, so it may read one document past it: charged too.
    const charge = bytes + DOC_MAX;
    if (charge > this.left) throw new OverBudget('read budget: a capped read past the plan');
    this.call(rows);
    this.left -= charge;
    return read();
  }

  /**
   * A helper's read this module doesn't make itself (a shared lib's `take`): charged ahead, as one
   * call of up to `rows` of `kind`, so the helper fits by construction.
   */
  reserve(kind: RowKind, rows: number): void {
    this.charge(kind, rows);
    this.call(rows);
  }

  /** Whether `calls` more calls reading `docs` documents fit (for reads a helper on main makes). */
  affordsCalls(calls: number, docs: number): boolean {
    return this.callsLeft >= calls && this.docsLeft >= docs;
  }

  /** Calls and documents a helper on main will make, counted ahead (its bytes are its own). */
  reserveCalls(calls: number, docs: number): void {
    if (!this.affordsCalls(calls, docs)) {
      throw new OverBudget('read budget: calls or documents past the plan');
    }
    this.callsLeft -= calls;
    this.docsLeft -= docs;
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

/**
 * **One budget per request** (keyed on its context): a People query's own reads and every helper it
 * calls — the undo state's facts for someone without a row, a target's name — charge the same object,
 * so a helper that starts loading profiles once a row runs the request's budget out and stops (or
 * throws in a test) instead of passing the transaction's read limit in production.
 *
 * The first call opens it. A query that charges every read it makes opens it with
 * {@link CHARGED_QUERY_BUDGET} before any helper runs; any other request — the audit feed, a body's
 * History, the undo toast, a mutation — charges none of its own reads here, so its helpers get only
 * {@link REQUEST_PROFILE_BUDGET}, never the whole transaction's allowance on top of reads it didn't count.
 */
const REQUEST_BUDGETS = new WeakMap<object, ReadBudget>();
/** Four profiles at their worst: the unplanned reads of a request that doesn't charge its own. */
export const REQUEST_PROFILE_BUDGET = 4 * DOC_MAX;
/** A query that charges every read: the transaction's budget less the caller's own profile. */
export const CHARGED_QUERY_BUDGET = TX_BUDGET - ROW_MAX.profile;
export function requestBudget(ctx: object, opening: number = REQUEST_PROFILE_BUDGET): ReadBudget {
  let budget = REQUEST_BUDGETS.get(ctx);
  if (budget === undefined) {
    budget = new ReadBudget(opening);
    REQUEST_BUDGETS.set(ctx, budget);
  }
  return budget;
}

/** Photo ids per debt row, and so per settlement the queue carries: an erased item's list is chunked. */
export const SETTLE_CHUNK_IDS = 500;

/**
 * What kind of failure this was — its class, never its message (a message can carry content). A
 * failure that crossed a nested call arrives as a `ConvexError` carrying the class as data
 * ({@link asFailure}), since an error leaves a nested call with its class lost.
 */
export function errorClassOf(err: unknown): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data: unknown }).data;
    if (data && typeof data === 'object' && 'failed' in data) {
      return String((data as { failed: unknown }).failed);
    }
  }
  if (err instanceof Error) return err.constructor.name || 'Error';
  return 'unknown';
}

/** Rethrow a nested call's failure with its class as data, so the caller can record it. */
export function asFailure(err: unknown): Error {
  return new ConvexError({ failed: errorClassOf(err) });
}
