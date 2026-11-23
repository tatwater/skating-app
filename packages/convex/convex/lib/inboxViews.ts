/**
 * **What the Inbox's reads draw** (B01-5): every row's label facts and every item's handler facts,
 * resolved at read from the stored item, its members and their sources — so a rename never leaves a
 * row stale. Names are real names (D287's fake people included); nothing here says or implies a word
 * about the ice beyond what a report itself claims (D3).
 *
 * Every point read goes through {@link InboxReader}: memoized (a body or a person named twice on a
 * page is read once) and charged to the request's `ReadBudget` at its real weight, started only while
 * its table's worst case still fits (`measured`) — so a page of rows can never read past the
 * transaction's limit; a read the budget can't start answers `null`.
 */

import {
  COUNT_CAP,
  type Count,
  HAZARD_VERDICTS,
  type HazardVerdict,
  haversineMeters,
  INBOX_AGE_FLOORS_DAYS,
  INBOX_FACETS,
  INBOX_LANE_ORDER,
  INBOX_LANES,
  type LatLng,
  medianOpenedAt,
  type RequestKind,
  restrictionsOf,
} from '@skating/core';
import { getDocumentSize } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type {
  AlertSubjectView,
  AskerLandmarksView,
  AskMemberView,
  AuthorBlockView,
  BodyRefView,
  CandidateView,
  DormancyView,
  DrawnSkateView,
  FlagMemberView,
  FlagTargetView,
  HazardSubjectView,
  InboxDecidedState,
  InboxItemView,
  InboxMapAccessPoint,
  InboxMapBody,
  InboxMapLngLat,
  InboxMapTrack,
  InboxMapView,
  InboxRowView,
  LookalikeView,
  OverlapView,
  PersonLockupView,
  PersonRefView,
  PhotoSubjectView,
  ReportClaimsView,
  ReportRefView,
  ReportSubjectView,
  RulingView,
  SupportMessageView,
  TicketRelatedFlagView,
  TicketView,
} from '../inbox';
import { planPostRestore } from '../moderation';
import { NEIGHBOR_RING_POINTS, simplifiedRing } from './bodyGeo';
import { heldKindOn, type VerdictTargetType } from './contentVerdicts';
import { inboxPending, MAX_MEMBERS, readCount } from './inboxItems';
import { MAP_OUTLINE_BYTES, MAP_RING_POINTS } from './inboxMapBounds';
import {
  type AlongsideAnswer,
  type DrawnSurvivor,
  drawnMergeFacts,
  drawnSurvivorOf,
  type InboxRuleFacts,
  liveSurvivorOf,
} from './inboxRules';
import { liveLandmarksForBody } from './landmarkRows';
import { OPEN_FLAG_STATUSES } from './openFlags';
import { photoVisible, photoWithdrawalRow } from './photoAccess';
import { SAME_BYTES_MAX } from './photoFiles';
import {
  CHARGED_QUERY_BUDGET,
  OverBudget,
  type ReadBudget,
  ROW_MAX,
  type RowKind,
  requestBudget,
} from './readBudget';
import { type RecordFacts, recordFactsOf } from './recordRules';
import { trustClassFor } from './reputation';
import {
  alongsideAnswer,
  type DecisionAnswer,
  drawnBay,
  landmarkAskOf,
  landmarkProposalView,
  matchLandmark,
  ownAsks,
  requestNames,
} from './requestDecisions';
import {
  NOT_A_NOTE_REFUSAL,
  replyBlockedOf,
  supportUndoRefusal,
  THREAD_MESSAGES,
} from './supportThread';

/** `Omit` over each member of a union, so a variant keeps its own fields. */
export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Members an item's view lists at most, of each status. */
export const VIEW_MEMBERS = 50;
/** An Access row's newest reports read for the newest note among them. */
export const LATEST_NOTE_READ = 5;
/** A person's open flags counted at most on their author block. */
const AUTHOR_FLAGS_CAP = 50;

/** Memoized point reads, charged at their real weight to the request's budget. */
export class InboxReader {
  private readonly memo = new Map<string, Promise<unknown>>();
  constructor(
    readonly ctx: QueryCtx,
    readonly budget: ReadBudget,
    readonly now: number,
    readonly viewerId: Id<'profiles'>,
    /** The viewer reads hidden and removed content in full (`content.read`, D205, D225). */
    readonly canReadContent: boolean,
  ) {}

  /** A hidden or removed row's text, only to a viewer who may read it; else `null`. */
  text(doc: { moderationStatus?: string }, value: string | undefined | null): string | null {
    const down = doc.moderationStatus === 'hidden' || doc.moderationStatus === 'removed';
    return down && !this.canReadContent ? null : (value ?? null);
  }

  get<T extends TableNames>(kind: RowKind, id: Id<T> | null | undefined): Promise<Doc<T> | null> {
    if (!id) return Promise.resolve(null);
    const key = id as string;
    let read = this.memo.get(key) as Promise<Doc<T> | null> | undefined;
    if (read === undefined) {
      read = this.budget.measured(kind, () => this.ctx.db.get(id)).then((r) => r ?? null);
      this.memo.set(key, read);
    }
    return read;
  }

  /** Any read the item makes once, memoized by `key` (the read charges the budget itself). */
  once<T>(key: string, read: () => Promise<T>): Promise<T> {
    let hit = this.memo.get(key) as Promise<T> | undefined;
    if (hit === undefined) {
      hit = read();
      this.memo.set(key, hit);
    }
    return hit;
  }

  /**
   * **A single row the item can't do without** — an attribution, a fact a lever or a verdict rests on
   * (B01-5c): read as `get` reads it, but a budget that can't hold it throws `OverBudget` (a plan
   * error) instead of answering `null`, which would read as "no such row" — a ruling by no one, a
   * moderator's shelving as the machine's. Such rows are read before any list that fills the budget,
   * so on a fresh budget this never throws; a throw says the plan is wrong, loudly.
   */
  async must<T extends TableNames>(
    kind: RowKind,
    id: Id<T> | null | undefined,
  ): Promise<Doc<T> | null> {
    if (id && !this.memo.has(id as string) && !this.budget.affordsRead(kind)) {
      throw new OverBudget(`inbox item: a required ${kind} row past the item's budget`);
    }
    return this.get<T>(kind, id);
  }

  /** Up to `n` rows of `kind`, charged at their worst — or none when they don't fit. */
  async take<T>(kind: RowKind, n: number, read: (n: number) => Promise<T[]>): Promise<T[]> {
    const k = this.budget.rows(kind, n);
    return k > 0 ? this.budget.take(kind, k, read) : [];
  }

  /**
   * An item's members of one status: the oldest `n`, oldest first — or, `newest`, the newest `n`,
   * newest first (a read labeled by its newest end must read from that end, PR #170).
   */
  members(
    itemId: Id<'inboxItems'>,
    status: 'open' | 'closed',
    n = VIEW_MEMBERS,
    end: 'oldest' | 'newest' = 'oldest',
  ) {
    return this.take('inboxMember', n, (k) =>
      this.ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', status))
        .order(end === 'newest' ? 'desc' : 'asc')
        .take(k),
    );
  }
}

// ── People and bodies ──────────────────────────────────────────────────────────────────────────

const gone = (p: Doc<'profiles'>) => p.status === 'deleted' || p.deletionRequestedAt !== undefined;

export function personRef(p: Doc<'profiles'> | null): PersonRefView | null {
  if (!p) return null;
  return {
    userId: p._id,
    displayName: p.displayName,
    username: gone(p) ? '' : p.username,
    deleted: gone(p),
    isStaff: p.role === 'moderator' || p.role === 'admin',
  };
}

export function personLockup(p: Doc<'profiles'> | null, now: number): PersonLockupView | null {
  const ref = personRef(p);
  if (!ref || !p) return null;
  return {
    ...ref,
    role: p.role,
    trustClass: gone(p) ? null : trustClassFor(p, now),
    points: p.reputationPoints,
  };
}

export function bodyRef(b: Doc<'waterBodies'> | null): BodyRefView | null {
  if (!b) return null;
  return {
    waterBodyId: b._id,
    name: b.name,
    place: b.states && b.states.length > 0 ? b.states.join(', ') : null,
    type: b.type,
    areaSqM: b.surfaceAreaSqM ?? null,
    removed: b.removedAt !== undefined,
    point: b.representativePoint ?? b.centroid ?? null,
  };
}

/** 2.1's author block: the person and their standing at a glance. */
export async function authorBlock(
  r: InboxReader,
  userId: Id<'profiles'> | null | undefined,
): Promise<AuthorBlockView | null> {
  const p = await r.get<'profiles'>('profile', userId);
  const person = personLockup(p, r.now);
  if (!p || !person) return null;
  const suspended =
    p.status === 'suspended' && (p.suspendedUntil === undefined || p.suspendedUntil > r.now);
  const status: AuthorBlockView['standing']['status'] =
    p.status === 'deleted'
      ? 'deleted'
      : p.deletionRequestedAt !== undefined
        ? 'leaving'
        : p.status === 'banned'
          ? 'banned'
          : suspended
            ? 'suspended'
            : 'active';
  const flags = await r.take('contentFlag', AUTHOR_FLAGS_CAP + 1, (k) =>
    r.ctx.db
      .query('contentFlags')
      .withIndex('by_subject_status', (q) => q.eq('subjectUserId', p._id).eq('status', 'open'))
      .take(k),
  );
  const openFlags: Count = {
    count: Math.min(flags.length, AUTHOR_FLAGS_CAP),
    capped: flags.length > AUTHOR_FLAGS_CAP,
  };
  const actioned = await r.take('contentFlag', PRIOR_ACTIONED_CAP + 1, (k) =>
    r.ctx.db
      .query('contentFlags')
      .withIndex('by_subject_status', (q) => q.eq('subjectUserId', p._id).eq('status', 'actioned'))
      .order('desc')
      .take(k),
  );
  const { reports, contradictedReports } = await authoredReports(r, p._id);
  return {
    person,
    standing: { status, until: suspended ? (p.suspendedUntil ?? null) : null, by: null },
    reports,
    contradicted: { count: p.contradictionCount ?? 0, capped: false },
    contradictedReports,
    priorActioned: {
      count: Math.min(actioned.length, PRIOR_ACTIONED_CAP),
      capped: actioned.length > PRIOR_ACTIONED_CAP,
      lastAt: actioned[0]?.resolvedAt ?? null,
    },
    openFlags,
    restrictions: restrictionsOf(p),
  };
}

/** Earlier actioned flags counted at most. */
const PRIOR_ACTIONED_CAP = 50;
/** An author's newest reports read for their count and their contradicted ones. */
const AUTHORED_SCAN = 100;
/** Contradicted reports listed at most. */
const CONTRADICTED_LIST = 10;

/**
 * An author's visible reports and their settled contradictions, among their newest {@link
 * AUTHORED_SCAN} by skate end — each report started only while one more fits the budget and charged
 * its real weight; `capped` when the scan stopped short of their last report.
 */
