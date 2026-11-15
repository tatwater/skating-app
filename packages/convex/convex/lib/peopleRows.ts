/**
 * The one writer of `peopleRows`, `peopleCounts` and `peopleBackfills` (B01 §5.7).
 *
 * A People list can't page through `profiles`: a profile can weigh up to the document limit (its
 * cached drive isochrones are polygons), so a page of fifty could pass a transaction's read limit. The
 * lists read a light row per person instead — the Bodies library's pattern — and this module keeps it:
 *
 * - **Derived from the profile, nothing else** ({@link derivePersonRow}, pure). Every write that moves
 *   a fact a list shows, sorts by or narrows on calls {@link refreshPersonRow} in its own transaction:
 *   the profile's creation and renames, every discipline and role write, the deletion request, its
 *   cancel, the finalization lock and the tombstone, and the lapsed-suspension sweep. Trust points
 *   move on almost every rating, and no lane reads them, so they take the light path
 *   ({@link notePoints}). A write missed anywhere is caught by the drift repair, which re-derives the
 *   oldest-refreshed rows (`peopleJobs.repairDrift`).
 * - **Counts move with the rows.** A stored lane count changes only here, by the difference between a
 *   row's lanes before and after, in the transaction that writes the row — so every count is the tally
 *   of the rows in its lane by construction ({@link storedLanesOf} is the membership rule the list's
 *   index ranges mirror; `peopleRows.test.ts` holds the two to each other over any history).
 * - **Time-bound lanes are not stored.** *Suspended* (still running) and *Newest* (the last week)
 *   change as the clock moves, with no write; they are counted from the same index range the list
 *   reads (`lib/peopleFigures`).
 */

import { DELETION_GRACE_MS, restrictionsOf } from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { ROW_MAX, requestBudget } from './readBudget';

/** A suspension with no end, as its sort key: last in "soonest to lapse first". */
export const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

/** How much of a reason on file a list row carries: a line, not the whole text. */
export const REASON_LINE_CHARS = 280;

export type PersonRowFields = Omit<Doc<'peopleRows'>, '_id' | '_creationTime'>;

/** The stored lane counts. */
export const STORED_COUNT_KEYS = [
  'everyone',
  'admins',
  'moderators',
  'banned',
  'restricted',
  'leaving',
  'deleted',
] as const;
export type StoredCountKey = (typeof STORED_COUNT_KEYS)[number];

// ── The backfills: one registry, one state table, one reading ──────────────────────────────────

/**
 * **Every one-time job the People reads rest on, in the order they run** — the registry the
 * after-merge procedure is written from. The operator starts the first (`peopleJobs:backfillRows`);
 * each starts the next when it ends, whatever its outcome, and is ready only by a run with no
 * failures. On a database with nothing to backfill each finds nothing and is ready at once. Every job
 * takes {@link BACKFILL_ARGS}, the same arguments with the same meaning. Each pass records its state in
 * `peopleBackfills` ({@link saveBackfill}), and every answer to "is it finished?" — the operator's
 * check and every read's `pending` — is {@link readPreparation}. `packages/guards` holds the table to
 * this module.
 */
export const PEOPLE_BACKFILLS = [
  { backfill: 'rows', job: 'peopleJobs:backfillRows' },
  { backfill: 'flagSubjects', job: 'peopleJobs:backfillFlagSubjects' },
  { backfill: 'undoChains', job: 'peopleJobs:backfillUndoChains' },
] as const;

/**
 * A backfill not yet finished, as a read names it in its `pending` — the figures resting on it may be
 * wrong, not merely short (`capped`) or unrecorded (`null`).
 */
export type PeopleBackfill = (typeof PEOPLE_BACKFILLS)[number]['backfill'];

/**
 * Every backfill's arguments — one shape, one meaning, so one recovery sentence is true of all three:
 * - `cursor` — where the pass resumes, opaque. Left out, the call starts a new run from the start
 *   (its failures counted afresh); a backfill passes it to its own next pass.
 * - `alone` — this run doesn't start the backfills after it when it ends (a re-run after a fix).
 */
export const BACKFILL_ARGS = {
  cursor: v.optional(v.union(v.string(), v.null())),
  alone: v.optional(v.boolean()),
};
export interface BackfillArgs {
  cursor?: string | null;
  alone?: boolean;
}

/**
 * **The after-merge procedure, as the docs quote it word for word** — the phase doc, the roadmap's
 * Owed list and the PR body. `peopleBackfills.test.ts` runs its `convex run` commands literally, as
 * parsed out of this text (the same function names and argument objects), on an empty database and a
 * seeded one, a failure included; `packages/guards` holds the docs to this text. Change the procedure
 * here and the test and the docs follow, or fail.
 */
