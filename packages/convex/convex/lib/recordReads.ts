/**
 * **The record sheet's reads, shaped once** (B01-4d; D248). The three lists — Standing, Deleted and
 * Reversed — and the item pane read a page of small index rows, then each row's own documents, in a
 * few phases over the request's one budget (`requestBudget`), so a page of fifty costs a handful of
 * rounds, never one per row:
 *
 * 1. **the rows** — one `take` per index range (two after a cursor that lands inside a tie), keyed by
 *    position, never `paginate` (a function gets one, and the Deleted list merges five ranges);
 * 2. **each row's documents** — its decision and the action that ended it, the item — in waves
 *    (`ReadBudget.waves`): each row reserves its worst case before it reads, the difference is handed
 *    back when its wave is done, and which rows are read depends only on the page's order;
 * 3. **what a row is on** — the Report a comment or a Post names its body through (each once a page,
 *    `PageCache`), the erasure row of an item that is gone — in waves again;
 * 4. **the names** — each distinct body's library row and each distinct person's People row, once a
 *    page, in waves.
 *
 * A row whose reads the budget couldn't reserve ends the page there: the page is shorter, its cursor
 * sits after the last row read whole, and `isDone` is false. A short page is not the end; `isDone` is.
 * People are named from their stored People row (`peopleRows`), never a profile (a profile can weigh a
 * whole document).
 */
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authorDeletedAtOf } from './authorDeletion';
import type { VerdictTargetType } from './contentVerdicts';
import { ERASABLE, withdrawnAtOf } from './eraseClock';
import { type ReadBudget, ROW_MAX, type RowKind, type Share } from './readBudget';

/** Rows per page of a record list, at most — each page is also sized by what its rows can weigh. */
export const RECORD_PAGE = 50;

export type RecordContentDoc =
  | Doc<'reports'>
  | Doc<'posts'>
  | Doc<'comments'>
  | Doc<'hazards'>
  | Doc<'accessAlerts'>;

/** A person as the record names them, from their People row: `null` names before the rows backfill. */
export interface RecordPerson {
  userId: Id<'profiles'>;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
}

/** What staff read of an item on the record: the words still kept, and when it was made. */
export interface RecordContent {
  at: number;
  text: string | null;
  title?: string | null;
}

export function contentOf(targetType: VerdictTargetType, doc: RecordContentDoc): RecordContent {
  switch (targetType) {
    case 'report': {
      const r = doc as Doc<'reports'>;
      return { at: r.skateEndTime, text: r.notes ?? null };
    }
    case 'post': {
      const p = doc as Doc<'posts'>;
      return { at: p.latestSkateEndTime, title: p.title ?? null, text: p.body ?? null };
    }
    case 'comment': {
      const c = doc as Doc<'comments'>;
      return { at: c.createdAt, text: c.body };
    }
    case 'hazard': {
      const h = doc as Doc<'hazards'>;
      return { at: h.firstReportedAt, title: h.type, text: h.description ?? null };
    }
    case 'accessAlert': {
      const a = doc as Doc<'accessAlerts'>;
      return { at: a.createdAt, title: a.reason, text: a.note ?? null };
    }
  }
}

/** When its author took it back, if they did — a deletion, or an alert's own retraction. */
export function withdrawnAt(targetType: VerdictTargetType, doc: RecordContentDoc): number | null {
  if (targetType === 'accessAlert') return withdrawnAtOf('accessAlert', doc) ?? null;
  return authorDeletedAtOf(doc as Exclude<RecordContentDoc, Doc<'accessAlerts'>>) ?? null;
}

/** The item a record row is about, by its kind's table: `null` when it is gone. */
export function targetIdOf(ctx: QueryCtx, targetType: VerdictTargetType, targetId: string) {
  return ctx.db.normalizeId(ERASABLE[targetType], targetId);
}

// ── Positions ──────────────────────────────────────────────────────────────────────────────────

/**
 * Where a page ended, in its list's order: the sort key (`at`, `endedAt`, or the withdrawal time),
 * the row's creation time (the index's own tie-break), and — on the merged Deleted list — the kind's
 * place in {@link DELETED_KINDS}, which breaks a tie between kinds.
 */
export interface Position {
  key: number;
  ct: number;
  kind?: number;
}

/** A position as the cursor the client passes back. */
export function encodePosition(p: Position): string {
  return JSON.stringify(p);
}