async function authoredReports(
  r: InboxReader,
  authorId: Id<'profiles'>,
): Promise<{ reports: Count; contradictedReports: ReportRefView[] }> {
  let visible = 0;
  let scanned = 0;
  let capped = false;
  const contradicted: ReportRefView[] = [];
  const author = personRef(await r.get<'profiles'>('profile', authorId));
  const rows = r.ctx.db
    .query('reports')
    .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', authorId))
    .order('desc');
  // The next row is pulled only once it fits the budget, and charged whatever becomes of it — the one
  // past the scan's bound too, read only to learn there is more.
  const reports = rows[Symbol.asyncIterator]();
  for (;;) {
    if (!r.budget.affordsRead('report')) {
      capped = true;
      break;
    }
    const next = await reports.next();
    if (next.done) break;
    const rep = next.value;
    r.budget.reserveCalls(0, 1);
    r.budget.spend(getDocumentSize(rep));
    if (scanned >= AUTHORED_SCAN) {
      capped = true;
      break;
    }
    scanned++;
    if (rep.moderationStatus === 'visible') visible++;
    if (rep.contradiction === true && contradicted.length < CONTRADICTED_LIST) {
      contradicted.push({
        reportId: rep._id,
        skateEndTime: rep.skateEndTime,
        author,
        observedFrom: rep.observedFrom ?? null,
      });
    }
  }
  return { reports: { count: visible, capped }, contradictedReports: contradicted };
}

// ── Reports and the flagged things ─────────────────────────────────────────────────────────────

export function claimsOf(report: Doc<'reports'>): ReportClaimsView {
  return {
    iceThickness: report.iceThickness ?? null,
    iceTypes: report.iceTypes,
    surfaceTags: report.surfaceTags,
    sightings: report.sightings ?? [],
    suitability: report.suitability ?? null,
    skateQuality: report.skateQuality ?? null,
    snow: report.snow ?? null,
  };
}

export function placeOf(report: Pick<Doc<'reports'>, 'place'>): string | null {
  const p = report.place;
  if (!p) return null;
  const parts = [p.town, p.state].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** A report's photos a viewer without `content.read` has counted, at most (each row read). */
export const REPORT_PHOTO_COUNT_READ = 12;

/**
 * A report's photo count as this viewer may know it (B01-5e): every photo for `content.read`; for
 * anyone else the visible ones (`photoVisible`), among the first {@link REPORT_PHOTO_COUNT_READ} —
 * there is no cap on a report's photos, so past that it is a floor, said so.
 */
async function reportPhotoCount(
  r: InboxReader,
  report: Doc<'reports'>,
): Promise<{ photoCount: number; photoCountIsFloor: boolean }> {
  if (r.canReadContent) return { photoCount: report.photoIds.length, photoCountIsFloor: false };
  let visible = 0;
  let read = 0;
  for (const id of report.photoIds.slice(0, REPORT_PHOTO_COUNT_READ)) {
    if (!r.budget.affordsRead('photo')) break;
    const photo = await r.get<'photos'>('photo', id);
    read++;
    if (photo && photoVisible(photo)) visible++;
  }
  return { photoCount: visible, photoCountIsFloor: read < report.photoIds.length };
}

async function reportSubject(
  r: InboxReader,
  report: Doc<'reports'>,
): Promise<ReportSubjectView | null> {
  const body = bodyRef(await r.get<'waterBodies'>('waterBody', report.waterBodyId));
  if (!body) return null;
  return {
    reportId: report._id,
    body,
    point: report.point,
    place: placeOf(report),
    skateStartTime: report.skateStartTime ?? null,
    skateEndTime: report.skateEndTime,
    observedFrom: report.observedFrom ?? null,
    notes: r.text(report, report.notes),
    claims: claimsOf(report),
    ...(await reportPhotoCount(r, report)),
    moderationStatus: report.moderationStatus,
    ratings: null,
    corroborations: await corroborationsOf(r, report._id),
  };
}

/** Corroborations counted at most. */
const CORROBORATIONS_CAP = 50;

/** How many other skaters' reports agreed with this one: its `report_corroborated` ledger rows. */
async function corroborationsOf(r: InboxReader, reportId: Id<'reports'>): Promise<Count> {
  const rows = await r.take('small', CORROBORATIONS_CAP + 1, (k) =>
    r.ctx.db
      .query('pointEvents')
      .withIndex('by_ref', (q) => q.eq('refId', reportId))
      .take(k),
  );
  const agreed = rows.filter((e) => e.reason === 'report_corroborated');
  return {
    count: Math.min(agreed.length, CORROBORATIONS_CAP),
    capped: rows.length > CORROBORATIONS_CAP,
  };
}

function snippet(text: string | undefined | null): string {
  const t = (text ?? '').trim();
  return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}

const TARGET_TABLE = {
  report: ['reports', 'report'],
  post: ['posts', 'post'],
  comment: ['comments', 'comment'],
  hazard: ['hazards', 'hazard'],
  photo: ['photos', 'photo'],
  accessAlert: ['accessAlerts', 'accessAlert'],
  waterbody: ['waterBodies', 'waterBody'],
  user: ['profiles', 'profile'],
} as const satisfies Record<Doc<'contentFlags'>['targetType'], readonly [TableNames, RowKind]>;

/** A flag's target doc, if it is still there. */
export async function targetDocOf(
  r: InboxReader,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
) {
  const [table, kind] = TARGET_TABLE[targetType];
  const id = r.ctx.db.normalizeId(table, targetId);
  return id ? r.get(kind, id) : null;
}

/** The short label a row shows of a flag's target, and its moderation status. */
export async function targetLabel(
  r: InboxReader,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
) {
  const doc = (await targetDocOf(r, targetType, targetId)) as Record<string, unknown> | null;
  if (!doc)
    return {
      exists: false,
      summary: '(deleted)',
      moderationStatus: null,
      withdrawnAt: null,
      withdrawal: null,
    };
  const status = (doc.moderationStatus as 'visible' | 'hidden' | 'removed' | undefined) ?? null;
  // Withdrawn by its author (deleted, or erased): not up, whatever its moderation status says.
  const erasedAt = doc.erasedAt as number | undefined;
  const deletedAt = doc.authorDeletedAt as number | undefined;
  const withdrawnAt = erasedAt ?? deletedAt ?? null;
  const withdrawal: 'deleted' | 'erased' | null =
    erasedAt !== undefined ? 'erased' : deletedAt !== undefined ? 'deleted' : null;
  // Down content's words go only to a viewer who may read them.
  if ((status === 'hidden' || status === 'removed') && !r.canReadContent) {
    return { exists: true, summary: '', moderationStatus: status, withdrawnAt, withdrawal };
  }
  const summary = (() => {
    switch (targetType) {
      case 'report':
        return snippet(doc.notes as string) || 'Ice report';
      case 'post':
        return (doc.title as string) || snippet(doc.body as string) || 'Post';
      case 'comment':
        return snippet(doc.body as string) || 'Comment';
      case 'hazard':
        return `Hazard: ${doc.type as string}`;
      case 'photo':
        return snippet(doc.caption as string) || 'Photo';
      case 'accessAlert':
        return snippet(doc.note as string) || `Access alert: ${doc.reason as string}`;
      case 'waterbody':
        return (doc.name as string) || 'Unnamed water body';
      case 'user':
        return (doc.displayName as string) || 'Person';
    }
  })();
  return { exists: true, summary, moderationStatus: status, withdrawnAt, withdrawal };
}

/** The flagged content whose takedown and restore go through `setContentStatus`. */
const RECORD_TARGETS = {
  report: true,
  post: true,
  comment: true,
  hazard: true,
  photo: true,
} as const;
type RecordTarget = keyof typeof RECORD_TARGETS;
type RecordDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'> | Doc<'photos'>;

/**
 * When a photo's uploader withdrew it (`lib/photoAccess.photoWithdrawnAt`), read through the item's
 * budget once (memoized) — the photo subject and the record's facts ask the same row.
 */
function photoWithdrawnOf(r: InboxReader, photoId: Id<'photos'>): Promise<number | null> {
  return r.once(`withdrawn:${photoId}`, async () => {
    if (!r.budget.affordsRead('moderationAction')) {
      throw new OverBudget('inbox item: a photo withdrawal row past the item budget');
    }
    const row = await r.budget.measured('moderationAction', () =>
      photoWithdrawalRow(r.ctx, photoId),
    );
    return row?.createdAt ?? null;
  });
}

/** An open flag on a photo, by a point read per open status (the Inbox ref `flag:<id>` opens its item). */
async function openFlagOnPhoto(
  r: InboxReader,
  photoId: Id<'photos'>,
): Promise<Id<'contentFlags'> | null> {
  for (const status of OPEN_FLAG_STATUSES) {
    const [open] = await r.take('contentFlag', 1, (k) =>
      r.ctx.db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q.eq('targetType', 'photo').eq('targetId', photoId).eq('status', status),
        )
        .take(k),
    );
    if (open) return open._id;
  }
  return null;
}

/**
 * The photos that show this photo's bytes too (B01-5e): those its rotation recorded as holding a
 * shared file (`sameBytesAs`), and any row naming one of its current files in either slot — each read
 * through the item's budget, at most {@link SAME_BYTES_MAX} (`sameBytesCut` past them). Each with its
 * status, its open flag (the Inbox ref that opens its item) and its report; never its uploader, nor
 * an image of it.
 */
async function sameBytesOf(
  r: InboxReader,
  p: Doc<'photos'>,
): Promise<Pick<PhotoSubjectView, 'sameBytesAs' | 'sameBytesCut'>> {
  // The swap's read, through the item's budget: the recorded twins, then the rows still naming this
  // photo's files — each range two past the cap, since the photo itself may be one of them.
  const ids = new Set<Id<'photos'>>(p.sameBytesAs ?? []);
  if (p.purgedAt === undefined) {
    for (const id of new Set([p.storageId, p.thumbStorageId])) {
      for (const field of ['storageId', 'thumbStorageId'] as const) {
        if (ids.size > SAME_BYTES_MAX) break;
        const rows = await r.take('photo', SAME_BYTES_MAX + 2, (k) =>
          r.ctx.db
            .query('photos')
            .withIndex(field === 'storageId' ? 'by_storage' : 'by_thumb_storage', (q) =>
              q.eq(field as never, id as never),
            )
            .take(k),
        );
        for (const row of rows) if (row._id !== p._id) ids.add(row._id);
      }
    }
  }
  // The first eight that still exist; cut when a ninth does, or the swap's read proved more.
  const out: PhotoSubjectView['sameBytesAs'] = [];
  let cut = p.sameBytesCut === true;
  for (const id of ids) {
    const twin = await r.get<'photos'>('photo', id);
    if (!twin) continue;
    if (out.length === SAME_BYTES_MAX) {
      cut = true;
      break;
    }
    out.push({
      photoId: twin._id,
      moderationStatus: twin.moderationStatus ?? 'visible',
      openFlagId: await openFlagOnPhoto(r, twin._id),
      reportId: twin.reportId ?? null,
    });
  }
  return { sameBytesAs: out, sameBytesCut: cut };
}

/** *On the same report*, at most this many of the report's other photos (board 2.7's strip). */
export const PHOTO_SIBLINGS_READ = 12;

/**
 * **Board 2.7's *On the same report*** — the report's other photos, in its order, at most
 * {@link PHOTO_SIBLINGS_READ} (`siblingsCut` past it): there is no cap on a report's photos but
 * Convex's array limit, so the strip is bounded on its own. Each photo row is read through the item's
 * budget; a thumbnail URL only to a viewer with `content.read`, as the stage's. Filled after the
 * item's required rows (the target, its author), so it can't crowd them out.
 */
