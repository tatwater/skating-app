/**
 * The inbox resolver (N8/A2): stored rows → `NotificationView`s a client can render.
 *
 * A notification row is ids in a `v.any()` payload. Rendering "Ellie found your report on Lake Morey
 * helpful" means resolving those ids, and the resolution has to survive the content having changed
 * since the row was written:
 *
 * - **The target may be hidden or removed** (D32). The row renders degraded — `available: false`,
 *   described as "a report that's no longer available" — and is never a dead tap. It must not vanish
 *   either: a disappearing inbox row reads like a bug (founder call, N8 #5).
 * - **The actor may have departed.** Under D62 they're anonymized, not erased, so names come through
 *   `publicAuthor` — the same tombstone shape every other surface uses — rather than a new fallback.
 * - **The actor may be blocked.** Block == mute (Phase 3): a block doesn't hide content, but it must
 *   not ring your phone. Actor-keyed rows are filtered through the viewer's block set at **read**
 *   time, so a block applies to old rows too; a row with no unblocked actors left is dropped.
 * - **The payload may be a shape this code has never seen** — a row from before the payloads were
 *   typed, or a type retired after the row was written. `parsePayload` returns `null` and the row
 *   renders as the `unknown` variant instead of throwing the page away.
 *
 * Every referenced document is loaded once per page through a memo, so a page of thirty rows about
 * the same lake costs one body read, not thirty — the N+1 shape N1 dug out of the read path stays out.
 */

import type {
  HazardLifecyclePhase,
  NotificationActors,
  NotificationBodyRef,
  NotificationView,
} from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicAuthor } from './authorView';

// ── Payload parsing ──────────────────────────────────────────────────────────────────────────────

const isString = (x: unknown): x is string => typeof x === 'string';
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(isString);
const asRecord = (x: unknown): Record<string, unknown> | null =>
  typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null;

/** The typed reading of a stored payload — the other half of `ActorPayload` in `notificationQueue`. */
type ParsedPayload =
  | {
      kind: 'thumb';
      targetType: 'report' | 'hazard';
      targetId: string;
      actorIds: string[];
      count: number;
    }
  | { kind: 'corroboration'; reportId: string; count: number }
  | { kind: 'comment'; reply: boolean; reportId: string; actorIds: string[]; count: number }
  | { kind: 'hazard_lifecycle'; hazardId: string; phase: HazardLifecyclePhase }
  | { kind: 'flag_resolved'; resolution: 'actioned' | 'dismissed' }
  | { kind: 'bounty_request'; bountyId: string; waterBodyId: string }
  | { kind: 'bounty_answered'; bountyId: string; waterBodyId: string; count: number }
  | { kind: 'report_bucket'; waterBodyId: string; reportId: string; count: number }
  | {
      kind: 'digest';
      bodies: { waterBodyId: string; reportId: string; count: number }[];
      totalCount: number;
    }
  | { kind: 'activity'; activityId: string; waterBodyId?: string; startTime: number };

const HAZARD_PHASES: ReadonlySet<string> = new Set<HazardLifecyclePhase>([
  'provisional',
  'confirmed',
  'healing_unsafe',
  'disputed',
  'archived',
]);

