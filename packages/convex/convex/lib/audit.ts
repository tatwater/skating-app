/**
 * The one writer of `moderationActions` (B01 §11, D226).
 *
 * Every operator action — and every machine action an operator should be able to check — leaves one
 * audit row. They used to be written by 51 direct inserts across 16 files; they all come through here
 * now, so the row's shape is decided once: who (absent when the system acted), what, on what, why,
 * what it replaced, and — for an undo — which row it undoes. `auditWriters.test.ts` (guards) holds the
 * sources to this file being the only writer.
 */

import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG, isAuditVia } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { noteAuditedAction } from './bodyLibrary';
import type { MODERATION_ACTIONS, MODERATION_TARGET_TYPES } from './enums';

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
export type ModerationTargetType = (typeof MODERATION_TARGET_TYPES)[number];

export interface AuditEntry {
  /** The operator who acted; absent when the system did (A05c / D80). */
  actorId?: Id<'profiles'>;
  action: ModerationAction;
  targetType: ModerationTargetType;
  targetId: string;
  /**
   * Required: accountability for appeals and reversals. A string is what a person typed, refused past
   * {@link AUDIT_REASON_MAX} (D261); a reason the system builds from stored names or text is a
   * {@link composed} one, shortened to fit and never refused.
   */
  reason: AuditReasonOrText;
  /** Prior and new state, and whatever the verb's undo needs (B01 §11). */
  metadata?: Record<string, unknown>;
  /** Set when this row is the undo of an earlier one (D226). */
  undoesActionId?: Id<'moderationActions'>;
  /** Defaults to now; pass the mutation's own `now` when other rows share it. */
  createdAt?: number;
}

/**
 * A reason the system composes from fixed words and stored names or text — built with the
 * {@link composed} tag, so the writer says which parts are its own words and which it quoted.
 */
/** Made only here: a reason shape a writer can't spell as a literal around `typed` or `composed`. */
declare const TAGGED: unique symbol;

export interface ComposedReason {
  readonly [TAGGED]: 'composed';
  readonly composed: true;
  readonly fixed: readonly string[];
  readonly values: readonly string[];
}

/**
 * A reason held to the cap exactly as written — a person's words, or a fixed sentence of ours —
 * made by {@link typed}, which refuses it past {@link AUDIT_REASON_MAX} (D261).
 */
export interface TypedReason {
  readonly [TAGGED]: 'typed';
  readonly typed: string;
}

/** A reason the audit writer can take: typed (refused past the cap) or composed (shortened to fit). */
export type AuditReason = TypedReason | ComposedReason;

/**
 * What the other writers still pass (compatible): a tagged reason, or a plain string held to the cap
 * as typed. The People writers take {@link AuditReason} only (`writePersonAudit`).
 */
export type AuditReasonOrText = AuditReason | string;

/** A reason as written, refused past the cap with its plain message (D261). */
export function typed(text: string): TypedReason {
  return { typed: checkedReason(text) } as unknown as TypedReason;
}

/**
 * Tag a reason the system builds itself: `composed\`Drew "${name}" on ${body.name}\``. The audit
 * writer keeps the fixed words and trims the quoted values with an ellipsis until it fits the cap
 * (D261's cap is for what a person types; a composed reason never makes its own write fail).
 */
export function composed(fixed: TemplateStringsArray, ...values: unknown[]): ComposedReason {
  // A template's fixed parts are its own literals; what it quotes is held by the guard
  // (`auditWriters.test.ts`: a person's words through `checkedReason`).
  return partsOf(
    [...fixed],
    values.map((v) => String(v)),
  );
}

/** Made only by {@link checkedReason}: a brand a writer can't spell on a plain string. */
declare const CHECKED: unique symbol;

/**
 * **A person's words as {@link checkedReason} kept them** — trimmed, held to the cap (D261). Still a
 * string wherever one is read; the brand says the check ran, which {@link composedOf} asks of any
 * fixed part that is not the writer's own literal.
 */