export async function photoSiblings(
  r: InboxReader,
  photo: PhotoSubjectView,
): Promise<Pick<PhotoSubjectView, 'siblings' | 'siblingsCut'>> {
  if (photo.reportId === null) return { siblings: [], siblingsCut: false };
  const report = await r.get<'reports'>('report', photo.reportId);
  if (!report) return { siblings: [], siblingsCut: false };
  const others = report.photoIds.filter((id) => id !== photo.photoId);
  const siblings: PhotoSubjectView['siblings'] = [];
  for (const id of others.slice(0, PHOTO_SIBLINGS_READ)) {
    if (!r.budget.affordsRead('photo')) break;
    const sib = await r.get<'photos'>('photo', id);
    if (!sib) continue;
    const openFlagId = await openFlagOnPhoto(r, sib._id);
    siblings.push({
      photoId: sib._id,
      openFlagId,
      thumbUrl:
        r.canReadContent && sib.purgedAt === undefined
          ? await r.ctx.storage.getUrl(sib.thumbStorageId)
          : null,
      moderationStatus: sib.moderationStatus ?? 'visible',
    });
  }
  return {
    siblings,
    siblingsCut: others.length > siblings.length,
  };
}

/**
 * A content row's record facts, read exactly as `setContentStatus` reads them before a takedown or a
 * restore: the decision standing on it, and for a Post its restore plan and how many of its Reports
 * are up — so the item's Hide, Remove and Restore answer what the write would.
 */
async function recordOf(
  r: InboxReader,
  targetType: RecordTarget,
  doc: RecordDoc,
): Promise<RecordFacts> {
  r.budget.reserve('verdict', 1);
  const held = await heldKindOn(r.ctx, targetType, doc._id);
  if (targetType === 'photo') {
    // A photo's uploader withdrawal is on its audit rows, read as `setContentStatus` reads it.
    const withdrawnAt = await photoWithdrawnOf(r, doc._id as Id<'photos'>);
    return recordFactsOf('photo', doc, held, { photoWithdrawn: withdrawnAt !== null });
  }
  if (targetType !== 'post') return recordFactsOf(targetType, doc, held);
  const post = doc as Doc<'posts'>;
  // Its restore plan reads each member Report and its newest row, and the count below each Report
  // again: reserved whole before any is read — or, when the budget can't hold that (Reports carry
  // uncapped notes), left out: the plan is absent, and the restore's write decides by the same rule.
  const n = post.reportIds.length;
  if (
    !r.budget.affords((2 * ROW_MAX.report + ROW_MAX.moderationAction) * n) ||
    !r.budget.affordsCalls(2, 3 * n)
  ) {
    return recordFactsOf('post', post, held);
  }
  r.budget.reserve('report', 2 * n);
  r.budget.reserve('moderationAction', n);
  const plan = await planPostRestore(r.ctx, post, {});
  let up = 0;
  for (const id of post.reportIds) {
    if ((await r.ctx.db.get(id))?.moderationStatus === 'visible') up++;
  }
  return recordFactsOf('post', post, held, { plan, up });
}

async function flagTargetView(
  r: InboxReader,
  flag: Doc<'contentFlags'>,
): Promise<{ view: FlagTargetView; facts: InboxRuleFacts }> {
  const { targetType, targetId } = flag;
  const doc = await targetDocOf(r, targetType, targetId);
  const content = targetType in RECORD_TARGETS;
  if (!doc)
    return {
      view: { targetType, targetId, exists: false },
      facts: {
        targetType,
        targetStatus: null,
        ...(content ? { record: recordFactsOf(targetType as VerdictTargetType, null, null) } : {}),
      },
    };
  const label = await targetLabel(r, targetType, targetId);
  const base = {
    targetId,
    exists: true as const,
    summary: label.summary,
    moderationStatus: label.moderationStatus,
    withdrawnAt: label.withdrawnAt,
    withdrawal: label.withdrawal,
  };
  const facts: InboxRuleFacts = {
    targetType,
    targetStatus: label.moderationStatus,
    ...(content ? { record: await recordOf(r, targetType as RecordTarget, doc as RecordDoc) } : {}),
  };
  switch (targetType) {
    case 'report': {
      const report = await reportSubject(r, doc as Doc<'reports'>);
      if (!report)
        return {
          view: { targetType, targetId, exists: false },
          facts: { targetType, targetStatus: null },
        };
      return { view: { ...base, targetType, report }, facts };
    }
    case 'post': {
      const post = doc as Doc<'posts'>;
      const reports: ReportSubjectView[] = [];
      for (const id of post.reportIds.slice(0, 5)) {
        const rep = await r.get<'reports'>('report', id);
        const view = rep ? await reportSubject(r, rep) : null;
        if (view) reports.push(view);
      }
      return {
        view: {
          ...base,
          targetType,
          post: {
            postId: post._id,
            title: r.text(post, post.title),
            body: r.text(post, post.body),
            reports,
          },
        },
        facts,
      };
    }
    case 'comment': {
      const c = doc as Doc<'comments'>;
      const on = await r.get<'reports'>('report', c.reportId);
      return {
        view: {
          ...base,
          targetType,
          comment: {
            commentId: c._id,
            body: r.text(c, c.body) ?? '',
            createdAt: c._creationTime,
            on: {
              reportId: c.reportId,
              postId: on?.postId ?? null,
              head: on ? snippet(on.notes) || 'Ice report' : null,
            },
          },
        },
        facts,
      };
    }
    case 'hazard': {
      const h = doc as Doc<'hazards'>;
      const votes = await r.take('small', HAZARD_VOTES_READ + 1, (k) =>
        r.ctx.db
          .query('hazardConfirmations')
          .withIndex('by_hazard', (q) => q.eq('hazardId', h._id))
          .take(k),
      );
      // Each verdict counted as itself (PR #170): "never existed" is not "still there".
      const byVerdict = Object.fromEntries(HAZARD_VERDICTS.map((v) => [v, 0])) as Record<
        HazardVerdict,
        number
      >;
      for (const v of votes.slice(0, HAZARD_VOTES_READ)) byVerdict[v.verdict] += 1;
      const geometry = h.geometry as { type?: string; coordinates?: number[] };
      const point: LatLng | null =
        geometry?.type === 'Point' && Array.isArray(geometry.coordinates)
          ? { lat: geometry.coordinates[1] as number, lng: geometry.coordinates[0] as number }
          : null;
      const hazard: HazardSubjectView = {
        hazardId: h._id,
        body: bodyRef(await r.get<'waterBodies'>('waterBody', h.waterBodyId)),
        type: h.type,
        note: r.text(h, h.description),
        point,
        createdAt: h._creationTime,
        votes: byVerdict,
        votesCapped: votes.length > HAZARD_VOTES_READ,
      };
      return { view: { ...base, targetType, hazard }, facts };
    }
    case 'photo': {
      // Board 2.7's stage (B01-5e). The report it documents and that report's body are rows the
      // stage rests on — read first, required (`must`); *On the same report* is a list, filled after
      // the item's author (`photoSiblings`, from `itemView`). The bytes' URLs go only to a viewer
      // with `content.read`, on the server — the photo subject's rule and `photos.getUrls`' are one.
      const p = doc as Doc<'photos'>;
      const report = p.reportId ? await r.must<'reports'>('report', p.reportId) : null;
      const body = report
        ? bodyRef(await r.must<'waterBodies'>('waterBody', report.waterBodyId))
        : null;
      const withdrawnAt = await photoWithdrawnOf(r, p._id);
      // A purged photo's tombstone serves no address, whatever storage still holds (D222).
      const staff = r.canReadContent;
      const bytes = staff && p.purgedAt === undefined;
      const status = p.moderationStatus ?? 'visible';
      const photo: PhotoSubjectView = {
        photoId: p._id,
        caption: staff || status === 'visible' ? (p.caption ?? null) : null,
        takenAt: p.takenAt ?? null,
        createdAt: p.createdAt,
        thumbUrl: bytes ? await r.ctx.storage.getUrl(p.thumbStorageId) : null,
        reportId: p.reportId ?? null,
        body,
        siblings: [],
        siblingsCut: false,
        indexOnReport: report ? report.photoIds.indexOf(p._id) : null,
        photoCount: report ? report.photoIds.length : null,
        moderationStatus: status,
        moderatedAt: p.moderatedAt ?? null,
        canReveal: staff,
        withdrawnAt,
        purgeAt: p.purgeAt ?? null,
        purgedAt: p.purgedAt ?? null,
        bytesMissingAt: p.bytesMissingAt ?? null,
        ...(await sameBytesOf(r, p)),
      };
      return {
        view: {
          ...base,
          // An uploader's withdrawal of a held photo, or its purge: no longer up (the stored row says
          // which, as a deleted or erased comment's does).
          withdrawnAt: p.purgedAt ?? withdrawnAt ?? base.withdrawnAt,
          withdrawal: p.purgedAt !== undefined ? 'erased' : withdrawnAt !== null ? 'deleted' : null,
          targetType,
          photo,
        },
        facts: { ...facts, targetStatus: status },
      };
    }
    case 'accessAlert': {
      const a = doc as Doc<'accessAlerts'>;
      const place = a.putInId
        ? await r.get<'putIns'>('putIn', a.putInId)
        : a.parkingAreaId
          ? await r.get<'parkingAreas'>('putIn', a.parkingAreaId)
          : null;
      // A put-in and a lot both store where they are as `coord`.
      const placeDoc = place as { name?: string; coord?: LatLng } | null;
      const life: AlertSubjectView['life'] = [
        {
          at: a.createdAt,
          event: 'posted',
          by: personRef(await r.get<'profiles'>('profile', a.createdByUserId)),
        },
      ];
      if (a.pinnedByUserId)
        life.push({
          at: a.createdAt,
          event: 'pinned',
          by: personRef(await r.get<'profiles'>('profile', a.pinnedByUserId)),
        });
      if (a.lastConfirmedAt) life.push({ at: a.lastConfirmedAt, event: 'confirmed', by: null });
      life.push({ at: flag.createdAt, event: 'flagged', by: null });
      if (a.retractedAt)
        life.push({
          at: a.retractedAt,
          event: 'retracted',
          by: personRef(await r.get<'profiles'>('profile', a.retractedByUserId)),
        });
      life.sort((x, y) => x.at - y.at);
      const body = bodyRef(await r.get<'waterBodies'>('waterBody', a.waterBodyId));
      if (!body)
        return {
          view: { targetType, targetId, exists: false },
          facts: { targetType, alert: null },
        };
      const alert: AlertSubjectView = {
        accessAlertId: a._id,
        body,
        place: {
          name: placeDoc?.name ?? null,
          point: placeDoc?.coord ?? null,
          targetType: a.targetType,
        },
        reason: a.reason,
        kind: a.kind,
        note: a.note ?? null,
        status: a.status,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt ?? null,
        pinnedBy: personRef(await r.get<'profiles'>('profile', a.pinnedByUserId)),
        confirmCount: a.confirmCount,
        denyCount: a.denyCount,
        lastConfirmedAt: a.lastConfirmedAt ?? null,
        life,
      };
      return {
        view: { ...base, targetType, alert },
        facts: { targetType, alert: { status: a.status, pinned: a.pinnedByUserId !== undefined } },
      };
    }
    case 'waterbody': {
      const body = bodyRef(doc as Doc<'waterBodies'>);
      if (!body) return { view: { targetType, targetId, exists: false }, facts };
      return { view: { ...base, targetType, body }, facts };
    }
    case 'user': {
      const person = await authorBlock(r, (doc as Doc<'profiles'>)._id);
      if (!person) return { view: { targetType, targetId, exists: false }, facts };
      return { view: { ...base, targetType, person }, facts };
    }
  }
}