/** Narrow a stored payload by its row's type, or `null` when the shape isn't one this code writes. */
export function parsePayload(
  type: Doc<'notifications'>['type'],
  raw: unknown,
): ParsedPayload | null {
  const p = asRecord(raw);
  if (!p) return null;
  const count = isNumber(p.count) ? p.count : 1;
  switch (type) {
    case 'report_rated':
      if (p.kind === 'thumb') {
        if ((p.targetType !== 'report' && p.targetType !== 'hazard') || !isString(p.targetId))
          return null;
        return {
          kind: 'thumb',
          targetType: p.targetType,
          targetId: p.targetId,
          actorIds: isStringArray(p.actorIds) ? p.actorIds : [],
          count,
        };
      }
      if (p.kind === 'corroboration' && isString(p.reportId)) {
        return { kind: 'corroboration', reportId: p.reportId, count };
      }
      return null;
    case 'report_commented':
      if (!isString(p.reportId)) return null;
      return {
        kind: 'comment',
        reply: p.reply === true,
        reportId: p.reportId,
        actorIds: isStringArray(p.actorIds) ? p.actorIds : [],
        count,
      };
    case 'hazard_confirmation':
      if (!isString(p.hazardId) || !isString(p.phase) || !HAZARD_PHASES.has(p.phase)) return null;
      return {
        kind: 'hazard_lifecycle',
        hazardId: p.hazardId,
        phase: p.phase as HazardLifecyclePhase,
      };
    case 'content_flag_resolved':
      if (p.resolution !== 'actioned' && p.resolution !== 'dismissed') return null;
      return { kind: 'flag_resolved', resolution: p.resolution };
    case 'bounty_request':
      if (!isString(p.bountyId) || !isString(p.waterBodyId)) return null;
      return { kind: 'bounty_request', bountyId: p.bountyId, waterBodyId: p.waterBodyId };
    case 'bounty_answered':
      if (!isString(p.bountyId) || !isString(p.waterBodyId)) return null;
      return { kind: 'bounty_answered', bountyId: p.bountyId, waterBodyId: p.waterBodyId, count };
    case 'favorite_report':
    case 'great_report_nearby':
      if (!isString(p.waterBodyId) || !isString(p.reportId)) return null;
      return { kind: 'report_bucket', waterBodyId: p.waterBodyId, reportId: p.reportId, count };
    case 'nearby_report_digest': {
      if (!Array.isArray(p.bodies)) return null;
      const bodies: { waterBodyId: string; reportId: string; count: number }[] = [];
      for (const entry of p.bodies) {
        const b = asRecord(entry);
        if (!b || !isString(b.waterBodyId) || !isString(b.reportId)) continue;
        bodies.push({
          waterBodyId: b.waterBodyId,
          reportId: b.reportId,
          count: isNumber(b.count) ? b.count : 1,
        });
      }
      if (bodies.length === 0) return null;
      return {
        kind: 'digest',
        bodies,
        totalCount: isNumber(p.totalCount) ? p.totalCount : bodies.reduce((n, b) => n + b.count, 0),
      };
    }
    case 'activity_detected':
      if (!isString(p.activityId) || !isNumber(p.startTime)) return null;
      return {
        kind: 'activity',
        activityId: p.activityId,
        ...(isString(p.waterBodyId) ? { waterBodyId: p.waterBodyId } : {}),
        startTime: p.startTime,
      };
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────

/** A per-page document memo: each id is read once no matter how many rows reference it. */
class Loader {
  private readonly memo = new Map<string, Promise<unknown>>();
  constructor(private readonly ctx: QueryCtx) {}

  get<T extends 'profiles' | 'reports' | 'hazards' | 'bounties' | 'waterBodies' | 'gpsActivities'>(
    table: T,
    id: string,
  ): Promise<Doc<T> | null> {
    const key = `${table}:${id}`;
    let pending = this.memo.get(key);
    if (!pending) {
      const normalized = this.ctx.db.normalizeId(table, id);
      pending = normalized ? this.ctx.db.get(normalized) : Promise.resolve(null);
      this.memo.set(key, pending);
    }
    return pending as Promise<Doc<T> | null>;
  }
}

/**
 * Resolve one page of a viewer's rows. Rows whose every actor is blocked are omitted (the read-time
 * half of block == mute); everything else comes back, degraded where it has to.
 */
export async function resolveNotifications(
  ctx: QueryCtx,
  rows: readonly Doc<'notifications'>[],
  blocked: ReadonlySet<string>,
  now: number,
): Promise<NotificationView[]> {
  const load = new Loader(ctx);
  // Rows resolve concurrently rather than one `await` chain at a time: a page is thirty rows of a
  // few reads each, and serialising them is thirty times the round trips for no ordering benefit —
  // `Promise.all` keeps the page order, and the memo dedups across rows regardless of which one
  // asked first because it stores the *promise*, set synchronously before any read resolves.
  const views = await Promise.all(rows.map((row) => resolveOne(load, row, blocked, now)));
  return views.filter((view): view is NotificationView => view !== null);
}

async function bodyRef(load: Loader, id: string | undefined): Promise<NotificationBodyRef | null> {
  if (id === undefined) return null;
  const body = await load.get('waterBodies', id);
  return body ? { id: body._id, name: body.name } : null;
}

/** Names for the sentence, blocked actors removed. `null` when nobody is left to attribute it to. */
async function actorsFor(
  load: Loader,
  actorIds: readonly string[],
  blocked: ReadonlySet<string>,
  now: number,
): Promise<NotificationActors | null> {
  const kept = actorIds.filter((id) => !blocked.has(id));
  // An old row with no actor list at all (pre-N8 shape) still describes something that happened;
  // "Someone" is the honest attribution rather than dropping it.
  if (actorIds.length > 0 && kept.length === 0) return null;
  const names: string[] = [];
  for (const id of kept.slice(0, 2)) {
    const profile = await load.get('profiles', id);
    names.push(publicAuthor(profile, now).displayName);
  }
  return { names, count: kept.length };
}

async function resolveOne(
  load: Loader,
  row: Doc<'notifications'>,
  blocked: ReadonlySet<string>,
  now: number,
): Promise<NotificationView | null> {
  const base = {
    id: row._id,
    createdAt: row.createdAt,
    ...(row.readAt !== undefined ? { readAt: row.readAt } : {}),
  };
  const payload = parsePayload(row.type, row.payload);
  if (!payload) return { ...base, type: 'unknown' };

  switch (payload.kind) {
    case 'thumb': {
      const actors = await actorsFor(load, payload.actorIds, blocked, now);
      if (!actors) return null;
      const target =
        payload.targetType === 'report'
          ? await load.get('reports', payload.targetId)
          : await load.get('hazards', payload.targetId);
      const available = target?.moderationStatus === 'visible';
      return {
        ...base,
        type: 'report_rated',
        kind: 'thumb',
        targetType: payload.targetType,
        target: { id: payload.targetId, available },
        body: await bodyRef(load, target?.waterBodyId),
        actors,
      };
    }
    case 'corroboration': {
      const report = await load.get('reports', payload.reportId);
      return {
        ...base,
        type: 'report_rated',
        kind: 'corroboration',
        target: { id: payload.reportId, available: report?.moderationStatus === 'visible' },
        body: await bodyRef(load, report?.waterBodyId),
        count: payload.count,
      };
    }
    case 'comment': {
      const actors = await actorsFor(load, payload.actorIds, blocked, now);
      if (!actors) return null;
      const report = await load.get('reports', payload.reportId);
      return {
        ...base,
        type: 'report_commented',
        reply: payload.reply,
        target: { id: payload.reportId, available: report?.moderationStatus === 'visible' },
        body: await bodyRef(load, report?.waterBodyId),
        actors,
        count: payload.count,
      };
    }
    case 'hazard_lifecycle': {
      const hazard = await load.get('hazards', payload.hazardId);
      return {
        ...base,
        type: 'hazard_confirmation',
        target: { id: payload.hazardId, available: hazard?.moderationStatus === 'visible' },
        body: await bodyRef(load, hazard?.waterBodyId),
        phase: payload.phase,
      };
    }
    case 'flag_resolved':
      return { ...base, type: 'content_flag_resolved', resolution: payload.resolution };
    case 'bounty_request': {
      const bounty = await load.get('bounties', payload.bountyId);
      return {
        ...base,
        type: 'bounty_request',
        target: { id: payload.bountyId, available: bounty?.status === 'open' },
        body: await bodyRef(load, payload.waterBodyId),
      };
    }
    case 'bounty_answered': {
      const bounty = await load.get('bounties', payload.bountyId);
      // "Available" here means there's still something to do — a bounty already ruled on isn't a
      // dead end exactly, but the ask ("mark it helpful") no longer applies, and the bounty page
      // still opens from the lake.
      return {
        ...base,
        type: 'bounty_answered',
        target: { id: payload.bountyId, available: bounty !== null },
        body: await bodyRef(load, payload.waterBodyId),
        count: payload.count,
      };
    }
    case 'report_bucket': {
      const report = await load.get('reports', payload.reportId);
      return {
        ...base,
        type: row.type === 'great_report_nearby' ? 'great_report_nearby' : 'favorite_report',
        target: { id: payload.reportId, available: report?.moderationStatus === 'visible' },
        body: await bodyRef(load, payload.waterBodyId),
        count: payload.count,
      };
    }
    case 'digest': {
      const bodies: Extract<NotificationView, { type: 'nearby_report_digest' }>['bodies'] = [];
      for (const entry of payload.bodies) {
        const report = await load.get('reports', entry.reportId);
        bodies.push({
          body: await bodyRef(load, entry.waterBodyId),
          target: { id: entry.reportId, available: report?.moderationStatus === 'visible' },
          count: entry.count,
        });
      }
      return { ...base, type: 'nearby_report_digest', bodies, totalCount: payload.totalCount };
    }
    case 'activity':
      return {
        ...base,
        type: 'activity_detected',
        activityId: payload.activityId,
        body: await bodyRef(load, payload.waterBodyId),
        startTime: payload.startTime,
      };
  }
}