/** A cursor back to a position: `null` (the start) when none; refused when it isn't one of ours. */
export function decodePosition(raw: string | null | undefined): Position | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const p = JSON.parse(raw) as Position;
    if (
      typeof p.key === 'number' &&
      typeof p.ct === 'number' &&
      (p.kind === undefined || typeof p.kind === 'number')
    ) {
      return p;
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ConvexError('This list’s place can’t be read; open it again from the start.');
}

/**
 * Up to `n` rows after a position, from an index range in two parts: the rows tied with it on the key
 * (`tie`, read only when there is a position) and the rest (`rest`), both at once. Each part charges
 * its worst case before reading and hands back what didn't come.
 */
export async function takeAfter<D>(
  reads: ReadBudget,
  kind: RowKind,
  n: number,
  tie: ((k: number) => Promise<D[]>) | null,
  rest: (k: number) => Promise<D[]>,
): Promise<D[]> {
  if (n <= 0) return [];
  const [tied, after] = await Promise.all([
    tie ? reads.take(kind, n, tie) : Promise.resolve([] as D[]),
    reads.take(kind, n, rest),
  ]);
  return [...tied, ...after].slice(0, n);
}

// ── A page of verdicts, read whole ─────────────────────────────────────────────────────────────

/** A verdict row and everything its line on the sheet shows, as read. */
export interface VerdictLoad {
  verdict: Doc<'contentVerdicts'>;
  /** The decision's own audit row (its reason, who made it); `null` if it is gone. */
  decision: Doc<'moderationActions'> | null;
  /** The row that ended it (Reversed only): a restore, an undo or an overturn. */
  ending: Doc<'moderationActions'> | null;
  /** The item; `null` once erased. */
  target: RecordContentDoc | null;
  /** The Report a comment or a Post names its body through. */
  report: Doc<'reports'> | null;
  /** The erasure's own audit row, for an item that is gone (Reversed only). */
  erase: Doc<'moderationActions'> | null;
}

/** A page's documents, as far as the budget reached: `cut` rows from the end didn't fit. */
export interface Loaded<T> {
  rows: T[];
  cut: boolean;
}

/** The Report a comment or a Post names its body through, by id. */
export function reportIdOf(
  targetType: VerdictTargetType,
  target: RecordContentDoc | null,
): Id<'reports'> | null {
  if (target === null) return null;
  if (targetType === 'comment') return (target as Doc<'comments'>).reportId;
  if (targetType === 'post') return (target as Doc<'posts'>).reportIds[0] ?? null;
  return null;
}

/** The body an item is on: on the row, or through its Report. */
export function bodyIdOf(
  targetType: VerdictTargetType,
  target: RecordContentDoc | null,
  report: Doc<'reports'> | null,
): Id<'waterBodies'> | null {
  if (target === null) return null;
  if (targetType === 'report' || targetType === 'hazard' || targetType === 'accessAlert') {
    return (target as Doc<'reports'> | Doc<'hazards'> | Doc<'accessAlerts'>).waterBodyId ?? null;
  }
  return report?.waterBodyId ?? null;
}

/** An item by its kind, through a wave's share. */
function readTarget(
  ctx: QueryCtx,
  share: Share,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<RecordContentDoc | null> {
  const id = targetIdOf(ctx, targetType, targetId);
  if (!id) return Promise.resolve(null);
  return share.read(targetType, () => ctx.db.get(id)) as Promise<RecordContentDoc | null>;
}

/** The newest erasure row on an item that is gone (the sweep writes one as it erases). */
function readErase(ctx: QueryCtx, share: Share, targetType: VerdictTargetType, targetId: string) {
  return share.read('moderationAction', () =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q.eq('targetType', targetType).eq('targetId', targetId).eq('action', 'erase'),
      )
      .order('desc')
      .first(),
  );
}

/**
 * What a page has already read, kept across its stages so a shared document is read once a page,
 * never once a row: each Report a comment or a Post names its body through (fifty comments on one
 * Report read it once), each body's library row and each person's People row.
 */
export interface PageCache {
  reports: Map<string, Doc<'reports'> | null>;
  names: Map<string, string | null>;
  persons: Map<string, RecordPerson>;
}

export function newPageCache(): PageCache {
  return { reports: new Map(), names: new Map(), persons: new Map() };
}