/**
 * **Members read one at a time, each whole or not at all** (B01-5c). A member's reads go through the
 * reader's budget, which starts a read only while that row's worst case fits and otherwise reads
 * nothing (`ReadBudget.measured` — `null`, as for a row that's gone). Started together, each read
 * reserves its worst case at once, so past about a budget's worth of documents the rest read nothing
 * and their members vanished without a word; and a member whose row fit but whose person didn't came
 * back half-read. So each member is started only while its whole worst case (`worst`: every row it
 * reads, at its bound) fits, one after another; when the next doesn't, the list ends there and says
 * `cut`. A member whose row is really gone is still left out, as before.
 */
async function readEach<T>(
  r: InboxReader,
  members: readonly Doc<'inboxItemMembers'>[],
  worst: number,
  member: (m: Doc<'inboxItemMembers'>) => Promise<T | null>,
): Promise<{ rows: T[]; cut: boolean }> {
  const rows: T[] = [];
  for (const m of members) {
    if (!r.budget.affords(worst) || !r.budget.affordsCalls(MEMBER_READS, MEMBER_READS)) {
      return { rows, cut: true };
    }
    const row = await member(m);
    if (row !== null) rows.push(row);
  }
  return { rows, cut: false };
}

/** The dismissed access reports an Access item reads to find those its ruling dismissed. */
export const DISMISSED_BY_RULING_READ = 20;

/** The most rows one member reads: its source, a related row (a report, a prior flag), a person. */
const MEMBER_READS = 3;
/** A flag member at its worst: the flag and the one it supersedes (capped notes), and its filer. */
const FLAG_MEMBER_WORST = 2 * ROW_MAX.contentFlag + ROW_MAX.profile;
/** An ask member at its worst: the ask (an admit's catalog polygon), its report, and its asker. */
const ASK_MEMBER_WORST = ROW_MAX.waterBodyRequest + ROW_MAX.report + ROW_MAX.profile;

async function flagMember(
  r: InboxReader,
  m: Doc<'inboxItemMembers'>,
): Promise<FlagMemberView | null> {
  const f = await r.get<'contentFlags'>('contentFlag', m.sourceId as Id<'contentFlags'>);
  if (!f) return null;
  const prior = f.supersedesFlagId
    ? await r.get<'contentFlags'>('contentFlag', f.supersedesFlagId)
    : null;
  const auto = f.origin !== 'user';
  return {
    flagId: f._id,
    reason: f.reason,
    note: f.note ?? null,
    filedAt: f.createdAt,
    status: m.status,
    filer: auto ? null : personLockup(await r.get<'profiles'>('profile', f.flaggerId), r.now),
    autoFiled: auto,
    occurrences: f.occurrences ?? 1,
    lastOccurrenceAt: f.lastOccurrenceAt ?? null,
    prior:
      prior?.resolvedAt !== undefined
        ? { resolvedAt: prior.resolvedAt, resolution: prior.status }
        : null,
  };
}

async function askMember(
  r: InboxReader,
  m: Doc<'inboxItemMembers'>,
): Promise<{ view: AskMemberView; doc: Doc<'waterBodyRequests'> } | null> {
  const a = await r.get<'waterBodyRequests'>(
    'waterBodyRequest',
    m.sourceId as Id<'waterBodyRequests'>,
  );
  if (!a) return null;
  const report = a.reportId ? await r.get<'reports'>('report', a.reportId) : null;
  return {
    doc: a,
    view: {
      requestId: a._id,
      asker: personLockup(await r.get<'profiles'>('profile', a.requesterId), r.now),
      askedAt: a.createdAt,
      note: a.note ?? null,
      name: a.name ?? null,
      coord: a.coord,
      status: m.status,
      fromReport: report
        ? {
            reportId: report._id,
            skateEndTime: report.skateEndTime,
            where: report.notes ? snippet(report.notes) : null,
          }
        : null,
      activityId: a.activityId ?? null,
      // Read after the item's rule (`withSkates`, `withAskerLandmarks`), never before it.
      skate: null,
      landmarkAsks: null,
    },
  };
}

/** Askers whose landmark counts an item reads (B01-5c), newest asks first. */
export const VIEW_ASKER_COUNTS = 3;

/** Of one person's open and of their closed request filings, the most read to count their landmark asks. */
export const LANDMARK_FILINGS_READ = 50;

/**
 * A person's landmark asks, from their own Inbox filings (`by_filer_source_status`, rows of 1 KiB):
 * the newest `LANDMARK_FILINGS_READ` open and closed, each one's item read (a small row) for its kind
 * and decision. One past the read says `capped`.
 */
async function askerLandmarksOf(
  r: InboxReader,
  userId: Id<'profiles'>,
): Promise<AskerLandmarksView> {
  let capped = false;
  const filings: Doc<'inboxItemMembers'>[] = [];
  for (const status of ['open', 'closed'] as const) {
    const rows = await r.take('inboxMember', LANDMARK_FILINGS_READ + 1, (k) =>
      r.ctx.db
        .query('inboxItemMembers')
        .withIndex('by_filer_source_status', (q) =>
          q.eq('filedByUserId', userId).eq('sourceTable', 'waterBodyRequests').eq('status', status),
        )
        .order('desc')
        .take(k),
    );
    if (rows.length > LANDMARK_FILINGS_READ) capped = true;
    filings.push(...rows.slice(0, LANDMARK_FILINGS_READ));
  }
  let asked = 0;
  let added = 0;
  for (const itemId of new Set(filings.map((m) => m.itemId))) {
    const item = await r.get<'inboxItems'>('small', itemId);
    // Past what the budget holds, what is counted is a floor.
    if (!item) {
      capped = true;
      continue;
    }
    if (item.kind !== 'place' || item.facet !== 'landmarks') continue;
    asked++;
    if (item.decision === 'approved') added++;
  }
  return { asked, added, capped };
}

/** Each landmark ask's asker's counts — after the item's rule, at most `VIEW_ASKER_COUNTS` asks. */
async function withAskerLandmarks(
  r: InboxReader,
  asks: readonly AskMemberView[],
): Promise<AskMemberView[]> {
  if (await inboxPending(r.ctx)) return [...asks];
  const out: AskMemberView[] = [];
  for (const [i, a] of asks.entries()) {
    const id = a.asker?.userId;
    out.push(
      i < VIEW_ASKER_COUNTS && id ? { ...a, landmarkAsks: await askerLandmarksOf(r, id) } : a,
    );
  }
  return out;
}

/**
 * A drawn body's creating skate and the report it became (2.5): the drawer's own activity bound to
 * the body that started before the body was drawn — the latest such, one row by index
 * (`by_water_body_start_time`, an `eq` on the body and a bounded range on the start), checked to be
 * the drawer's — and its `linkedReportId`.
 */
async function drawnSkateOf(
  r: InboxReader,
  water: Doc<'waterBodies'>,
): Promise<{
  skate: DrawnSkateView | null;
  fromReport: (ReportRefView & { excerpt: string | null }) | null;
}> {
  const none = { skate: null, fromReport: null };
  const drawer = water.createdByUserId;
  if (drawer === undefined) return none;
  // A small page, the drawer's kept: another skater's activity synced late onto the body can be the
  // latest before the drawing without hiding the drawer's own behind it.
  const page = await r.take('activity', DRAWN_SKATE_PAGE, (k) =>
    r.ctx.db
      .query('gpsActivities')
      .withIndex('by_water_body_start_time', (q) =>
        q.eq('waterBodyId', water._id).lte('startTime', water.createdAt),
      )
      .order('desc')
      .take(k),
  );
  const a = page.find((x) => x.userId === drawer);
  if (!a) return none;
  const skate: DrawnSkateView = {
    activityId: a._id,
    startTime: a.startTime,
    endTime: a.endTime ?? null,
    elapsedSeconds: a.elapsedSeconds ?? null,
    hasTrack: a.path?.type === 'LineString',
  };
  const report = a.linkedReportId ? await r.must<'reports'>('report', a.linkedReportId) : null;
  if (!report) return { skate, fromReport: null };
  // Withdrawn by its author reads as taken down does: its words only to `content.read`.
  const text =
    report.authorDeletedAt !== undefined && !r.canReadContent ? null : r.text(report, report.notes);
  return {
    skate,
    fromReport: {
      reportId: report._id,
      skateEndTime: report.skateEndTime,
      author: personRef(await r.must<'profiles'>('profile', report.authorId)),
      observedFrom: report.observedFrom ?? null,
      excerpt: text?.trim() ? snippet(text) : null,
    },
  };
}

/** The drawn body's activities read to find the drawer's own skate: the latest few before it was drawn. */
export const DRAWN_SKATE_PAGE = 3;

/** Skates an item reads for its asks (B01-5c): each an activity row read whole, track and all. */
export const VIEW_SKATES = 10;

/**
 * Each ask's recorded skate, as its activity row stores it — read only after the item's rule has had
 * its reads (a skate is context, never a reason a lever's check went unfinished), at most
 * `VIEW_SKATES`, each started only while its worst case fits (`r.get`); one past that reads `null`.
 */
async function withSkates(
  r: InboxReader,
  asks: readonly AskMemberView[],
): Promise<AskMemberView[]> {
  const out: AskMemberView[] = [];
  let read = 0;
  for (const a of asks) {
    if (a.activityId === null || read >= VIEW_SKATES) {
      out.push(a);
      continue;
    }
    read++;
    const activity = await r.get<'gpsActivities'>('activity', a.activityId);
    out.push({
      ...a,
      skate: activity
        ? {
            startTime: activity.startTime,
            endTime: activity.endTime ?? null,
            elapsedSeconds: activity.elapsedSeconds ?? null,
          }
        : null,
    });
  }
  return out;
}

/**
 * A body's standing access ruling as 2.2's ruling event (the Access item's, and a *contest access*
 * ask's): the verdict, when and by whom, its public note, and what the ruler cited — the ruling's own
 * audit row, the latest `set_public_access` (a lookup, one row). `null` for a body with no ruling.
 */
async function rulingOf(r: InboxReader, water: Doc<'waterBodies'>): Promise<RulingView | null> {
  const p = water.publicAccess;
  if (!p) return null;
  // What the ruler cited, and who: required rows (`must`) — a miss must never read as "no one".
  if (!r.budget.affordsRead('moderationAction')) {
    throw new OverBudget("inbox item: a ruling's audit row past the item's budget");
  }
  const audit = await r.take('moderationAction', 1, (k) =>
    r.ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q.eq('targetType', 'waterbody').eq('targetId', water._id).eq('action', 'set_public_access'),
      )
      .order('desc')
      .take(k),
  );
  return {
    verdict: p.verdict,
    ruledAt: p.decidedAt,
    by: personRef(await r.must<'profiles'>('profile', p.decidedByUserId)),
    note: p.note ?? null,
    reason: audit[0]?.reason ?? null,
  };
}