export type CheckedText = string & { readonly [CHECKED]: true };

/**
 * One fixed part of a composed reason, as {@link composedOf} takes it (B01-4h): a literal of the
 * writer's own words, or a person's words checked ({@link CheckedText}) — never a plain `string`,
 * whose words could be anyone's and would be kept whole past the cap, untrimmed, nor a template with
 * a hole (`` `Hid ${note}` ``, which the `const` parameter infers as `` `Hid ${string}` ``). A pure
 * literal is the one string type an empty object can't satisfy as a record's keys.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the probe — only a literal key set excludes it.
export type FixedWord<S> = S extends CheckedText ? S : {} extends Record<S & string, 1> ? never : S;

/**
 * A composed reason from its parts — for a writer whose fixed words aren't a template (a person's
 * checked words kept whole, a system line shortened around them). Each fixed part is a literal or a
 * `checkedReason(…)` (the type holds it); the values are shortened to fit, as a template's are.
 */
export function composedOf<const F extends readonly string[]>(
  fixed: F & { readonly [K in keyof F]: FixedWord<F[K]> },
  values: readonly string[],
): ComposedReason {
  return partsOf(fixed, values);
}

function partsOf(fixed: readonly string[], values: readonly string[]): ComposedReason {
  return { composed: true, fixed, values } as unknown as ComposedReason;
}

/**
 * **The one normalizer** (B01-4h): a reason with its outer whitespace taken off, and nothing else
 * changed. {@link writeAudit} stores every reason through it — plain, typed or composed — so a
 * "nothing changed" comparison and the stored text never differ by a leading or trailing space.
 */
export function normalizeReason(text: string): string {
  return text.trim();
}

/**
 * **Whether two reasons are the same reason** — normalized on both sides, so a reason kept with outer
 * whitespace before {@link normalizeReason} was the writer's (only a raw call could send one) still
 * matches its trimmed repeat, with no backfill. `null` (none recorded) equals only `null`.
 */
export function sameReason(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizeReason(a) === normalizeReason(b);
}

/**
 * **A person's typed reason, as the write keeps it** — {@link normalizeReason} (a trailing space is
 * never a change, D270), then refused past the cap (D261). Every typed reason goes through it
 * (`typed`, and a writer that quotes one in a composed reason or compares it with the one on file).
 */
export function checkedReason(typed: string): CheckedText {
  const text = normalizeReason(typed);
  if (text.length > AUDIT_REASON_MAX) throw new ConvexError(AUDIT_REASON_TOO_LONG);
  return text as CheckedText;
}

/** A composed reason as text, its values trimmed — the longest first — until it fits the cap. */
export function fitComposed(reason: ComposedReason): string {
  const join = (values: readonly string[]) =>
    reason.fixed.reduce((out, part, i) => out + part + (values[i] ?? ''), '');
  const whole = join(reason.values);
  if (whole.length <= AUDIT_REASON_MAX) return whole;
  const fixedLength = reason.fixed.reduce((n, part) => n + part.length, 0);
  // Water-fill the room left by the fixed words: short values keep their length, long ones share.
  let room = Math.max(0, AUDIT_REASON_MAX - fixedLength);
  const allowed = new Array<number>(reason.values.length).fill(0);
  const lengths = reason.values.map((v) => v.length);
  const order = lengths.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  order.forEach((i, k) => {
    const share = Math.floor(room / (order.length - k));
    const take = Math.min(lengths[i] ?? 0, share);
    allowed[i] = take;
    room -= take;
  });
  const fitted = join(reason.values.map((v, i) => trimTo(v, allowed[i] as number)));
  // Fixed words longer than the cap themselves (none are): cut, never refuse.
  return fitted.length <= AUDIT_REASON_MAX ? fitted : trimTo(fitted, AUDIT_REASON_MAX);
}