/**
 * The distinct Reports `ids` names that the page hasn't read yet, each read once, in waves; returns
 * the ids the budget couldn't reach (their rows end the page).
 */
export async function readReports(
  ctx: QueryCtx,
  reads: ReadBudget,
  ids: readonly (Id<'reports'> | null)[],
  cache: PageCache,
): Promise<Set<string>> {
  const wanted = [
    ...new Set(ids.filter((id): id is Id<'reports'> => id !== null && !cache.reports.has(id))),
  ];
  const read = await reads.waves(
    wanted,
    () => ({ bytes: ROW_MAX.report, reads: 1 }),
    async (id, share) => ({ id, report: await share.read('report', () => ctx.db.get(id)) }),
    () => null,
  );
  const missed = new Set<string>();
  wanted.forEach((id, i) => {
    const r = read[i];
    if (r === null || r === undefined) missed.add(id);
    else cache.reports.set(id, r.report);
  });
  return missed;
}

/**
 * Stages 2 and 3 of a page's reads for each row: the decision (and its ending), the item; then the
 * Report it names its body through (once a page, `cache`) or its erasure row. Rows after the first the
 * budget couldn't reserve are dropped (`cut`).
 */
export async function loadVerdicts(
  ctx: QueryCtx,
  reads: ReadBudget,
  verdicts: readonly Doc<'contentVerdicts'>[],
  { ended, cache }: { ended: boolean; cache: PageCache },
): Promise<Loaded<VerdictLoad>> {
  const first = await reads.waves(
    verdicts,
    (v) => ({
      bytes: (ended ? 2 : 1) * ROW_MAX.moderationAction + ROW_MAX[v.targetType],
      reads: ended ? 3 : 2,
    }),
    async (v, share): Promise<VerdictLoad | null> => {
      const endedBy = v.endedByActionId;
      const [decision, ending, target] = await Promise.all([
        share.read('moderationAction', () => ctx.db.get(v.actionId)),
        ended && endedBy !== undefined
          ? share.read('moderationAction', () => ctx.db.get(endedBy))
          : Promise.resolve(null),
        readTarget(ctx, share, v.targetType, v.targetId),
      ]);
      return { verdict: v, decision, ending, target, report: null, erase: null };
    },
    () => null,
  );
  const whole = takeUntilNull(first);
  // The Reports, each once a page; then, for an item that is gone, its erasure row.
  const missed = await readReports(
    ctx,
    reads,
    whole.map((row) => reportIdOf(row.verdict.targetType, row.target)),
    cache,
  );
  const reached: VerdictLoad[] = [];
  for (const row of whole) {
    const reportId = reportIdOf(row.verdict.targetType, row.target);
    if (reportId !== null && missed.has(reportId)) break;
    reached.push({
      ...row,
      report: reportId !== null ? (cache.reports.get(reportId) ?? null) : null,
    });
  }
  const second = await reads.waves(
    reached,
    (row) => {
      const gone = row.target === null && ended;
      return { bytes: gone ? ROW_MAX.moderationAction : 0, reads: gone ? 1 : 0 };
    },
    async (row, share): Promise<VerdictLoad | null> =>
      row.target === null && ended
        ? {
            ...row,
            erase: await readErase(ctx, share, row.verdict.targetType, row.verdict.targetId),
          }
        : row,
    () => null,
  );
  const rows = takeUntilNull(second);
  return { rows, cut: rows.length < verdicts.length };
}

/** The leading run of answers before the first that overflowed. */
export function takeUntilNull<T>(answers: readonly (T | null)[]): T[] {
  const out: T[] = [];
  for (const a of answers) {
    if (a === null) break;
    out.push(a);
  }
  return out;
}

// ── Names ──────────────────────────────────────────────────────────────────────────────────────

/** Each body's name and each person's row, read once a page — and which the budget didn't reach. */
export interface Names {
  body: (id: Id<'waterBodies'> | null) => { id: Id<'waterBodies'>; name: string | null } | null;
  person: (id: Id<'profiles'> | null | undefined) => RecordPerson | null;
  /** Whether a body or a person a row names was left unread (the row ends the page). */
  missed: (
    bodies: (Id<'waterBodies'> | null)[],
    people: (Id<'profiles'> | null | undefined)[],
  ) => boolean;
}