export const AFTER_MERGE_PROCEDURE = [
  '(1) `convex dev --once`.',
  "(2) `convex run peopleJobs:backfillRows '{}'` — it runs the three People backfills in turn (rows, flag subjects, undo chains). Estimate: unmeasured.",
  "(3) `convex run peopleJobs:preparation '{}'` until it returns `ready: true`.",
  '(4) For each job in its `rerun`: `convex run <job> \'{"alone":true}\'`, then step 3 again.',
  '(5) For each id `backfillRows` logs as an overwritten tombstone: `convex run peopleJobs:restoreTombstoneStatus \'{"userId":"<id>"}\'`.',
].join(' ');

/** A pass that hasn't written its state in this long has stopped (a pass takes seconds). */
export const BACKFILL_STALL_MS = 10 * 60_000;

/** One backfill's state, as the check reports it. */
export interface BackfillState {
  backfill: PeopleBackfill;
  job: string;
  ready: boolean;
  running: boolean;
  /** Running, but no pass has recorded anything for {@link BACKFILL_STALL_MS}: a pass threw. */
  stalled: boolean;
  cursor: string | null;
  failed: number;
  updatedAt: number | null;
}

export interface Preparation {
  /** Every backfill is ready. */
  ready: boolean;
  /** The backfills not ready, in the registry's order — what a read names in its `pending`. */
  pending: PeopleBackfill[];
  /**
   * The jobs to run again (`{"alone":true}`): not ready, not running, and not about to be started by
   * an earlier backfill whose chain is still running.
   */
  rerun: string[];
  backfills: BackfillState[];
}