/** `text` in at most `max` UTF-16 units, an ellipsis marking a cut, never through a surrogate pair. */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The People writers' entry (B01-4b): an audit entry whose reason is tagged — typed or composed — so
 * a bare string, built in a variable and quoting stored text, can't compile into a person write. The
 * other writers still pass strings to {@link writeAudit} (compatible: a string is held to the cap as
 * typed); `packages/guards` holds the People modules to this entry.
 */
export function writePersonAudit(
  ctx: MutationCtx,
  entry: Omit<AuditEntry, 'reason'> & { reason: AuditReason },
): Promise<Id<'moderationActions'>> {
  return writeAudit(ctx, entry);
}

export async function writeAudit(
  ctx: MutationCtx,
  entry: AuditEntry,
): Promise<Id<'moderationActions'>> {
  const { createdAt, reason: given, ...rest } = entry;
  // The one place a reason enters the log (D261). What a person typed is refused past the cap, the
  // whole write with it; a reason the system composed is shortened to fit — its names trimmed, its
  // fixed words kept — so no job or lever ever fails on a name it quoted.
  // Every kind normalized here, the one place (B01-4h): a plain string held to the cap once its outer
  // whitespace is off, as a typed one is; a composed one trimmed after it is fitted (trimming only
  // shortens it, so it still fits).
  const reason = normalizeReason(
    typeof given === 'string' ? given : 'typed' in given ? given.typed : fitComposed(given),
  );
  if (reason.length > AUDIT_REASON_MAX) throw new ConvexError(AUDIT_REASON_TOO_LONG);
  const row = { ...rest, reason };
  const undoesActionId = row.undoesActionId ?? UNDOING.get(ctx);
  const at = createdAt ?? Date.now();
  const via = row.actorId !== undefined ? (VIA.get(ctx) ?? (await viaOf(ctx))) : undefined;
  // An undo's place in its chain, and the chain's newest depth on its first row (`lib/undoChains`).
  const chain =
    undoesActionId !== undefined ? await chainPlaceOf(ctx, undoesActionId, row.actorId) : {};
  const id = await ctx.db.insert('moderationActions', {
    ...row,
    ...(undoesActionId !== undefined ? { undoesActionId } : {}),
    ...chain,
    ...(via !== undefined ? { via } : {}),
    createdAt: at,
  });
  // The Bodies library (B01-3): an action on a body, or on something that belongs to one, refreshes
  // that body's library row in this transaction — and a moderator's stamps *Changed*.
  await noteAuditedAction(ctx, {
    actionId: id,
    action: row.action,
    ...(row.actorId !== undefined ? { actorId: row.actorId } : {}),
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: at,
  });
  return id;
}

/** How many unplaced undos (from before chains were kept) one write places above the row it undoes. */
const LEGACY_HOPS = 32;

/**
 * An undo of `undoneId`: its chain's first row and its depth, and the first row stamped with the
 * chain's new newest depth and who wrote it — two point reads at most, one patch. Every row an undo
 * writes is tagged with the row it undoes (a cascade's member rows too), so they share the depth and
 * the stamp is written once.
 *
 * An undone row that is itself an undo written before chains were kept, and not yet placed by
 * `peopleJobs.backfillUndoChains`, is placed first (its own undone row the same way, up to
 * {@link LEGACY_HOPS}): otherwise it would be taken for a chain's first row, and since the backfill
 * passes over a row already placed, this row's place would stay wrong once the backfill had run.
 */
/**
 * An undo's place in its chain, worked out once a transaction (PR #170): every row an undo writes is
 * tagged with what it undoes, and an undo that reopens five hundred flags writes five hundred rows —
 * each reading the undone row again would read it five hundred times.
 */
const CHAIN_PLACES = new WeakMap<
  object,
  Map<string, Promise<{ undoRoot?: Id<'moderationActions'>; undoDepth?: number }>>
