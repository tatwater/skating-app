/**
 * **A staffer's tenure, defined once** (D257, B01 §5.7): when they became staff and when they took the
 * role they hold, read from their role rows with undo chains taken into account (`lib/undoChains`).
 * `people.staffStats` reads it live; the Staff lane's rows carry the same answer, stamped by
 * {@link stampTenure} at every role write (and by the rows backfill, and again when the undo-chain
 * backfill places a role undo), so the lane and the strip can't give two dates for one fact.
 */

import type { UserRole } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { personRowOf } from './peopleRows';
import { readPreparation } from './peopleRuns';
import { DOC_MAX, inWaves, ReadBudget, ROW_MAX } from './readBudget';
import { chainRootId, isStandingChange } from './undoChains';

type Audit = Doc<'moderationActions'>;

/** Role rows walked at most, of each verb, newest first. */
export const ROLE_ROWS = 50;

/**
 * Chain roots for a read: from the rows already in hand, else read once each as they really weigh
 * (`ReadBudget.measured`). `undefined` when the budget can't afford the read — the caller's figure is
 * then capped.
 */
export function rootReader(ctx: QueryCtx, budget: ReadBudget, known: readonly Audit[]) {
  const byId = new Map<string, Audit>(known.map((r) => [r._id, r]));
  // Reads in flight, shared: rows read in a wave together that share a first row read it once.
  const reading = new Map<string, Promise<Audit | null | undefined>>();
  return async (row: Audit): Promise<Audit | undefined> => {
    const id = chainRootId(row);
    // A row no undo is its own first row: already in hand, never read again.
    if (id === row._id) return row;
    const have = byId.get(id);
    if (have) return have;
    let pending = reading.get(id);
    if (pending === undefined) {
      pending = budget.measured('moderationAction', () => ctx.db.get(id));
      reading.set(id, pending);
    }
    const read = await pending;
    if (read === undefined) {
      // Past the budget: forget it, so a later ask may try again once reads have settled.
      reading.delete(id);
      return undefined;
    }
    // The first row is gone: judge the row on its own — nothing known above it, so it stands.
    if (read === null) return { ...row, undoTop: row.undoDepth ?? 0, undoTopActorId: undefined };
    byId.set(id, read);
    return read;
  };
}

/** What a role row says: the role it gave and the one it replaced (absent on rows from before). */
function roleMove(row: Audit): { to: UserRole; from: UserRole | undefined } {
  const m = (row.metadata ?? {}) as { role?: UserRole; priorRole?: UserRole };
  return { to: row.action === 'revoke_role' ? 'member' : (m.role ?? 'member'), from: m.priorRole };
}

/**
 * When a staffer became staff, and when they took the role they hold — each `null` (not recorded)
 * unless a row on record says so:
 * - only **standing changes** count (`lib/undoChains`): an undo is no change of its own, and a change
 *   undone on net is gone — undone twice, it is back with its own time;
 * - **staff since** is the grant that moved them *in* from member (`priorRole: 'member'`) after the
 *   latest revoke. A move between moderator and admin is not an entry, and a grant with no
 *   `priorRole` (a row from before it was recorded) can't be told from one — so when the entering
 *   grant isn't on record, the answer is `null`, never a later move's date;
 * - **role since** is the newest standing change, when the role it gave is the one held now; else the
 *   move to the present role was never recorded: `null`.
 */
export function staffTenure(
  rows: readonly Audit[],
  rootOf: (row: Audit) => Audit,
  role: UserRole,
): {
  staffSince: { at: number; role: UserRole } | null;
  roleSince: { at: number; role: UserRole } | null;
} {
  const changes = rows
    .filter((r) => isStandingChange(r, rootOf(r)))
    .sort((x, y) => y.createdAt - x.createdAt);
  const lastRevoke = changes.find((r) => r.action === 'revoke_role');
  const entry = changes.find(
    (g) =>
      g.action === 'grant_role' &&
      (lastRevoke === undefined || g.createdAt > lastRevoke.createdAt) &&
      roleMove(g).from === 'member',
  );
  const newest = changes[0];
  return {
    staffSince: entry === undefined ? null : { at: entry.createdAt, role: roleMove(entry).to },
    roleSince:
      newest !== undefined && roleMove(newest).to === role ? { at: newest.createdAt, role } : null,
  };
}

export interface TenureRead {
  tenure: ReturnType<typeof staffTenure>;
  /** The budget ran out before every role row or chain root was read. */
  roleShort: boolean;
  /** A walk read its last allowed row: older rows may lie past it. */
  roleFull: boolean;
  /** An undo among the role rows predates the undo-chain backfill: the dates can't be told yet. */
  roleUnplaced: boolean;
}