/** An activate ask's body's dormancy, as the body stores it; `null` for a body not dormant. */
async function dormancyOf(r: InboxReader, water: Doc<'waterBodies'>): Promise<DormancyView | null> {
  const d = water.dormant;
  if (!d) return null;
  return {
    reason: d.reason,
    since: d.since,
    note: d.note ?? null,
    by: personRef(await r.must<'profiles'>('profile', d.byUserId)),
  };
}

// ── Decided ────────────────────────────────────────────────────────────────────────────────────

export async function decidedOf(
  r: InboxReader,
  item: Doc<'inboxItems'>,
): Promise<InboxDecidedState | null> {
  if (item.status !== 'decided' || item.decision === undefined) return null;
  const by = await r.get<'profiles'>('profile', item.decidedByUserId);
  return {
    at: item.decidedAt ?? item.lastActivityAt,
    by: by ? { userId: by._id, displayName: by.displayName } : null,
    decision: item.decision,
    actionId: item.decisionActionId ?? null,
    byMe: item.decidedByUserId === r.viewerId,
  };
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────

/** A list row's label facts, by kind (the `can` and `decided` are the caller's). */
export async function rowLabel(
  r: InboxReader,
  item: Doc<'inboxItems'>,
): Promise<DistOmit<InboxRowView, 'can' | 'decided'>> {
  const status = item.status === 'open' ? 'open' : 'closed';
  const members = await r.members(item._id, status, 5);
  const first = members[0];
  const body = bodyRef(await r.get<'waterBodies'>('waterBody', item.waterBodyId));
  const base = {
    itemId: item._id,
    lane: item.lane,
    facet: item.facet,
    filedAt: item.filedAt,
    lastActivityAt: item.lastActivityAt,
    memberCount: item.memberCount,
    memberCountIsFloor: item.memberCount >= MAX_MEMBERS,
    body,
  };
  switch (item.kind) {
    case 'flag': {
      // One at a time, each whole (`readEach`): a row's first flag is never one a budget skipped.
      const { rows: flags } = await readEach(r, members, ROW_MAX.contentFlag, (m) =>
        r.get<'contentFlags'>('contentFlag', m.sourceId as Id<'contentFlags'>),
      );
      const oldest = flags[0];
      const label = oldest ? await targetLabel(r, oldest.targetType, oldest.targetId) : null;
      const target = {
        targetType: oldest?.targetType ?? ('report' as const),
        exists: label?.exists ?? false,
        summary: label?.summary ?? '(deleted)',
        moderationStatus: label?.moderationStatus ?? null,
        withdrawn: (label?.withdrawnAt ?? null) !== null,
      };
      return {
        ...base,
        kind: 'flag',
        reasons: [...new Set(flags.map((f) => f.reason))],
        target,
        author: personRef(await r.get<'profiles'>('profile', item.subjectUserId)),
        firstFiler:
          oldest && oldest.origin === 'user'
            ? personRef(await r.get<'profiles'>('profile', oldest.flaggerId))
            : null,
        autoFiled: oldest ? oldest.origin !== 'user' : false,
        occurrences: oldest?.occurrences ?? 1,
      };
    }
    case 'access': {
      // The newest reports by their own read — not the last of the oldest five, which once an item
      // had six reports hid every later note (PR #170) — and the newest of them that says something.
      const newest = await r.members(item._id, status, LATEST_NOTE_READ, 'newest');
      let flag: Doc<'contentFlags'> | null = null;
      for (const m of newest) {
        const f = await r.get<'contentFlags'>('contentFlag', m.sourceId as Id<'contentFlags'>);
        if (f?.note?.trim()) {
          flag = f;
          break;
        }
      }
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId);
      const ruling = water?.publicAccess;
      return {
        ...base,
        kind: 'access',
        reporters: item.memberCount,
        latestNote: flag?.note ?? null,
        disputes:
          ruling && ruling.verdict === 'open'
            ? { verdict: ruling.verdict, ruledAt: ruling.decidedAt }
            : null,
      };
    }
    case 'request':
    case 'place': {
      const { rows: asks } = await readEach(r, members, ROW_MAX.waterBodyRequest, (m) =>
        r.get<'waterBodyRequests'>('waterBodyRequest', m.sourceId as Id<'waterBodyRequests'>),
      );
      const a = asks[0];
      const firstAsker = personRef(await r.get<'profiles'>('profile', a?.requesterId));
      if (item.kind === 'request') {
        return {
          ...base,
          kind: 'request',
          requestKind: (a?.kind ?? item.facet) as RequestKind,
          askers: item.memberCount,
          firstAsker,
          note: a?.note ?? null,
          candidate: a?.candidate
            ? { name: a.candidate.name || null, areaSqM: a.candidate.surfaceAreaSqM }
            : null,
          resolveError: a?.resolveError ?? null,
        };
      }
      const others: PersonRefView[] = [];
      for (const o of asks.slice(1, 3)) {
        const p = personRef(await r.get<'profiles'>('profile', o.requesterId));
        if (p) others.push(p);
      }
      return {
        ...base,
        kind: 'place',
        placeKind: a?.kind === 'name_bay' ? 'name_bay' : 'name_landmark',
        name: a?.name ?? '',
        askers: item.memberCount,
        firstAsker,
        others,
        fromReport: a?.reportId !== undefined,
        lookalikeMeters: null,
      };
    }
    case 'drawn': {
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId);
      // The live survivor, as the item names it — never a first candidate merged away since.
      const overBody = water
        ? await liveSurvivorOf(water, (id) => r.get<'waterBodies'>('waterBody', id))
        : null;
      return {
        ...base,
        kind: 'drawn',
        drawer: personRef(await r.get<'profiles'>('profile', water?.createdByUserId)),
        overlapShare: null,
        overName: overBody?.name ?? null,
        fromSkate: true,
      };
    }
    case 'ticket': {
      const t = first
        ? await r.get<'supportTickets'>('supportTicket', first.sourceId as Id<'supportTickets'>)
        : null;
      return {
        ...base,
        kind: 'ticket',
        category: t?.category ?? (item.facet as Doc<'supportTickets'>['category']),
        person: personRef(await r.get<'profiles'>('profile', t?.userId)),
        snippet: snippet(t?.body),
      };
    }
  }
}

// ── Items ──────────────────────────────────────────────────────────────────────────────────────

type ItemFacts = {
  view: DistOmit<InboxItemView, 'can' | 'canCode' | 'decided'>;
  facts: InboxRuleFacts;
};