>();
function chainPlaceOf(
  ctx: MutationCtx,
  undoneId: Id<'moderationActions'>,
  actorId: Id<'profiles'> | undefined,
) {
  let places = CHAIN_PLACES.get(ctx);
  if (!places) {
    places = new Map();
    CHAIN_PLACES.set(ctx, places);
  }
  let place = places.get(undoneId);
  if (!place) {
    place = placeInUndoChain(ctx, undoneId, actorId);
    places.set(undoneId, place);
  }
  return place;
}

async function placeInUndoChain(
  ctx: MutationCtx,
  undoneId: Id<'moderationActions'>,
  actorId: Id<'profiles'> | undefined,
  legacyHops = LEGACY_HOPS,
): Promise<{ undoRoot?: Id<'moderationActions'>; undoDepth?: number }> {
  let undone = await ctx.db.get(undoneId);
  if (!undone) return {};
  if (undone.undoesActionId !== undefined && undone.undoRoot === undefined && legacyHops > 0) {
    const place = await placeInUndoChain(
      ctx,
      undone.undoesActionId,
      undone.actorId,
      legacyHops - 1,
    );
    if (place.undoRoot !== undefined) {
      await ctx.db.patch(undone._id, place);
      undone = { ...undone, ...place };
    }
  }
  const rootId = undone.undoRoot ?? undone._id;
  const depth = (undone.undoDepth ?? 0) + 1;
  const root = rootId === undone._id ? undone : await ctx.db.get(rootId);
  if (root && (root.undoTop ?? 0) < depth) {
    await ctx.db.patch(rootId, { undoTop: depth, undoTopActorId: actorId });
  }
  return { undoRoot: rootId, undoDepth: depth };
}

/**
 * The script or agent the caller made this write through (D256), from the `via` claim on their
 * identity, when it passes `isAuditVia`; anything else is dropped, never stored.
 *
 * **Why a claim and not an argument.** A script calls public mutations as a person with
 * `convex run --identity`, which needs the deployment's admin credentials, and puts `via` beside the
 * `subject` there (`@skating/run-log`'s `convexRun`). No mutation takes it as an argument, so no
 * client can pass it, and a signed-in session's token carries only the claims its issuer writes.
 * Even a forged one could do no more than relabel the forger's own row: the actor is still the
 * signed-in person, and nothing reads `via` to decide anything.
 */
async function viaOf(ctx: MutationCtx): Promise<string | undefined> {
  const claim = (await ctx.auth.getUserIdentity())?.via;
  return isAuditVia(claim) ? claim : undefined;
}

/**
 * The undo an in-flight mutation is performing, keyed by its context. An undo runs the inverse verb's
 * own helper, which writes its own audit rows the ordinary way; every row written while `fn` runs is
 * tagged with the row it undoes, so a cascade (a Post's restore bringing back its reports) is tagged
 * too, with no helper having to thread the id through.
 */
const UNDOING = new WeakMap<object, Id<'moderationActions'>>();

/**
 * Whether this write is an undo putting back what a row recorded (B01-3h) — the text caps hold what a
 * write introduces, never a value the row already had, so an undo of a row written before the caps
 * still runs.
 */
export function isUndoing(ctx: object): boolean {
  return UNDOING.has(ctx);
}

/** The `via` a continuation carries from the act it continues (a scheduled call has no identity). */
const VIA = new WeakMap<object, string>();

/**
 * **What a continuation must carry to write as the act it continues** (PR #170): the row an undo is
 * undoing (so every row it writes is tagged with it, chain fields and all, as the first page's rows
 * are) and the script or agent the act was made through. Read at the schedule; re-entered by
 * {@link asContinuationOf} in the later page's transaction.
 */
export type AuditContext = { undoOf?: Id<'moderationActions'>; via?: string };

/** The audit context the current transaction writes under, for a continuation to carry. */
export async function auditContextOf(ctx: MutationCtx): Promise<AuditContext> {
  const undoOf = UNDOING.get(ctx);
  const via = VIA.get(ctx) ?? (await viaOf(ctx));
  return { ...(undoOf !== undefined ? { undoOf } : {}), ...(via !== undefined ? { via } : {}) };
}

