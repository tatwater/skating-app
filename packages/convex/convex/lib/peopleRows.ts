/**
 * The one writer of `peopleRows` and `peopleCounts` (B01 §5.7).
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

// The backfills' registry, runs and readiness live in `lib/peopleRuns`; re-exported for the readers
// and tests that already import from here.
export {
  markReady,
  type Pending,
  type PeopleBackfill,
  readPending,
} from './peopleRuns';

/**
 * The row a profile reads as, given the row it had (`prev`, for the times a change is first seen):
 *
 * - `statusSince` is when the person's status terms as they stand were set (`lib/statusTerms`): when
 *   this writer saw the status change, or a status write said it set new terms (`termsSet` — a
 *   reason or an end that differs); `restrictedSince` is when the first restriction landed. Both are
 *   0 (not recorded) for a row first written by the backfill, except a tombstone, which knows when
 *   it was made.
 * - A tombstone is in no lane but Deleted: not staff (a deleted admin keeps its `role`), not
 *   restricted, not leaving.
 */
export function derivePersonRow(
  profile: Doc<'profiles'>,
  prev: PersonRowFields | null,
  now: number,
  termsSet = false,
): PersonRowFields {
  const deleted = profile.status === 'deleted';
  const suspendedUntil =
    profile.status === 'suspended' ? (profile.suspendedUntil ?? OPEN_ENDED) : 0;
  // New terms — a status write that set a reason or an end that differs (it says so: the row keeps
  // only a line of the reason) — date the status anew, as the person page's status note does.
  const statusChanged = prev !== null && (prev.status !== profile.status || termsSet);
  // A row first written by a status write (a person the rows backfill hasn't reached) is dated by
  // that write, as the person page's note dates it — never 0 beside a note that names the write.
  const statusSince = deleted
    ? (profile.deletedAt ?? (statusChanged ? now : (prev?.statusSince ?? 0)))
    : prev === null
      ? termsSet
        ? now
        : 0
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
    suspendedUntil,
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
    // A tenure stamp outlives a refresh while the role holds; a role change voids it until the role
    // write stamps it again (`lib/staffTenure.stampTenure`).
    ...(prev !== null && prev.role === profile.role && !deleted ? tenureOf(prev) : {}),
  };
}

/** The tenure stamp's fields on a row, as present. */
function tenureOf(row: PersonRowFields): Partial<PersonRowFields> {
  return {
    ...(row.roleSince !== undefined ? { roleSince: row.roleSince } : {}),
    ...(row.staffSince !== undefined ? { staffSince: row.staffSince } : {}),
    ...(row.tenureCapped !== undefined ? { tenureCapped: row.tenureCapped } : {}),
    ...(row.tenureAt !== undefined ? { tenureAt: row.tenureAt } : {}),
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

/**
 * Bring a person's row in line with their profile, and the counts with it. The profile is read
 * afresh, so a caller may pass the copy it held before its own patch. A profile that no longer exists takes its row
 * out of every count. Writes nothing when nothing changed, unless `touch` (the drift repair) asks
 * for the refresh stamp to move. Returns whether the facts changed.
 */
export async function refreshPersonRow(
  ctx: MutationCtx,
  profileOrId: Doc<'profiles'> | Id<'profiles'>,
  {
    touch = false,
    now = Date.now(),
    termsSet = false,
  }: { touch?: boolean; now?: number; termsSet?: boolean } = {},
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
  const next = derivePersonRow(profile, existing, now, termsSet);
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
