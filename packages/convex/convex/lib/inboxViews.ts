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
  coveredFraction,
  haversineMeters,
  INBOX_AGE_FLOORS_DAYS,
  INBOX_FACETS,
  INBOX_LANE_ORDER,
  INBOX_LANES,
  type LatLng,
  MERGE_SUGGEST_SHARE,
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
  AskMemberView,
  AuthorBlockView,
  BodyRefView,
  CandidateView,
  FlagMemberView,
  FlagTargetView,
  HazardSubjectView,
  InboxDecidedState,
  InboxItemView,
  InboxMapAccessPoint,
  InboxMapBody,
  InboxMapLngLat,
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
  TicketView,
} from '../inbox';
import { MAP_OUTLINE_BYTES, MAP_RING_POINTS } from '../inbox';
import { planPostRestore } from '../moderation';
import { NEIGHBOR_RING_POINTS, simplifiedRing } from './bodyGeo';
import { heldKindOn, type VerdictTargetType } from './contentVerdicts';
import { readCount } from './inboxItems';
import type { InboxRuleFacts, RuleTake } from './inboxRules';
import { liveLandmarksForBody } from './landmarkRows';
import { CHARGED_QUERY_BUDGET, type ReadBudget, type RowKind, requestBudget } from './readBudget';
import { type RecordFacts, recordFactsOf } from './recordRules';
import { trustClassFor } from './reputation';
import {
  askedAlongside,
  type DecisionAnswer,
  drawnBay,
  landmarkAskOf,
  landmarkProposalView,
  matchLandmark,
  requestNames,
} from './requestDecisions';