/** Run a continuation's page under the audit context its first page carried. */
export async function asContinuationOf<T>(
  ctx: MutationCtx,
  carried: AuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (carried.via !== undefined) VIA.set(ctx, carried.via);
  try {
    return carried.undoOf !== undefined ? await asUndoOf(ctx, carried.undoOf, fn) : await fn();
  } finally {
    VIA.delete(ctx);
  }
}

/** An audit context as a continuation's arguments carry it. */
export const auditContextArgs = {
  undoOf: v.optional(v.id('moderationActions')),
  via: v.optional(v.string()),
};

export async function asUndoOf<T>(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  fn: () => Promise<T>,
): Promise<T> {
  UNDOING.set(ctx, actionId);
  try {
    return await fn();
  } finally {
    UNDOING.delete(ctx);
  }
}

// ── Snapshots: what an action replaced, when it is too big for the audit row ─────────────────────

/**
 * Characters of serialized payload per `auditSnapshots` row. A document holds 1 MiB and a character
 * can take up to four bytes in UTF-8, so a fifth of that keeps any part under the limit.
 */
export const SNAPSHOT_PART_CHARS = 200_000;

/**
 * Record what `actionId` replaced (D226, B01 §11): a sub-area's previous outline, a body's previous
 * weather grid, a merge's moved rows. Written in the same mutation as the audit row and read by that
 * row's undo (or, for a merge, by the unmerge §4 owes).
 *
 * A payload that fits is stored as itself, so the dashboard shows it; a bigger one (a merge of a busy
 * body) is serialized and split across ordered `part`s. Either way {@link readSnapshot} returns the
 * payload as written. A stored field may not start with `_` — pass documents through
 * {@link snapshotDoc}. Returns how many parts were written.
 */
export async function writeSnapshot(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  payload: unknown,
): Promise<number> {
  const json = JSON.stringify(payload);
  const createdAt = Date.now();
  if (json.length <= SNAPSHOT_PART_CHARS) {
    await ctx.db.insert('auditSnapshots', { actionId, part: 0, payload, createdAt });
    return 1;
  }
  const parts = Math.ceil(json.length / SNAPSHOT_PART_CHARS);
  for (let part = 0; part < parts; part++) {
    await ctx.db.insert('auditSnapshots', {
      actionId,
      part,
      payload: {
        chunk: json.slice(part * SNAPSHOT_PART_CHARS, (part + 1) * SNAPSHOT_PART_CHARS),
        of: parts,
      },
      createdAt,
    });
  }
  return parts;
}

type Chunk = { chunk: string; of: number };
const isChunk = (payload: unknown): payload is Chunk =>
  typeof payload === 'object' &&
  payload !== null &&
  typeof (payload as { chunk?: unknown }).chunk === 'string';

/** The payload {@link writeSnapshot} recorded for `actionId`, or `null` when there is none. */
export async function readSnapshot<T = unknown>(
  ctx: QueryCtx | MutationCtx,
  actionId: Id<'moderationActions'>,
): Promise<T | null> {
  const rows = await ctx.db
    .query('auditSnapshots')
    .withIndex('by_action', (q) => q.eq('actionId', actionId))
    .collect();
  const first = rows[0];
  if (!first) return null;
  if (!isChunk(first.payload)) return first.payload as T;
  if (rows.length !== first.payload.of) {
    throw new Error(`auditSnapshots: ${actionId} has ${rows.length} of ${first.payload.of} parts`);
  }
  return JSON.parse(rows.map((row) => (row.payload as Chunk).chunk).join('')) as T;
}

/** A document as a snapshot stores it: a stored field may not start with `_`, so the two are renamed. */
export function snapshotDoc<T extends { _id: string; _creationTime: number }>(
  doc: T,
): Omit<T, '_id' | '_creationTime'> & { id: T['_id']; creationTime: number } {
  const { _id, _creationTime, ...rest } = doc;
  return { ...rest, id: _id, creationTime: _creationTime };
}