/** Read every distinct body's library row and person's People row a page names, in waves. */
export async function readNames(
  ctx: QueryCtx,
  reads: ReadBudget,
  bodies: readonly (Id<'waterBodies'> | null)[],
  people: readonly (Id<'profiles'> | null | undefined)[],
  cache: PageCache = newPageCache(),
): Promise<Names> {
  type Want = { body: Id<'waterBodies'> } | { person: Id<'profiles'> };
  const wants: Want[] = [];
  // What the page has read already is not read again.
  const seen = new Set<string>([...cache.names.keys(), ...cache.persons.keys()]);
  for (const b of bodies) {
    if (b !== null && !seen.has(b)) {
      seen.add(b);
      wants.push({ body: b });
    }
  }
  for (const p of people) {
    if (p !== null && p !== undefined && !seen.has(p)) {
      seen.add(p);
      wants.push({ person: p });
    }
  }
  const found = await reads.waves(
    wants,
    (w) => ({ bytes: 'body' in w ? ROW_MAX.bodyLibraryRow : ROW_MAX.personRow, reads: 1 }),
    async (w, share) => {
      if ('body' in w) {
        const row = await share.read('bodyLibraryRow', () =>
          ctx.db
            .query('bodyLibraryRows')
            .withIndex('by_body', (q) => q.eq('waterBodyId', w.body).eq('scope', '*'))
            .first(),
        );
        return { key: w.body as string, name: row?.name ?? null };
      }
      const row = await share.read('personRow', () =>
        ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', w.person))
          .first(),
      );
      return {
        key: w.person as string,
        person: {
          userId: w.person,
          displayName: row?.displayName ?? null,
          username: row?.username ?? null,
          profileImageUrl: row?.profileImageUrl ?? null,
        },
      };
    },
    () => null,
  );
  for (const f of found) {
    if (f === null) continue;
    if ('person' in f && f.person) cache.persons.set(f.key, f.person);
    else cache.names.set(f.key, (f as { name: string | null }).name);
  }
  return namesOf(cache);
}

/** Every name a page has read so far (`readNames` into `cache`), as its rows look them up. */
export function namesOf({ names, persons }: PageCache): Names {
  const reached = (id: string) => names.has(id) || persons.has(id);
  return {
    body: (id) => (id !== null && names.has(id) ? { id, name: names.get(id) ?? null } : null),
    person: (id) => (id ? (persons.get(id) ?? null) : null),
    missed: (bs, ps) =>
      bs.some((b) => b !== null && !reached(b)) ||
      ps.some((p) => p !== null && p !== undefined && !reached(p)),
  };
}

// ── The Deleted list's five ranges ─────────────────────────────────────────────────────────────

/** The Deleted list's kinds, in the order that breaks a tie on the withdrawal time. */
export const DELETED_KINDS = ['report', 'post', 'comment', 'hazard', 'accessAlert'] as const;

/**
 * Rows of each kind one merged page asks for, at most: the light kinds a page's worth, the heavy ones
 * (a Report, a Post, a hazard can each weigh a whole document) what a page's row budget affords.
 */
export const DELETED_TAKE: Record<VerdictTargetType, number> = {
  report: 2,
  post: 1,
  comment: RECORD_PAGE,
  hazard: 1,
  accessAlert: RECORD_PAGE,
};

/**
 * The rows of one kind after `after`, newest withdrawal first, up to `n` — strictly after the position
 * in the merged order (withdrawal desc, kind, creation desc): a kind before the position's, on an
 * earlier time only; the same kind, its tie by creation and then an earlier time; a kind after it, the
 * same time too. Every range keeps its lower bound — the withdrawal time is optional, and an absent
 * value sorts first.
 */