/** An item as its handler draws it, and the facts its verbs' preconditions read. */
export async function itemView(r: InboxReader, item: Doc<'inboxItems'>): Promise<ItemFacts | null> {
  // Oldest first, read by the kinds that list from that end (a flag's, a ticket's); an access item
  // and an ask's list read from the newest end themselves.
  const oldestMembers = async () => {
    const open = await r.members(item._id, 'open');
    const closed = await r.members(item._id, 'closed');
    return [...open, ...closed].sort((a, b) => a.filedAt - b.filedAt);
  };
  const base = {
    itemId: item._id,
    lane: item.lane,
    facet: item.facet,
    filedAt: item.filedAt,
    lastActivityAt: item.lastActivityAt,
    memberCount: item.memberCount,
    memberCountIsFloor: item.memberCount >= MAX_MEMBERS,
  };
  switch (item.kind) {
    case 'flag': {
      const members = await oldestMembers();
      // The target (what the levers' facts are) and its author first, on a fresh budget; the flags,
      // a list that fills what's left, after (B01-5c).
      const firstFlag = members[0]
        ? await r.must<'contentFlags'>('contentFlag', members[0].sourceId as Id<'contentFlags'>)
        : null;
      if (!firstFlag) return null;
      const { view: targetRead, facts } = await flagTargetView(r, firstFlag);
      const author =
        firstFlag.targetType === 'user' ? null : await authorBlock(r, item.subjectUserId);
      // A photo's *On the same report* is a list: filled once the required rows are read.
      const target =
        targetRead.exists && targetRead.targetType === 'photo'
          ? {
              ...targetRead,
              photo: { ...targetRead.photo, ...(await photoSiblings(r, targetRead.photo)) },
            }
          : targetRead;
      const { rows: flags, cut: flagsCut } = await readEach(r, members, FLAG_MEMBER_WORST, (m) =>
        flagMember(r, m),
      );
      return { view: { ...base, kind: 'flag', target, flags, flagsCut, author }, facts };
    }
    case 'access': {
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId);
      const body = bodyRef(water);
      if (!body || !water) return null;
      // The standing ruling (its ruler, what they cited) first, on a fresh budget (B01-5c).
      const ruling = await rulingOf(r, water);
      // Listed newest first, so read from the newest end: past `VIEW_MEMBERS` a report about changed
      // access would otherwise be the one left out (PR #170).
      const recent = [
        ...(await r.members(item._id, 'open', VIEW_MEMBERS, 'newest')),
        ...(await r.members(item._id, 'closed', VIEW_MEMBERS, 'newest')),
      ];
      const read = await readEach(r, recent, FLAG_MEMBER_WORST, (m) => flagMember(r, m));
      const reports = read.rows.sort((a, b) => b.filedAt - a.filedAt);
      const reportsCut = read.cut;
      const p = water.publicAccess;
      const contest = await r.take('waterBodyRequest', COUNT_CAP + 1, (k) =>
        r.ctx.db
          .query('waterBodyRequests')
          .withIndex('by_water_body', (q) =>
            q.eq('waterBodyId', water._id).eq('kind', 'contest_access').eq('status', 'open'),
          )
          .take(k),
      );
      const contestAsks: Count = {
        count: Math.min(contest.length, COUNT_CAP),
        capped: contest.length > COUNT_CAP,
      };
      const dismissedByRuling: FlagMemberView[] = [];
      let dismissedByRulingCut = false;
      if (p) {
        // One past the cap, to know there are more; fewer when the budget holds fewer — either way
        // the list says it's cut rather than reading as every dismissed report.
        const room = r.budget.rows('contentFlag', DISMISSED_BY_RULING_READ + 1);
        const dismissed = await r.take('contentFlag', DISMISSED_BY_RULING_READ + 1, (k) =>
          r.ctx.db
            .query('contentFlags')
            .withIndex('by_target_status_reason', (q) =>
              q
                .eq('targetType', 'waterbody')
                .eq('targetId', water._id)
                .eq('status', 'dismissed')
                .eq('reason', 'no_public_access'),
            )
            .take(k),
        );
        if (
          dismissed.length > DISMISSED_BY_RULING_READ ||
          (room <= DISMISSED_BY_RULING_READ && dismissed.length >= room)
        ) {
          dismissedByRulingCut = true;
        }
        const ruled = dismissed
          .slice(0, DISMISSED_BY_RULING_READ)
          .filter((x) => x.resolvedAt === p.decidedAt);
        for (const f of ruled) {
          // Each with its filer whole, or the list ends here (`readEach`'s rule).
          if (!r.budget.affords(ROW_MAX.profile) || !r.budget.affordsCalls(1, 1)) {
            dismissedByRulingCut = true;
            break;
          }
          dismissedByRuling.push({
            flagId: f._id,
            reason: f.reason,
            note: f.note ?? null,
            filedAt: f.createdAt,
            status: 'closed',
            filer: personLockup(await r.get<'profiles'>('profile', f.flaggerId), r.now),
            autoFiled: f.origin !== 'user',
            occurrences: f.occurrences ?? 1,
            lastOccurrenceAt: f.lastOccurrenceAt ?? null,
            prior: null,
          });
        }
      }
      return {
        view: {
          ...base,
          kind: 'access',
          body,
          reports,
          reportsCut,
          ruling,
          dismissedByRuling,
          dismissedByRulingCut,
          contestAsks,
        },
        facts: { hasRuling: p !== undefined },
      };
    }
    case 'request':
    case 'place': {
      // The single rows the item rests on, first, on a fresh budget (B01-5c): its body, and for a
      // contest-access ask the ruling it contests, for an activate ask the body's dormancy (each with
      // who made it). The asks — a list that fills what's left — after.
      const held = await r.must<'waterBodies'>('waterBody', item.waterBodyId);
      const heldRuling =
        item.kind === 'request' && item.facet === 'contest_access' && held
          ? await rulingOf(r, held)
          : null;
      const heldDormancy =
        item.kind === 'request' && item.facet === 'activate' && held
          ? await dormancyOf(r, held)
          : null;
      // Newest first, read from that end, as the Access item's reports (B01-5c): past the cap the
      // reader sees the latest asks, never the oldest fifty re-sorted.
      const recent = [
        ...(await r.members(item._id, 'open', VIEW_MEMBERS, 'newest')),
        ...(await r.members(item._id, 'closed', VIEW_MEMBERS, 'newest')),
      ];
      // One at a time, each whole (`readEach`): past what the budget holds the list ends, and says so.
      const { rows: read, cut: asksCut } = await readEach(r, recent, ASK_MEMBER_WORST, (m) =>
        askMember(r, m),
      );
      const asks = read.sort(
        (a, b) => b.doc.createdAt - a.doc.createdAt || b.doc._creationTime - a.doc._creationTime,
      );
      // The ask a decision is sent for: the newest open one served — the facts below are its reach.
      const primary = asks.find((a) => a.view.status === 'open') ?? asks[0];
      const first = primary?.doc;
      if (!first) return null;
      // The item's body as read above; an admit's item has none until its ask names one.
      const water = held ?? (await r.must<'waterBodies'>('waterBody', first.waterBodyId));
      const body = bodyRef(water);
      if (item.kind === 'request') {
        const withCandidate = asks.find((a) => a.doc.candidate !== undefined)?.doc;
        const c = withCandidate?.candidate;
        const candidate: CandidateView | null = c
          ? {
              source: '3dhp',
              externalId: c.externalId,
              name: c.name || null,
              cls: c.cls ?? null,
              areaSqM: c.surfaceAreaSqM,
              centroid: c.centroid,
              polygon: c.polygon,
              matchedAt: withCandidate?.resolvedAt ?? c.fetchedAt,
              metersFromAsk: Math.round(haversineMeters(c.centroid, first.coord)),
              // Stamped by the lookup that found the candidate (B01-5d); an older ask's reads null.
              nearestKnown: withCandidate?.nearestKnown ?? null,
            }
          : null;
        const facts: InboxRuleFacts = {
          requestKind: first.kind,
          hasCandidate: candidate !== null,
          resolveError: first.resolveError ?? null,
          candidateFlowing: c !== undefined && c.cls === undefined,
          // Its siblings are its own question's asks either way: one answer for both verbs.
          askedAlongside: await alongsideOf(r, first, {}, {}),
        };
        // Context after the rule's reads, so none of it can leave a lever's check unfinished.
        return {
          view: {
            ...base,
            kind: 'request',
            requestKind: first.kind,
            body,
            asks: await withSkates(
              r,
              asks.map((a) => a.view),
            ),
            primaryRequestId: first._id,
            asksCut,
            candidate,
            resolveError: first.resolveError ?? null,
            ruling: first.kind === 'contest_access' ? heldRuling : null,
            dormancy: first.kind === 'activate' ? heldDormancy : null,
          },
          facts,
        };
      }
      if (!body || !water) return null;
      let drawnSubAreaId: Id<'waterBodySubAreas'> | null = null;
      let answeringLandmarkId: Id<'bodyLandmarks'> | null = null;
      const lookalikes: LookalikeView[] = [];
      const facts: InboxRuleFacts = { requestKind: first.kind };
      if (first.kind === 'name_bay') {
        r.budget.reserve('small', 50);
        const bay = await drawnBay(r.ctx, water._id, requestNames(first));
        drawnSubAreaId = bay?._id ?? null;
        facts.bayMissing = bay
          ? null
          : `No sub-area called "${first.name}" on ${water.name} yet — draw it in the lake editor first, then approve.`;
        facts.askedAlongside = await alongsideOf(r, first, { subArea: bay }, {});
      } else {
        r.budget.reserve('landmark', 8);
        const landmarks = await liveLandmarksForBody(r.ctx, water._id);
        const ask = landmarkAskOf(first);
        const answering = matchLandmark(landmarks, ask);
        answeringLandmarkId = answering?._id ?? null;
        facts.landmarkMissing = answering
          ? null
          : `No landmark called "${first.name}" near that spot on ${water.name} yet — add it in the lake editor first, then approve.`;
        facts.askedAlongside = await alongsideOf(r, first, { landmark: answering ?? null }, {});
        const others = asks.filter((a) => a !== primary).map((a) => a.doc);
        const found = landmarkProposalView(ask, landmarks, others);
        if (found.similarLandmark) {
          const l = landmarks.find((x) => x._id === found.similarLandmark?.landmarkId);
          lookalikes.push({
            kind: 'landmark',
            landmarkId: found.similarLandmark.landmarkId,
            name: found.similarLandmark.name,
            point: found.similarLandmark.point,
            meters: found.similarLandmark.meters,
            landmarkKind: (l?.kind ?? 'point') as Doc<'bodyLandmarks'>['kind'],
            source: (l?.source ?? 'moderator') as Doc<'bodyLandmarks'>['source'],
            aliases: l?.aliases ?? [],
            usedByReports: l?.reportCount ?? null,
          });
        }
        if (found.similarProposal) lookalikes.push({ kind: 'proposal', ...found.similarProposal });
        facts.hasLookalike = lookalikes.some((x) => x.kind === 'landmark');
      }
      return {
        view: {
          ...base,
          kind: 'place',
          placeKind: first.kind === 'name_bay' ? 'name_bay' : 'name_landmark',
          body,
          asks: await withSkates(
            r,
            first.kind === 'name_landmark'
              ? await withAskerLandmarks(
                  r,
                  asks.map((a) => a.view),
                )
              : asks.map((a) => a.view),
          ),
          primaryRequestId: first._id,
          asksCut,
          drawnSubAreaId,
          answeringLandmarkId,
          lookalikes,
        },
        facts,
      };
    }
    case 'drawn': {
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId);
      const body = bodyRef(water);
      if (!body || !water) return null;
      const drawerProfile = await r.must<'profiles'>('profile', water.createdByUserId);
      const drawer = personLockup(drawerProfile, r.now);
      // The rule's facts are the gauge's own survivor: no overlap drawn, no merge offered (B01-5d).
      const live = await drawnSurvivorOf(water, (id) => r.get<'waterBodies'>('waterBody', id));
      const overlap = overlapView(live);
      const made = await drawnSkateOf(r, water);
      return {
        view: {
          ...base,
          kind: 'drawn',
          body,
          drawer,
          drawerReports: drawer && !drawer.deleted ? (drawerProfile?.reportCount ?? null) : null,
          overlap,
          fromReport: made.fromReport,
          skate: made.skate,
        },
        facts: drawnMergeFacts(water, live),
      };
    }
    case 'ticket': {
      const m = (await oldestMembers())[0];
      // Required rows first (B01-5c), before any list fills the budget: the ticket, who resolved it,
      // and the person who filed it — none of them may read as "no one" for want of room.
      const t = m
        ? await r.must<'supportTickets'>('supportTicket', m.sourceId as Id<'supportTickets'>)
        : null;
      if (!t) return null;
      const resolver = await r.must<'profiles'>('profile', t.resolvedByUserId);
      const filer = await r.must<'profiles'>('profile', t.userId);
      const ticket: TicketView = {
        ticketId: t._id,
        category: t.category,
        body: t.body,
        createdAt: t.createdAt,
        status: t.status === 'resolved' ? 'resolved' : 'open',
        context: t.context ?? null,
        resolvedAt: t.resolvedAt ?? null,
        resolvedBy: personRef(resolver),
      };
      const thread = await ticketThread(r, t);
      const related = await ticketRelated(r, t.userId);
      const personTickets = await ticketCountsOf(r, t.userId);
      const replyFrom = process.env.SUPPORT_FROM_EMAIL || null;
      return {
        view: {
          ...base,
          kind: 'ticket',
          ticket,
          messages: thread.messages,
          messageCount: thread.messages.length,
          messagesCut: thread.capped,
          replyFrom,
          replyBlocked: replyBlockedOf(t, filer),
          personTickets,
          // Last: its reports fill what the budget has left, and say so when they stop short.
          person: await authorBlock(r, t.userId),
          related,
        },
        facts: {},
      };
    }
  }
}

/**
 * **A ticket's thread** (B01-5f): its newest {@link THREAD_MESSAGES} messages, oldest first — read
 * from the newest end, so a busy ticket shows its latest words and says the older ones were cut —
 * each charged at its worst, then each author, required (attribution never reads as "no one"). A
 * reply's `cancel` is the undo's own rule (`supportUndoRefusal`) for this viewer, over the rows read
 * here.
 */
async function ticketThread(
  r: InboxReader,
  t: Doc<'supportTickets'>,
): Promise<{ messages: SupportMessageView[]; capped: boolean }> {
  const asked = r.budget.rows('supportMessage', THREAD_MESSAGES + 1);
  const newest = await r.take('supportMessage', THREAD_MESSAGES + 1, (k) =>
    r.ctx.db
      .query('supportMessages')
      .withIndex('by_ticket_created', (q) => q.eq('ticketId', t._id))
      .order('desc')
      .take(k),
  );
  // Past the bound — or a budget that couldn't ask for one past it and came back full.
  const capped =
    newest.length > THREAD_MESSAGES || (asked <= THREAD_MESSAGES && newest.length === asked);
  const rows = newest.slice(0, THREAD_MESSAGES).reverse();
  const viewer = rows.length > 0 ? await r.must<'profiles'>('profile', r.viewerId) : null;
  const messages: SupportMessageView[] = [];
  for (const m of rows) {
    const author = personRef(await r.must<'profiles'>('profile', m.authorId));
    messages.push({
      messageId: m._id,
      kind: m.kind,
      author,
      body: m.removedAt !== undefined ? null : m.body,
      createdAt: m.createdAt,
      removedAt: m.removedAt ?? null,
      remove:
        m.kind === 'note'
          ? viewer
            ? supportUndoRefusal(viewer, 'removeNote', { ticket: t, message: m, now: r.now })
            : 'Undoing this takes a role you do not hold.'
          : NOT_A_NOTE_REFUSAL,
      reply:
        m.kind === 'reply'
          ? {
              status: m.status ?? 'failed',
              sendAfter: m.sendAfter ?? m.createdAt,
              sentAt: m.status === 'sent' ? (m.sentAt ?? null) : null,
              failedWhy: m.failedWhy ?? null,
              cancel: viewer
                ? supportUndoRefusal(viewer, 'cancelReply', { ticket: t, message: m, now: r.now })
                : 'Undoing this takes a role you do not hold.',
            }
          : null,
    });
  }
  return { messages, capped };
}