/** Whether a tenure read's `null` dates are a stop rather than "not recorded". */
export function tenureCappedOf(read: TenureRead): boolean {
  return read.roleShort || (!read.roleUnplaced && read.roleFull && read.tenure.staffSince === null);
}

/**
 * Read a staffer's tenure through `budget`: each verb's role rows newest first (at most
 * {@link ROLE_ROWS}), then each row's chain root, every read asked of the budget first.
 */
export async function readTenure(
  ctx: QueryCtx,
  budget: ReadBudget,
  staffer: Id<'profiles'>,
  role: UserRole,
  chainsReady: boolean,
): Promise<TenureRead> {
  const roleRows: Audit[] = [];
  let roleShort = false;
  let roleFull = false;
  // The two verbs walked side by side (each walk is a chain of reads, each starting where the last
  // stopped); one verb's rows don't wait on the other's.
  const walk = async (action: 'grant_role' | 'revoke_role') => {
    let before = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ROLE_ROWS; i++) {
      const row = await budget.measured('moderationAction', () =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target_action', (q) =>
            q
              .eq('targetType', 'user')
              .eq('targetId', staffer)
              .eq('action', action)
              .lt('_creationTime', before),
          )
          .order('desc')
          .first(),
      );
      if (row === undefined) {
        roleShort = true;
        break;
      }
      if (row === null) break;
      roleRows.push(row);
      before = row._creationTime;
      // The walk's last row read: older ones may lie past it (one that found its end is whole).
      if (i === ROLE_ROWS - 1) roleFull = true;
    }
  };
  await Promise.all([walk('grant_role'), walk('revoke_role')]);
  roleRows.sort((a, b) => b._creationTime - a._creationTime);
  // Before the undo-chain backfill, an undo written before chains were kept carries no place, and
  // the change it undid still reads as standing: the dates can't be told yet — `pending`, not capped.
  const roleUnplaced =
    !chainsReady && roleRows.some((r) => r.undoesActionId !== undefined && !r.undoRoot);
  const roleRoot = rootReader(ctx, budget, roleRows);
  const roots = new Map<string, Audit>();
  const read = await inWaves(
    budget,
    roleShort || roleUnplaced ? [] : roleRows,
    ROW_MAX.moderationAction,
    async (r) => {
      const root = await roleRoot(r);
      return root === undefined ? undefined : { r, root };
    },
  );
  if (read.stoppedAt !== null) roleShort = true;
  for (const { r, root } of read.results) roots.set(r._id, root);
  const tenure =
    roleShort || roleUnplaced
      ? { staffSince: null, roleSince: null }
      : staffTenure(roleRows, (r) => roots.get(r._id) ?? r, role);
  return { tenure, roleShort, roleFull, roleUnplaced };
}

/** What a tenure stamp may read: the role walk and its roots, at their worst. */
const STAMP_BUDGET = 4 * DOC_MAX;

/** A stamp's whole work, as a caller's budget charges it: its walk, the row and the readiness. */
export const STAMP_WORK = STAMP_BUDGET + 64 * 1024;

/**
 * Stamp a person's tenure on their People row, by {@link readTenure} — the Staff lane shows it. For
 * someone who isn't staff the stamp is cleared. Written at each role write (after its audit row),
 * by the rows backfill for a staffer whose row has none, and when the undo-chain backfill places a
 * role undo; a stamp that couldn't be read whole is stored as `capped`.
 */
export async function stampTenure(ctx: MutationCtx, userId: Id<'profiles'>): Promise<void> {
  const row = await personRowOf(ctx, userId);
  if (!row) return;
  if (row.role === 'member' || !row.live) {
    if (row.tenureAt !== undefined) {
      await ctx.db.patch(row._id, {
        roleSince: undefined,
        staffSince: undefined,
        tenureCapped: undefined,
        tenureAt: undefined,
      });
    }
    return;
  }
  const { pending } = await readPreparation(ctx);
  const read = await readTenure(
    ctx,
    new ReadBudget(STAMP_BUDGET),
    userId,
    row.role,
    !pending.includes('undoChains'),
  );
  // Capped only for a read that stopped short, as the strip says it: an undo not yet placed leaves the
  // dates `null` and the readers' `pending` naming `undoChains` — and the undo-chain backfill stamps
  // the row again once it places that undo.
  await ctx.db.patch(row._id, {
    roleSince: read.tenure.roleSince?.at,
    staffSince: read.tenure.staffSince?.at,
    tenureCapped: tenureCappedOf(read),
    tenureAt: Date.now(),
  });
}