export function deletedRange(
  ctx: QueryCtx,
  reads: ReadBudget,
  kind: VerdictTargetType,
  userId: Id<'profiles'>,
  after: Position | null,
  n: number,
): Promise<RecordContentDoc[]> {
  const k = DELETED_KINDS.indexOf(kind);
  const pk = after?.kind ?? -1;
  const key = after?.key;
  const strict = k <= pk;
  const tieCt = after !== null && k === pk ? after.ct : null;
  // One shape for every kind's range: its lower bound, then the position's.
  const bound = <B extends { lt(f: never, v: number): B; lte(f: never, v: number): B }>(
    lower: B,
    field: never,
  ): B => (key === undefined ? lower : strict ? lower.lt(field, key) : lower.lte(field, key));
  switch (kind) {
    case 'report':
      return takeAfter(
        reads,
        kind,
        n,
        tieCt === null
          ? null
          : (m) =>
              ctx.db
                .query('reports')
                .withIndex('by_author_deleted', (q) =>
                  q.eq('authorId', userId).eq('authorDeletedAt', key).lt('_creationTime', tieCt),
                )
                .order('desc')
                .take(m),
        (m) =>
          ctx.db
            .query('reports')
            .withIndex('by_author_deleted', (q) =>
              bound(
                q.eq('authorId', userId).gt('authorDeletedAt', 0) as never,
                'authorDeletedAt' as never,
              ),
            )
            .order('desc')
            .take(m),
      );
    case 'post':
      return takeAfter(
        reads,
        kind,
        n,
        tieCt === null
          ? null
          : (m) =>
              ctx.db
                .query('posts')
                .withIndex('by_author_deleted', (q) =>
                  q.eq('authorId', userId).eq('authorDeletedAt', key).lt('_creationTime', tieCt),
                )
                .order('desc')
                .take(m),
        (m) =>
          ctx.db
            .query('posts')
            .withIndex('by_author_deleted', (q) =>
              bound(
                q.eq('authorId', userId).gt('authorDeletedAt', 0) as never,
                'authorDeletedAt' as never,
              ),
            )
            .order('desc')
            .take(m),
      );
    case 'comment':
      return takeAfter(
        reads,
        kind,
        n,
        tieCt === null
          ? null
          : (m) =>
              ctx.db
                .query('comments')
                .withIndex('by_author_deleted', (q) =>
                  q.eq('authorId', userId).eq('authorDeletedAt', key).lt('_creationTime', tieCt),
                )
                .order('desc')
                .take(m),
        (m) =>
          ctx.db
            .query('comments')
            .withIndex('by_author_deleted', (q) =>
              bound(
                q.eq('authorId', userId).gt('authorDeletedAt', 0) as never,
                'authorDeletedAt' as never,
              ),
            )
            .order('desc')
            .take(m),
      );
    case 'hazard':
      return takeAfter(
        reads,
        kind,
        n,
        tieCt === null
          ? null
          : (m) =>
              ctx.db
                .query('hazards')
                .withIndex('by_author_deleted', (q) =>
                  q
                    .eq('createdByUserId', userId)
                    .eq('authorDeletedAt', key)
                    .lt('_creationTime', tieCt),
                )
                .order('desc')
                .take(m),
        (m) =>
          ctx.db
            .query('hazards')
            .withIndex('by_author_deleted', (q) =>
              bound(
                q.eq('createdByUserId', userId).gt('authorDeletedAt', 0) as never,
                'authorDeletedAt' as never,
              ),
            )
            .order('desc')
            .take(m),
      );
    case 'accessAlert':
      return takeAfter(
        reads,
        kind,
        n,
        tieCt === null
          ? null
          : (m) =>
              ctx.db
                .query('accessAlerts')
                .withIndex('by_author_retracted', (q) =>
                  q
                    .eq('createdByUserId', userId)
                    .eq('retractedByUserId', userId)
                    .eq('retractedAt', key)
                    .lt('_creationTime', tieCt),
                )
                .order('desc')
                .take(m),
        (m) =>
          ctx.db
            .query('accessAlerts')
            .withIndex('by_author_retracted', (q) =>
              bound(
                q
                  .eq('createdByUserId', userId)
                  .eq('retractedByUserId', userId)
                  .gt('retractedAt', 0) as never,
                'retractedAt' as never,
              ),
            )
            .order('desc')
            .take(m),
      );
  }
}

/** A withdrawn row's key in the merged order. */
export function deletedKey(kind: VerdictTargetType, doc: RecordContentDoc): Position {
  return {
    key: withdrawnAt(kind, doc) ?? 0,
    ct: doc._creationTime,
    kind: DELETED_KINDS.indexOf(kind),
  };
}

/** Whether `a` comes before `b` in the merged order (withdrawal desc, kind, creation desc). */
export function before(a: Position, b: Position): boolean {
  if (a.key !== b.key) return a.key > b.key;
  if ((a.kind ?? 0) !== (b.kind ?? 0)) return (a.kind ?? 0) < (b.kind ?? 0);
  return a.ct > b.ct;
}