/** A person's tickets the head counts, of each status, before it says "50+". */
export const PERSON_TICKETS_COUNTED = 50;

/**
 * The person's tickets for the head (*Tickets 2 · 1 resolved*): their ticket members, open and
 * closed, through the filer's index — 1 KiB rows, never the tickets' bodies — each status to a bound.
 */
async function ticketCountsOf(
  r: InboxReader,
  userId: Id<'profiles'> | undefined,
): Promise<{ total: number; resolved: number; capped: boolean } | null> {
  if (!userId) return null;
  const counts = { open: 0, closed: 0 };
  let capped = false;
  for (const status of ['open', 'closed'] as const) {
    const asked = r.budget.rows('inboxMember', PERSON_TICKETS_COUNTED + 1);
    const rows = await r.take('inboxMember', PERSON_TICKETS_COUNTED + 1, (k) =>
      r.ctx.db
        .query('inboxItemMembers')
        .withIndex('by_filer_source_status', (q) =>
          q.eq('filedByUserId', userId).eq('sourceTable', 'supportTickets').eq('status', status),
        )
        .take(k),
    );
    counts[status] = Math.min(rows.length, PERSON_TICKETS_COUNTED);
    capped ||=
      rows.length > PERSON_TICKETS_COUNTED ||
      (asked <= PERSON_TICKETS_COUNTED && rows.length === asked);
  }
  return { total: counts.open + counts.closed, resolved: counts.closed, capped };
}

/** Flags about a ticket's person *Related* lists, of each status (open, then actioned). */
export const TICKET_RELATED_FLAGS = 5;

/** 2.8's *Related*: the person's open flags, then the newest actioned ones, each bounded. */
async function ticketRelated(
  r: InboxReader,
  userId: Id<'profiles'> | undefined,
): Promise<{ flags: TicketRelatedFlagView[]; capped: boolean }> {
  if (!userId) return { flags: [], capped: false };
  const flags: TicketRelatedFlagView[] = [];
  let capped = false;
  for (const status of ['open', 'actioned'] as const) {
    const asked = r.budget.rows('contentFlag', TICKET_RELATED_FLAGS + 1);
    const rows = await r.take('contentFlag', TICKET_RELATED_FLAGS + 1, (k) =>
      r.ctx.db
        .query('contentFlags')
        .withIndex('by_subject_status', (q) => q.eq('subjectUserId', userId).eq('status', status))
        .order('desc')
        .take(k),
    );
    capped ||=
      rows.length > TICKET_RELATED_FLAGS ||
      (asked <= TICKET_RELATED_FLAGS && rows.length === asked);
    for (const f of rows.slice(0, TICKET_RELATED_FLAGS)) {
      flags.push({
        flagId: f._id,
        reason: f.reason,
        targetType: f.targetType,
        status,
        createdAt: f.createdAt,
        resolvedAt: f.resolvedAt ?? null,
      });
    }
  }
  return { flags, capped };
}

/**
 * What an ask's approval (by its answer) and its decline would each close of the viewer's own asks
 * (`lib/requestDecisions.alongsideAnswer`): their open filings read once, from small rows through the
 * item's budget — members of 1 KiB with the Inbox ready, ask rows one at a time while it is pending —
 * and each verb's reach asked of them. A check the budget can't finish answers `unchecked`: the item
 * still returns, its `can` refusing the decision.
 */
async function alongsideOf(
  r: InboxReader,
  first: Doc<'waterBodyRequests'>,
  approve: DecisionAnswer,
  decline: DecisionAnswer,
): Promise<{ approve: AlongsideAnswer; decline: AlongsideAnswer }> {
  const mine = await ownAsks(r.ctx, r.viewerId, r.budget, await inboxPending(r.ctx));
  return {
    approve: await alongsideAnswer(r.ctx, mine, first, approve, r.now, r.budget),
    decline: await alongsideAnswer(r.ctx, mine, first, decline, r.now, r.budget),
  };
}

/** A flagged hazard's votes the item counts; past it, each count is a floor. */
export const HAZARD_VOTES_READ = 200;

/** The item a ref names: its id, or a source ref (`flag:`, `request:`, `body:`, `ticket:`), or a bare source id. */
export async function itemOfRef(ctx: QueryCtx, ref: string): Promise<Doc<'inboxItems'> | null> {
  const direct = ctx.db.normalizeId('inboxItems', ref);
  if (direct) return ctx.db.get(direct);
  const [prefix, rest] = ref.includes(':') ? (ref.split(':', 2) as [string, string]) : ['', ref];
  const tables: Record<string, Doc<'inboxItemMembers'>['sourceTable']> = {
    flag: 'contentFlags',
    request: 'waterBodyRequests',
    body: 'waterBodies',
    ticket: 'supportTickets',
  };
  const candidates = prefix ? (tables[prefix] ? [tables[prefix]] : []) : Object.values(tables);
  for (const table of candidates) {
    if (!ctx.db.normalizeId(table, rest)) continue;
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', table).eq('sourceId', rest))
      .first();
    if (m) return ctx.db.get(m.itemId);
  }
  return null;
}

/** A report's point distance, rounded to the meter; `null` when either is missing. */
export function metersBetween(
  a: LatLng | null | undefined,
  b: LatLng | null | undefined,
): number | null {
  return a && b ? Math.round(haversineMeters(a, b)) : null;
}

// ── The lanes' figures (`inbox.lanes`, and the Overview's Inbox card) ──────────────────────────

const DAY_MS = 86_400_000;

/** How many open items the median reads; past it the median is `null`, not the oldest few's. */
export const MEDIAN_CAP = 200;
/** Decided today, counted to this many. */
export const TODAY_CAP = 500;

/**
 * Up to `cap` items in one read, charged at their worst and sized to what the request's budget still
 * holds — so every row read, kept or filtered after, is paid for. `short` when the budget held fewer
 * than asked and they all came back: the range's end wasn't seen, which the caller says as capped.
 */
export async function itemsUpTo(
  budget: ReadBudget,
  cap: number,
  read: (n: number) => Promise<Doc<'inboxItems'>[]>,
): Promise<{ rows: Doc<'inboxItems'>[]; short: boolean }> {
  const n = budget.rows('small', cap);
  const rows = n > 0 ? await budget.take('small', n, read) : [];
  return { rows, short: n < cap && rows.length === n };
}

/**
 * The lanes' figures from the stored counts — what `inbox.lanes` serves and what `console.overview`'s
 * Inbox card reads, so the two agree by construction. Support is absent for a viewer without its read.
 */
export async function readInboxLanes(
  ctx: QueryCtx,
  opts: { support: boolean; dayStart: number | null; ageFloorsAt?: number },
): Promise<{
  lanes: {
    lane: (typeof INBOX_LANES)[number];
    open: number;
    facets: Record<string, number>;
    oldestFiledAt: number | null;
    olderThan: { days: number; count: Count }[];
  }[];
  allOpen: number;
  decided: number;
  today: Count;
  medianFiledAt: number | null;
}> {
  // The request's own budget (one per transaction: a caller's reads and these share it).
  const budget = requestBudget(ctx, CHARGED_QUERY_BUDGET);
  const lanes = [];
  for (const lane of INBOX_LANES) {
    if (lane === 'support' && !opts.support) continue;
    const open = await readCount(ctx, `open:${lane}`);
    const facets: Record<string, number> = { all: open };
    for (const facet of INBOX_FACETS[lane]) {
      if (facet !== 'all') facets[facet] = await readCount(ctx, `open:${lane}:${facet}`);
    }
    const order = INBOX_LANE_ORDER[lane];
    let oldestFiledAt: number | null = null;
    const olderThan: { days: number; count: Count }[] = [];
    const access = lane === 'accessReports';
    if (open > 0) {
      // Access ranks by corroboration, so its oldest is the least filedAt of its open items.
      const { rows, short: oldestShort } = await itemsUpTo(
        budget,
        access ? MEDIAN_CAP + 1 : 1,
        (n) =>
          ctx.db
            .query('inboxItems')
            .withIndex('by_status_lane_rank', (q) => q.eq('status', 'open').eq('laneOrder', order))
            .take(n),
      );
      oldestFiledAt =
        rows.length > 0 ? Math.min(...rows.slice(0, MEDIAN_CAP).map((r) => r.filedAt)) : null;
      const at = opts.ageFloorsAt;
      if (at !== undefined) {
        for (const days of INBOX_AGE_FLOORS_DAYS) {
          const floor = at - days * DAY_MS;
          if (access) {
            const n = rows.slice(0, MEDIAN_CAP).filter((r) => r.filedAt <= floor).length;
            olderThan.push({
              days,
              count: { count: n, capped: rows.length > MEDIAN_CAP || oldestShort },
            });
            continue;
          }
          // Every other lane's rank is the filing: an exact range.
          const { rows: aged, short } = await itemsUpTo(budget, COUNT_CAP + 1, (n) =>
            ctx.db
              .query('inboxItems')
              .withIndex('by_status_lane_rank', (q) =>
                q.eq('status', 'open').eq('laneOrder', order).lte('rankKey', floor),
              )
              .take(n),
          );
          olderThan.push({
            days,
            count: {
              count: Math.min(aged.length, COUNT_CAP),
              capped: aged.length > COUNT_CAP || short,
            },
          });
        }
      }
    } else if (opts.ageFloorsAt !== undefined) {
      for (const days of INBOX_AGE_FLOORS_DAYS) {
        olderThan.push({ days, count: { count: 0, capped: false } });
      }
    }
    lanes.push({ lane, open, facets, oldestFiledAt, olderThan });
  }
  const decidedAll = await readCount(ctx, 'decided');
  const decided = opts.support
    ? decidedAll
    : decidedAll - (await readCount(ctx, 'decided:support'));
  let today: Count = { count: 0, capped: false };
  if (opts.dayStart !== null) {
    const dayStart = opts.dayStart;
    const { rows, short } = await itemsUpTo(budget, TODAY_CAP + 1, (n) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_status_decided', (q) => q.eq('status', 'decided').gte('decidedAt', dayStart))
        .take(n),
    );
    const seen = rows.filter((row) => opts.support || row.lane !== 'support');
    today = { count: Math.min(seen.length, TODAY_CAP), capped: rows.length > TODAY_CAP || short };
  }
  const { rows: openRows, short: openShort } = await itemsUpTo(budget, MEDIAN_CAP + 1, (n) =>
    ctx.db
      .query('inboxItems')
      .withIndex('by_status_lane_rank', (q) =>
        opts.support
          ? q.eq('status', 'open')
          : q.eq('status', 'open').lt('laneOrder', INBOX_LANE_ORDER.support),
      )
      .take(n),
  );
  const medianFiledAt =
    openRows.length > MEDIAN_CAP || openShort
      ? null
      : medianOpenedAt(openRows.map((r) => r.filedAt));
  return { lanes, allOpen: lanes.reduce((n, l) => n + l.open, 0), decided, today, medianFiledAt };
}

// ── An item's map (`inbox.itemMap`) ────────────────────────────────────────────────────────────