/** `Omit` over each member of a union, so a variant keeps its own fields. */
export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Members an item's view lists at most, of each status. */
export const VIEW_MEMBERS = 50;
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

  /** Up to `n` rows of `kind`, charged at their worst — or none when they don't fit. */
  async take<T>(kind: RowKind, n: number, read: (n: number) => Promise<T[]>): Promise<T[]> {
    const k = this.budget.rows(kind, n);
    return k > 0 ? this.budget.take(kind, k, read) : [];
  }

  /** An item's members of one status, oldest first. */
  members(itemId: Id<'inboxItems'>, status: 'open' | 'closed', n = VIEW_MEMBERS) {
    return this.take('small', n, (k) =>
      this.ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', status))
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
    photoCount: report.photoIds.length,
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
const RECORD_TARGETS = { report: true, post: true, comment: true, hazard: true } as const;
type RecordTarget = keyof typeof RECORD_TARGETS;
type RecordDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

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
  if (targetType !== 'post') return recordFactsOf(targetType, doc, held);
  const post = doc as Doc<'posts'>;
  r.budget.reserve('report', post.reportIds.length);
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
      const votes = await r.take('small', 200, (k) =>
        r.ctx.db
          .query('hazardConfirmations')
          .withIndex('by_hazard', (q) => q.eq('hazardId', h._id))
          .take(k),
      );
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
        confirmations: {
          up: votes.filter((v) => v.verdict !== 'fully_healed').length,
          down: votes.filter((v) => v.verdict === 'fully_healed').length,
        },
      };
      return { view: { ...base, targetType, hazard }, facts };
    }
    case 'photo': {
      const p = doc as Doc<'photos'>;
      const report = p.reportId ? await r.get<'reports'>('report', p.reportId) : null;
      const siblings = report ? report.photoIds : [];
      const photo: PhotoSubjectView = {
        photoId: p._id,
        caption: p.caption ?? null,
        takenAt: p.takenAt ?? null,
        createdAt: p.createdAt,
        url: await r.ctx.storage.getUrl(p.storageId),
        thumbUrl: await r.ctx.storage.getUrl(p.thumbStorageId),
        reportId: p.reportId ?? null,
        body: report ? bodyRef(await r.get<'waterBodies'>('waterBody', report.waterBodyId)) : null,
        siblings: [],
        indexOnReport: report ? siblings.indexOf(p._id) : null,
      };
      return { view: { ...base, targetType, photo }, facts: { ...facts, targetStatus: null } };
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
    },
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
    body,
  };
  switch (item.kind) {
    case 'flag': {
      const flags = (
        await Promise.all(
          members.map((m) =>
            r.get<'contentFlags'>('contentFlag', m.sourceId as Id<'contentFlags'>),
          ),
        )
      ).filter((f): f is Doc<'contentFlags'> => f !== null);
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
      const latest = members.at(-1);
      const flag = latest
        ? await r.get<'contentFlags'>('contentFlag', latest.sourceId as Id<'contentFlags'>)
        : null;
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
      const asks = (
        await Promise.all(
          members.map((m) =>
            r.get<'waterBodyRequests'>('waterBodyRequest', m.sourceId as Id<'waterBodyRequests'>),
          ),
        )
      ).filter((a): a is Doc<'waterBodyRequests'> => a !== null);
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
      const over = water?.duplicateCandidateIds?.[0];
      const overBody = over ? await r.get<'waterBodies'>('waterBody', over) : null;
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

type ItemFacts = { view: DistOmit<InboxItemView, 'can' | 'decided'>; facts: InboxRuleFacts };

/** An item as its handler draws it, and the facts its verbs' preconditions read. */
export async function itemView(r: InboxReader, item: Doc<'inboxItems'>): Promise<ItemFacts | null> {
  const open = await r.members(item._id, 'open');
  const closed = await r.members(item._id, 'closed');
  const members = [...open, ...closed].sort((a, b) => a.filedAt - b.filedAt);
  const base = {
    itemId: item._id,
    lane: item.lane,
    facet: item.facet,
    filedAt: item.filedAt,
    lastActivityAt: item.lastActivityAt,
    memberCount: item.memberCount,
  };
  switch (item.kind) {
    case 'flag': {
      const flags = (await Promise.all(members.map((m) => flagMember(r, m)))).filter(
        (f): f is FlagMemberView => f !== null,
      );
      const firstFlag = members[0]
        ? await r.get<'contentFlags'>('contentFlag', members[0].sourceId as Id<'contentFlags'>)
        : null;
      if (!firstFlag) return null;
      const { view: target, facts } = await flagTargetView(r, firstFlag);
      const author =
        firstFlag.targetType === 'user' ? null : await authorBlock(r, item.subjectUserId);
      return { view: { ...base, kind: 'flag', target, flags, author }, facts };
    }
    case 'access': {
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId);
      const body = bodyRef(water);
      if (!body || !water) return null;
      const reports = (await Promise.all(members.map((m) => flagMember(r, m))))
        .filter((f): f is FlagMemberView => f !== null)
        .sort((a, b) => b.filedAt - a.filedAt);
      const p = water.publicAccess;
      // What the ruler cited: the ruling's own audit row (the latest `set_public_access`).
      const audit = p
        ? await r.take('moderationAction', 1, (k) =>
            r.ctx.db
              .query('moderationActions')
              .withIndex('by_target_action', (q) =>
                q
                  .eq('targetType', 'waterbody')
                  .eq('targetId', water._id)
                  .eq('action', 'set_public_access'),
              )
              .order('desc')
              .take(k),
          )
        : [];
      const ruling: RulingView | null = p
        ? {
            verdict: p.verdict,
            ruledAt: p.decidedAt,
            by: personRef(await r.get<'profiles'>('profile', p.decidedByUserId)),
            note: p.note ?? null,
            reason: audit[0]?.reason ?? null,
          }
        : null;
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
      if (p) {
        const dismissed = await r.take('contentFlag', 20, (k) =>
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
        for (const f of dismissed.filter((x) => x.resolvedAt === p.decidedAt)) {
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
        view: { ...base, kind: 'access', body, reports, ruling, dismissedByRuling, contestAsks },
        facts: { hasRuling: p !== undefined },
      };
    }
    case 'request':
    case 'place': {
      const asks = (await Promise.all(members.map((m) => askMember(r, m)))).filter(
        (a): a is { view: AskMemberView; doc: Doc<'waterBodyRequests'> } => a !== null,
      );
      const first = asks[0]?.doc;
      if (!first) return null;
      const water = await r.get<'waterBodies'>('waterBody', item.waterBodyId ?? first.waterBodyId);
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
              nearestKnown: null,
            }
          : null;
        return {
          view: {
            ...base,
            kind: 'request',
            requestKind: first.kind,
            body,
            asks: asks.map((a) => a.view),
            candidate,
            resolveError: first.resolveError ?? null,
          },
          facts: {
            requestKind: first.kind,
            hasCandidate: candidate !== null,
            resolveError: first.resolveError ?? null,
            candidateFlowing: c !== undefined && c.cls === undefined,
            // Its siblings are its own question's asks either way: one answer for both verbs.
            askedAlongside: await alongsideOf(r, first, {}, {}),
          },
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
        const others = asks.slice(1).map((a) => a.doc);
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
          asks: asks.map((a) => a.view),
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
      return {
        view: {
          ...base,
          kind: 'drawn',
          body,
          drawer: personLockup(await r.get<'profiles'>('profile', water.createdByUserId), r.now),
          overlap: await overlapOf(r, water),
          fromReport: null,
        },
        facts: { hasOverlap: (water.duplicateCandidateIds?.length ?? 0) > 0 },
      };
    }
    case 'ticket': {
      const m = members[0];
      const t = m
        ? await r.get<'supportTickets'>('supportTicket', m.sourceId as Id<'supportTickets'>)
        : null;
      if (!t) return null;
      const ticket: TicketView = {
        ticketId: t._id,
        category: t.category,
        body: t.body,
        createdAt: t.createdAt,
        status: t.status === 'resolved' ? 'resolved' : 'open',
        context: t.context ?? null,
        resolvedAt: t.resolvedAt ?? null,
        resolvedBy: personRef(await r.get<'profiles'>('profile', t.resolvedByUserId)),
      };
      return {
        view: {
          ...base,
          kind: 'ticket',
          ticket,
          messages: [],
          person: await authorBlock(r, t.userId),
        },
        facts: {},
      };
    }
  }
}

/**
 * Whether an ask's approval (by its answer) and its decline would each close one of the viewer's own
 * asks in another item — `askedAlongside`, read through the item's budget.
 */
async function alongsideOf(
  r: InboxReader,
  first: Doc<'waterBodyRequests'>,
  approve: DecisionAnswer,
  decline: DecisionAnswer,
): Promise<{ approve: boolean; decline: boolean }> {
  const take: RuleTake = (n, read) => r.take('small', n, read);
  const readAsk = (id: Id<'waterBodyRequests'>) =>
    r.get<'waterBodyRequests'>('waterBodyRequest', id);
  return {
    approve: await askedAlongside(r.ctx, first, r.viewerId, approve, take, readAsk),
    decline: await askedAlongside(r.ctx, first, r.viewerId, decline, take, readAsk),
  };
}

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
 * A drawing's share inside the known body it overlaps (the first of its dedup candidates), from core's
 * `coveredFraction`; `null` when it overlaps none, the body is gone, or the clipper can't say.
 */
export async function overlapOf(
  r: InboxReader,
  drawn: Doc<'waterBodies'>,
): Promise<OverlapView | null> {
  const id = drawn.duplicateCandidateIds?.[0];
  const known = id ? await r.get<'waterBodies'>('waterBody', id) : null;
  const body = bodyRef(known);
  if (!known || !body || !drawn.polygon || !known.polygon) return null;
  let share: number;
  try {
    share = coveredFraction(
      drawn.polygon as Polygon | MultiPolygon,
      known.polygon as Polygon | MultiPolygon,
    );
  } catch {
    return null;
  }
  return { share, body, suggested: share >= MERGE_SUGGEST_SHARE };
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
    const bytes = getDocumentSize(outline.outline as never);
    if (bytes > this.left) {
      this.capped = true;
      return null;
    }
    this.left -= bytes;
    return outline;
  }
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
    overlapShare: null,
    capped: false,
  };
  const bodyDoc = (id: Id<'waterBodies'> | null | undefined) =>
    r.get<'waterBodies'>('waterBody', id);
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
      break;
    }
    case 'ticket':
      break;
  }
  map.capped ||= outlines.capped;
  return map;
}