/** The backfills' state: one small read (a row per backfill), the only reading there is. */
export async function readPreparation(
  ctx: QueryCtx,
  now: number = Date.now(),
): Promise<Preparation> {
  const rows = await ctx.db.query('peopleBackfills').take(PEOPLE_BACKFILLS.length + 1);
  const byName = new Map(rows.map((r) => [r.backfill as string, r]));
  let chainRunning = false;
  const rerun: string[] = [];
  const backfills = PEOPLE_BACKFILLS.map(({ backfill, job }): BackfillState => {
    const row = byName.get(backfill);
    const running = row?.running === true;
    const stalled = running && now - (row?.updatedAt ?? 0) > BACKFILL_STALL_MS;
    const ready = row?.ready === true;
    if (!ready && !(running && !stalled) && !chainRunning) rerun.push(job);
    if (running && !stalled && row?.chains === true) chainRunning = true;
    return {
      backfill,
      job,
      ready,
      running,
      stalled,
      cursor: row?.cursor ?? null,
      failed: row?.failed ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  });
  const pending = backfills.filter((b) => !b.ready).map((b) => b.backfill);
  return { ready: pending.length === 0, pending, rerun, backfills };
}

async function backfillRow(ctx: QueryCtx, backfill: PeopleBackfill) {
  return ctx.db
    .query('peopleBackfills')
    .withIndex('by_backfill', (q) => q.eq('backfill', backfill))
    .first();
}

/** The failures a pass starts from: none for a new run (no `cursor`), else what its run recorded. */
export async function backfillFailedSoFar(
  ctx: QueryCtx,
  backfill: PeopleBackfill,
  args: BackfillArgs,
): Promise<number> {
  if (args.cursor === undefined) return 0;
  return (await backfillRow(ctx, backfill))?.failed ?? 0;
}

/**
 * Record a pass: still `running` at `cursor`, or ended (`running: false`) — ready by a run with no
 * failures, and never unready again once ready.
 */
export async function saveBackfill(
  ctx: MutationCtx,
  backfill: PeopleBackfill,
  args: BackfillArgs,
  state: { running: boolean; cursor: string | null; failed: number },
): Promise<void> {
  const row = await backfillRow(ctx, backfill);
  const ended = !state.running;
  const fields = {
    ...state,
    chains: args.alone !== true,
    ready: (row?.ready ?? false) || (ended && state.failed === 0),
    updatedAt: Date.now(),
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('peopleBackfills', { backfill, ...fields });
}

/**
 * The row a profile reads as, given the row it had (`prev`, for the times a change is first seen):
 *
 * - `statusSince` and `restrictedSince` are when *this writer* saw the status change or the first
 *   restriction land — 0 (not recorded) for a row first written by the backfill, except a tombstone,
 *   which knows when it was made.
 * - A tombstone is in no lane but Deleted: not staff (a deleted admin keeps its `role`), not
 *   restricted, not leaving.
 */
export function derivePersonRow(
  profile: Doc<'profiles'>,
  prev: PersonRowFields | null,
  now: number,
): PersonRowFields {
  const deleted = profile.status === 'deleted';
  const statusChanged = prev !== null && prev.status !== profile.status;
  const statusSince = deleted
    ? (profile.deletedAt ?? (statusChanged ? now : (prev?.statusSince ?? 0)))
    : prev === null
      ? 0
      : statusChanged
        ? now
        : prev.statusSince;
  const restrictions = deleted ? [] : restrictionsOf(profile);
  const restricted = restrictions.length > 0;
  const restrictedSince = !restricted
    ? 0
    : prev === null
      ? 0
      : prev.restricted
        ? prev.restrictedSince
        : now;
  const reason =
    (profile.status === 'suspended' || profile.status === 'banned') && profile.statusReason?.trim()
      ? reasonLine(profile.statusReason.trim())
      : undefined;
  const name = profile.displayName.trim() || profile.username;
  return {
    userId: profile._id,
    displayName: profile.displayName,
    username: profile.username,
    ...(profile.profileImageUrl !== undefined ? { profileImageUrl: profile.profileImageUrl } : {}),
    nameKey: name.toLowerCase(),
    searchText: `${profile.displayName} ${profile.username}`,
    role: profile.role,
    staffRank: deleted ? 2 : profile.role === 'admin' ? 0 : profile.role === 'moderator' ? 1 : 2,
    status: profile.status,
    statusSince,
    suspendedUntil: profile.status === 'suspended' ? (profile.suspendedUntil ?? OPEN_ENDED) : 0,
    ...(reason !== undefined ? { statusReason: reason } : {}),
    restricted,
    restrictions,
    restrictedSince,
    leavingUntil:
      !deleted && profile.deletionRequestedAt !== undefined
        ? profile.deletionRequestedAt + DELETION_GRACE_MS
        : 0,
    live: !deleted,
    deletedAt: deleted ? (profile.deletedAt ?? 0) : 0,
    ledgerEditor: !deleted && profile.role === 'admin' && profile.canEditLedger === true,
    reputationPoints: profile.reputationPoints,
    createdAt: profile.createdAt,
    refreshedAt: now,
  };
}

/**
 * A reason cut to {@link REASON_LINE_CHARS} UTF-16 units, never through a surrogate pair: a cut that
 * would leave half an emoji at the end drops that half rather than store a lone surrogate.
 */
export function reasonLine(text: string): string {
  if (text.length <= REASON_LINE_CHARS) return text;
  const cut = text.slice(0, REASON_LINE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The stored lanes a row is in — the rule each lane's index range in `lib/peopleFigures` mirrors. */
export function storedLanesOf(row: PersonRowFields | null): Set<StoredCountKey> {
  const lanes = new Set<StoredCountKey>();
  if (row === null) return lanes;
  if (row.live) lanes.add('everyone');
  if (row.staffRank === 0) lanes.add('admins');
  if (row.staffRank === 1) lanes.add('moderators');
  if (row.status === 'banned') lanes.add('banned');
  if (row.restricted) lanes.add('restricted');
  if (row.leavingUntil > 0) lanes.add('leaving');
  if (row.status === 'deleted') lanes.add('deleted');
  return lanes;
}

/** Whether two rows say the same thing (the refresh stamp aside), whatever their key order. */
function sameFacts(a: PersonRowFields, b: PersonRowFields): boolean {
  // A stored row also carries its `_id` and `_creationTime`; only the derived fields compare.
  const facts = (row: PersonRowFields) =>
    JSON.stringify(
      Object.entries(row)
        .filter(([k]) => k !== 'refreshedAt' && !k.startsWith('_'))
        .sort(([x], [y]) => (x < y ? -1 : 1)),
    );
  return facts(a) === facts(b);
}

/**
 * The facts the discipline and ledger rules read of a person (`lib/peopleCan`, `lib/ledgerEditors`),
 * from their light row — where a profile can weigh a whole document. `canEditLedger` is set only for
 * an admin who holds the grant (the row's `ledgerEditor`).
 */
export function factsOfRow(
  row: Doc<'peopleRows'>,
): Pick<
  Doc<'profiles'>,
  '_id' | 'role' | 'canEditLedger' | 'status' | 'suspendedUntil' | 'deletionRequestedAt'
> {
  return {
    _id: row.userId,
    role: row.role,
    status: row.status,
    suspendedUntil:
      row.suspendedUntil > 0 && row.suspendedUntil < OPEN_ENDED ? row.suspendedUntil : undefined,
    deletionRequestedAt: row.leavingUntil > 0 ? row.leavingUntil - DELETION_GRACE_MS : undefined,
    // A read-side copy, never a grant: the grant is set only by `lib/ledgerEditors` (D227).
    ...(row.ledgerEditor ? { canEditLedger: row.ledgerEditor } : {}),
  };
}

/**
 * The request's read of who can edit the ledger (`lib/ledgerEditors`), kept here beside the one
 * writer of the rows it is read from, which forgets it whenever it writes a row — so a mutation's own
 * write is seen, and a query reads it once however many people it asks about.
 */
const LEDGER_EDITORS = new WeakMap<object, Promise<Set<string>>>();
export function rememberedLedgerEditors(ctx: object): Promise<Set<string>> | undefined {
  return LEDGER_EDITORS.get(ctx);
}
export function rememberLedgerEditors(ctx: object, read: Promise<Set<string>>): void {
  LEDGER_EDITORS.set(ctx, read);
}

const ROWLESS = new WeakMap<object, Map<string, Promise<Doc<'profiles'> | null>>>();

/**
 * The profile of someone with no People row yet (before the rows backfill), for a read that would have
 * used the row — a History line's target name, undo state's facts. Charged to the request's budget
 * (`requestBudget`) and read once a request whoever asks; `undefined` once the budget is spent, so the
 * caller says it can't tell rather than read past the limit. A mutation reads afresh.
 */
export async function rowlessProfile(
  ctx: QueryCtx | MutationCtx,
  id: Id<'profiles'>,
): Promise<Doc<'profiles'> | null | undefined> {
  const isQuery = !('insert' in ctx.db);
  const seen = isQuery ? (ROWLESS.get(ctx) ?? new Map()) : null;
  const known = seen?.get(id);
  if (known) return known;
  const budget = requestBudget(ctx);
  if (!budget.affords(ROW_MAX.profile)) return undefined;
  const read = budget.one('profile', () => ctx.db.get(id));
  if (seen) {
    seen.set(id, read);
    ROWLESS.set(ctx, seen);
  }
  return read;
}

export function personRowOf(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
): Promise<Doc<'peopleRows'> | null> {
  return ctx.db
    .query('peopleRows')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first();
}

/** Move the stored counts by the lanes a row left and joined. */
async function moveCounts(
  ctx: MutationCtx,
  before: Set<StoredCountKey>,
  after: Set<StoredCountKey>,
): Promise<void> {
  for (const key of STORED_COUNT_KEYS) {
    const delta = (after.has(key) ? 1 : 0) - (before.has(key) ? 1 : 0);
    if (delta !== 0) await bumpCount(ctx, key, delta);
  }
}

async function bumpCount(ctx: MutationCtx, key: string, delta: number): Promise<void> {
  const row = await ctx.db
    .query('peopleCounts')
    .withIndex('by_key', (q) => q.eq('key', key))
    .first();
  if (row) await ctx.db.patch(row._id, { count: row.count + delta });
  else await ctx.db.insert('peopleCounts', { key, count: delta });
}

/** Mark a backfill finished, as a run with no failures does (idempotent; for tests and seeds). */
export async function markReady(ctx: MutationCtx, backfill: PeopleBackfill): Promise<void> {
  await saveBackfill(ctx, backfill, {}, { running: false, cursor: null, failed: 0 });
}

/**
 * Bring a person's row in line with their profile, and the counts with it. The profile is read
 * afresh, so a caller may pass the copy it held before its own patch. A profile that no longer exists takes its row
 * out of every count. Writes nothing when nothing changed, unless `touch` (the drift repair) asks
 * for the refresh stamp to move. Returns whether the facts changed.
 */
export async function refreshPersonRow(
  ctx: MutationCtx,
  profileOrId: Doc<'profiles'> | Id<'profiles'>,
  { touch = false, now = Date.now() }: { touch?: boolean; now?: number } = {},
): Promise<boolean> {
  // Re-read rather than trust the caller's copy: it may predate the caller's own patch.
  const userId = typeof profileOrId === 'string' ? profileOrId : profileOrId._id;
  const profile = await ctx.db.get(userId);
  const existing = await personRowOf(ctx, userId);
  if (!profile) {
    if (!existing) return false;
    await moveCounts(ctx, storedLanesOf(existing), new Set());
    await ctx.db.delete(existing._id);
    LEDGER_EDITORS.delete(ctx);
    return true;
  }
  const next = derivePersonRow(profile, existing, now);
  if (existing && sameFacts(existing, next)) {
    if (touch) await ctx.db.patch(existing._id, { refreshedAt: now });
    return false;
  }
  if (existing) {
    await ctx.db.replace(existing._id, next);
  } else {
    await ctx.db.insert('peopleRows', next);
  }
  LEDGER_EDITORS.delete(ctx);
  await moveCounts(ctx, storedLanesOf(existing), storedLanesOf(next));
  return true;
}

/**
 * Trust points moved: the light path, since no lane reads them — the row's copy follows so the list
 * can derive the trust class without reading the profile. A person with no row yet gets one at their
 * next refresh (or the backfill).
 */
export async function notePoints(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  reputationPoints: number,
): Promise<void> {
  const row = await personRowOf(ctx, userId);
  if (row && row.reputationPoints !== reputationPoints) {
    await ctx.db.patch(row._id, { reputationPoints });
  }
}