/** The whole answer's outlines weigh at most this; past it, outlines are left out and `capped` said. */
export const MAP_ANSWER_BYTES = 1024 * 1024;

/**
 * The map's bounds in force — a test seam (a test shrinks them to small outlines, then puts them
 * back), as the stored facts' `NAMES_BOUNDS` is: real outlines can't reach the answer's bound.
 */
export const MAP_BOUNDS = {
  answerBytes: MAP_ANSWER_BYTES,
  outlineBytes: MAP_OUTLINE_BYTES,
  ringPoints: MAP_RING_POINTS,
  neighborPoints: NEIGHBOR_RING_POINTS,
};

const toLngLat = (p: LatLng): InboxMapLngLat => [p.lng, p.lat];

/**
 * A drawing's overlap as 2.5's gauge draws it: its live survivor and the share of the drawing inside
 * it — `drawnSurvivorOf`, the one function the item's `can` and `mergeDrawn` read too (B01-5d), so the
 * bar and its lever never disagree. `null` when it overlaps no live body, or the clipper can't say.
 */
export async function overlapOf(
  r: InboxReader,
  drawn: Doc<'waterBodies'>,
): Promise<OverlapView | null> {
  return overlapView(await drawnSurvivorOf(drawn, (id) => r.get<'waterBodies'>('waterBody', id)));
}

/** A live survivor as 2.5's gauge draws it. */
function overlapView(live: DrawnSurvivor | null): OverlapView | null {
  const body = live ? bodyRef(live.survivor) : null;
  return live && body ? { share: live.share, body, suggested: live.suggested } : null;
}

/** An outline for the embed: whole within its bound, else its largest ring kept to `points`. */
function embedOutline(
  id: string,
  name: string,
  polygon: unknown,
  wholeBytes: number,
  points: number,
): InboxMapBody | null {
  if (!polygon) return null;
  const geom = polygon as Polygon | MultiPolygon;
  if (getDocumentSize(geom as never) <= wholeBytes) {
    return { id, name, outline: geom, simplified: false };
  }
  return {
    id,
    name,
    outline: { type: 'Polygon', coordinates: [simplifiedRing(geom, points)] },
    simplified: true,
  };
}

/** Collects outlines up to the answer's byte bound, saying when one was left out. */
class OutlineBudget {
  left = MAP_BOUNDS.answerBytes;
  capped = false;
  take(outline: InboxMapBody | null): InboxMapBody | null {
    if (!outline) return null;
    return this.fits(getDocumentSize(outline.outline as never)) ? outline : null;
  }
  /** A track, from the same bound as the outlines (B01-5c). */
  takeTrack(track: InboxMapTrack | null): InboxMapTrack | null {
    if (!track) return null;
    return this.fits(getDocumentSize(track.path as never)) ? track : null;
  }
  private fits(bytes: number): boolean {
    if (bytes > this.left) {
      this.capped = true;
      return false;
    }
    this.left -= bytes;
    return true;
  }
}

/**
 * A skate's track for an embed: sent whole up to `MAP_OUTLINE_BYTES`, as an outline is; past it,
 * thinned evenly to `MAP_RING_POINTS` points with its first and last kept (`simplified`). `null` for a
 * skate with no LineString track.
 */
export function embedTrack(id: string, path: unknown): InboxMapTrack | null {
  const line = path as { type?: string; coordinates?: number[][] } | undefined;
  if (line?.type !== 'LineString' || !Array.isArray(line.coordinates)) return null;
  const coords = line.coordinates.filter((c) => c.length >= 2);
  if (coords.length < 2) return null;
  const at = (c: number[]): InboxMapLngLat => [c[0] as number, c[1] as number];
  if (getDocumentSize(line as never) <= MAP_BOUNDS.outlineBytes) {
    return { id, path: coords.map(at), simplified: false };
  }
  const max = MAP_BOUNDS.ringPoints;
  const step = (coords.length - 1) / (max - 1);
  const out: InboxMapLngLat[] = [];
  for (let k = 0; k < max; k++) out.push(at(coords[Math.round(k * step)] as number[]));
  return { id, path: out, simplified: true };
}

/** The body's own outline (sent whole up to `MAP_OUTLINE_BYTES`). */
function ownOutline(body: Doc<'waterBodies'> | null): InboxMapBody | null {
  return body
    ? embedOutline(
        body._id,
        body.name,
        body.polygon,
        MAP_BOUNDS.outlineBytes,
        MAP_BOUNDS.ringPoints,
      )
    : null;
}

/** A neighbor's outline, always simplified to the Body console's ring. */
function neighborOutline(body: Doc<'waterBodies'> | null): InboxMapBody | null {
  return body
    ? embedOutline(body._id, body.name, body.polygon, 0, MAP_BOUNDS.neighborPoints)
    : null;
}

/** A body's put-ins and lots, as the embed's access points (visible ones, 50 of each at most). */
async function accessPointsOf(
  r: InboxReader,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ points: InboxMapAccessPoint[]; capped: boolean }> {
  const cap = 50;
  const putIns = await r.take('putIn', cap + 1, (k) =>
    r.ctx.db
      .query('putIns')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
      .take(k),
  );
  // A lot reaches its bodies through `parkingAreaBodies` (one lot may serve several).
  const links = await r.take('small', cap + 1, (k) =>
    r.ctx.db
      .query('parkingAreaBodies')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
      .take(k),
  );
  const lots: Doc<'parkingAreas'>[] = [];
  for (const link of links.slice(0, cap)) {
    const lot = await r.get<'parkingAreas'>('putIn', link.parkingAreaId);
    if (lot) lots.push(lot);
  }
  const points: InboxMapAccessPoint[] = [
    ...putIns
      .slice(0, cap)
      .filter((p) => p.status !== 'hidden')
      .map((p) => ({
        id: p._id as string,
        at: toLngLat(p.coord),
        kind: 'putIn' as const,
        ...(p.name ? { name: p.name } : {}),
      })),
    ...lots
      .slice(0, cap)
      .filter((l) => l.status !== 'hidden')
      .map((l) => ({
        id: l._id as string,
        at: toLngLat(l.coord),
        kind: 'lot' as const,
        ...(l.name ? { name: l.name } : {}),
      })),
  ];
  return { points, capped: putIns.length > cap || links.length > cap };
}

/** What an item's embedded map draws (see `InboxMapView`), its outlines bounded on bytes. */
export async function itemMapOf(
  r: InboxReader,
  item: Doc<'inboxItems'>,
): Promise<InboxMapView | null> {
  const built = await itemView(r, item);
  if (!built) return null;
  const view = built.view;
  const outlines = new OutlineBudget();
  const map: InboxMapView = {
    kind: item.kind,
    body: null,
    candidate: null,
    others: [],
    points: [],
    access: [],
    lookalikes: [],
    tracks: [],
    overlapShare: null,
    capped: false,
  };
  const bodyDoc = (id: Id<'waterBodies'> | null | undefined) =>
    r.get<'waterBodies'>('waterBody', id);
  /** A skate the item read serves, as a track — or, past the answer's bound or the budget, `capped`. */
  const addTrack = async (activityId: Id<'gpsActivities'>) => {
    const activity = await r.get<'gpsActivities'>('activity', activityId);
    if (!activity) {
      // Served by the item read a moment ago, so a miss here is the budget's: say the answer is short.
      map.capped = true;
      return;
    }
    const track = outlines.takeTrack(embedTrack(activity._id, activity.path));
    if (track) map.tracks.push(track);
  };
  switch (view.kind) {
    case 'flag': {
      const target = view.target;
      if (!target.exists) break;
      if (target.targetType === 'report') {
        map.body = outlines.take(ownOutline(await bodyDoc(target.report.body.waterBodyId)));
        map.points.push({ id: target.report.reportId, at: toLngLat(target.report.point) });
      } else if (target.targetType === 'hazard') {
        map.body = outlines.take(ownOutline(await bodyDoc(target.hazard.body?.waterBodyId)));
        if (target.hazard.point)
          map.points.push({ id: target.hazard.hazardId, at: toLngLat(target.hazard.point) });
      } else if (target.targetType === 'accessAlert') {
        const alert = await r.get<'accessAlerts'>('accessAlert', target.alert.accessAlertId);
        map.body = outlines.take(ownOutline(await bodyDoc(target.alert.body.waterBodyId)));
        const placeId = alert?.putInId ?? alert?.parkingAreaId;
        if (placeId && target.alert.place.point) {
          map.access.push({
            id: placeId as string,
            at: toLngLat(target.alert.place.point),
            kind: alert?.putInId ? 'putIn' : 'lot',
            ...(target.alert.place.name ? { name: target.alert.place.name } : {}),
          });
        }
      } else if (target.targetType === 'waterbody') {
        map.body = outlines.take(ownOutline(await bodyDoc(target.body.waterBodyId)));
      }
      break;
    }
    case 'access': {
      map.body = outlines.take(ownOutline(await bodyDoc(view.body.waterBodyId)));
      const access = await accessPointsOf(r, view.body.waterBodyId);
      map.access = access.points;
      map.capped ||= access.capped;
      break;
    }
    case 'request': {
      if (view.body) map.body = outlines.take(ownOutline(await bodyDoc(view.body.waterBodyId)));
      else if (view.candidate) {
        const c = view.candidate;
        map.candidate = outlines.take(
          embedOutline(
            c.externalId,
            c.name ?? 'Unnamed',
            c.polygon,
            MAP_BOUNDS.outlineBytes,
            MAP_BOUNDS.ringPoints,
          ),
        );
      }
      for (const ask of view.asks) map.points.push({ id: ask.requestId, at: toLngLat(ask.coord) });
      // Each asker's recorded skate the item read serves (at most `VIEW_SKATES`), never another.
      for (const ask of view.asks) {
        if (ask.skate !== null && ask.activityId !== null) await addTrack(ask.activityId);
      }
      if (view.candidate?.nearestKnown) {
        const near = outlines.take(
          neighborOutline(await bodyDoc(view.candidate.nearestKnown.waterBodyId)),
        );
        if (near) map.others.push(near);
      }
      break;
    }
    case 'place': {
      map.body = outlines.take(ownOutline(await bodyDoc(view.body.waterBodyId)));
      for (const ask of view.asks) {
        map.points.push({
          id: ask.requestId,
          at: toLngLat(ask.coord),
          ...(ask.name ? { name: ask.name } : {}),
        });
      }
      for (const l of view.lookalikes) {
        map.lookalikes.push(
          l.kind === 'landmark'
            ? { id: l.landmarkId, at: toLngLat(l.point), name: l.name }
            : { id: l.requestId, at: toLngLat(l.coord), name: l.name },
        );
      }
      break;
    }
    case 'drawn': {
      const drawn = await bodyDoc(view.body.waterBodyId);
      map.body = outlines.take(ownOutline(drawn));
      if (view.overlap) {
        const known = outlines.take(neighborOutline(await bodyDoc(view.overlap.body.waterBodyId)));
        if (known) map.others.push(known);
        map.overlapShare = view.overlap.share;
      }
      // The drawer's own skate the drawing came from, as the item read found it.
      if (view.skate?.hasTrack) await addTrack(view.skate.activityId);
      break;
    }
    case 'ticket':
      break;
  }
  map.capped ||= outlines.capped;
  return map;
}
