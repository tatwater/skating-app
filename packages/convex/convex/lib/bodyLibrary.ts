/**
 * **The one writer of the Bodies library** (B01-3) — `bodyLibraryRows` and the `bodyLibraryCounts`
 * that move with them. The design is in B01 §12.8, *The Bodies library on the server*.
 *
 * ## Recomputed from the records, never patched by a caller
 *
 * {@link refreshBodyLibrary} reads the body and what its completeness, asks and reports figures need,
 * builds every row the body is listed under (one per scope), writes only what changed, and applies
 * the difference between the old rows' count keys and the new ones in the same transaction. Nothing
 * else writes either table, so a count is the tally of the rows by construction (`countDeltas` in
 * `@skating/core`, fast-checked there). It is idempotent: a second call in one mutation reads what
 * the first wrote and changes nothing.
 *
 * ## Where it is called
 *
 * - **`writeAudit`** — every audited action whose target belongs to a body ({@link bodiesOfTarget}).
 *   A moderator's action on the body, its bays, landmarks or put-ins also stamps *Changed*.
 * - **`recomputeBodySummary`** — every report write and report moderation already calls it.
 * - **{@link queueLibraryRefresh}** — the machine's bulk writes that leave no audit row; the minute
 *   cron drains the queue ({@link drainLibraryQueue}).
 *
 * ## Every read is bounded
 *
 * By rows (each `take` below has its cap) and by weight: the heaviest is the body itself (its
 * polygon — ~300 KB for Champlain) and its newest {@link REPORT_SCAN} reports, read once and shared by
 * the season's count and the put-ins a report cluster derives.
 */

import {
  bodyCompleteness,
  type CountFootprint,
  completeOption,
  countDeltas,
  countKeysOf,
  currentSeason,
  type LibraryFacetFacts,
  type LibraryStanding,
  laneOf,
  libraryScopes,
  librarySearchText,
  libraryStandingOf,
  nameSortKey,
  parseCountAddress,
  REQUEST_KINDS,
  SCOPE_ALL,
  seasonRecordSpan,
  sizeOption,
  unknownLastKeys,
  waterBodyClassLabel,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { MAX_ACCESS_ROWS_PER_BODY } from './accessLimits';
import type { ModerationTargetType } from './audit';
import { PUT_IN_REPORT_SCAN, putInMarkersForBody } from './putInMarkers';

/** The newest reports a refresh reads: the season's count and the put-in clusters share them. */
export const REPORT_SCAN = 300;
/** The most open asks of one kind a refresh counts. */
const ASK_CAP = 100;
/** An unchanged row's `refreshedAt` is moved on when older than this (the drift repair's progress). */
const REFRESHED_STALE_MS = 86_400_000;
/** The most rows one body can have (every state it touches, and `*`). */
const MAX_SCOPES = 16;

type Row = Doc<'bodyLibraryRows'>;
type RowFields = Omit<Row, '_id' | '_creationTime'>;

// ── The facts ────────────────────────────────────────────────────────────────────────────────

/** Whether contours were drawn for the body (`bathymetryCoverage`, keyed as the tiles are). */
export async function hasContoursFor(
  ctx: QueryCtx,
  body: Pick<Doc<'waterBodies'>, 'source' | 'externalId'>,
): Promise<boolean> {
  if (body.source === 'user' || body.externalId === undefined) return false;
  const source = body.source;
  const externalId = body.externalId;
  const row = await ctx.db
    .query('bathymetryCoverage')
    .withIndex('by_external_id', (q) => q.eq('source', source).eq('externalId', externalId))
    .first();
  return row !== null;
}

/** Whether a visible lot serves the body. Asserted links first, as `loadParkingForBody` reads them. */
export async function hasLotFor(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<boolean> {
  for (const inferred of [false, true]) {
    const links = await ctx.db
      .query('parkingAreaBodies')
      .withIndex('by_water_body_inferred', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('inferred', inferred),
      )
      .take(MAX_ACCESS_ROWS_PER_BODY);
    for (const link of links) {
      const lot = await ctx.db.get(link.parkingAreaId);
      if (lot?.status === 'visible') return true;
    }
  }
  return false;
}

/** Whether a live landmark is on the body. */
export async function hasLandmarkFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<boolean> {
  const live = await ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined),
    )
    .first();
  return live !== null;
}

/**
 * What is asked of a body and still open: skaters' corpus requests, flags on the body, and the
 * email corpus's place names. `waiting` is whether a person is waiting on one — a request or a flag
 * (a place name from the email corpus has nobody waiting on an answer).
 */
export async function openAsksFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<{ count: number; waiting: boolean }> {
  let requests = 0;
  for (const kind of REQUEST_KINDS) {
    const rows = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('kind', kind).eq('status', 'open'),
      )
      .take(ASK_CAP);
    requests += rows.length;
  }
  let flags = 0;
  for (const status of ['open', 'reviewing'] as const) {
    const rows = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q.eq('targetType', 'waterbody').eq('targetId', waterBodyId).eq('status', status),
      )
      .take(ASK_CAP);
    flags += rows.length;
  }
  const names = await ctx.db
    .query('corpusPlaceNames')
    .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
    .take(ASK_CAP);
  return { count: requests + flags + names.length, waiting: requests + flags > 0 };
}

/**
 * The reports figures: visible reports in the current season's record (empty from 1 July to 30
 * September — the new season's record opens 1 October), and whether the body was ever reported.
 * Returns the newest reports read, for the put-in derivation.
 */
export async function reportFactsFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number,
): Promise<{
  reports: number;
  season: number;
  everReported: boolean;
  newest: Doc<'reports'>[];
}> {
  const season = currentSeason(now);
  const span = seasonRecordSpan(season, now);
  const newest = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .take(REPORT_SCAN);
  const visible = newest.filter((r) => r.moderationStatus === 'visible');
  const reports =
    span === null
      ? 0
      : visible.filter((r) => r.skateEndTime >= span.from && r.skateEndTime < span.to).length;
  let everReported = visible.length > 0;
  if (!everReported && newest.length === REPORT_SCAN) {
    // Every newest report is hidden: an older visible one still counts. Rare, and bounded by the
    // body's own reports.
    const older = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
      .filter((q) => q.eq(q.field('moderationStatus'), 'visible'))
      .first();
    everReported = older !== null;
  }
  return { reports, season, everReported, newest };
}

/** The names a body is also known by: every claim but its displayed name, once each. */
export function aliasesOf(body: Pick<Doc<'waterBodies'>, 'name' | 'nameClaims'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const claim of body.nameClaims ?? []) {
    const value = claim.value.trim();
    if (value === '' || value === body.name || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Every id a body is found by: ours, its key, and each catalog's. */
export function idsOf(body: Doc<'waterBodies'>): string[] {
  return [
    body._id,
    body.waterBodyKey,
    body.externalId,
    body.osmId,
    body.nhdId,
    body.threeDhpId,
    body.gnisId,
  ].filter((id): id is string => id !== undefined && id !== '');
}

/** Awaiting enrichment: activated, and an enrichment pass hasn't given it elevation, wind or depth. */
export function awaitingEnrichment(body: Doc<'waterBodies'>): boolean {
  if (body.activatedAt === undefined) return false;
  return (
    body.elevationM === undefined ||
    body.windRose === undefined ||
    (body.meanDepthM === undefined && body.maxDepthM === undefined)
  );
}

/** A body's rows, minus the scope and the change date — what every scope shares. */
export async function libraryFieldsFor(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
  standing: LibraryStanding,
  now: number,
): Promise<Omit<RowFields, 'scope' | 'changedAt' | 'changedAsc' | 'changedDesc'>> {
  const reportFacts = await reportFactsFor(ctx, body._id, now);
  const putIns = await putInMarkersForBody(ctx, body, {
    reports: reportFacts.newest.slice(0, PUT_IN_REPORT_SCAN),
    firstOnly: true,
  });
  const lots = await hasLotFor(ctx, body._id);
  const landmarks = await hasLandmarkFor(ctx, body._id);
  const hasContours = await hasContoursFor(ctx, body);
  const asks = await openAsksFor(ctx, body._id);
  const complete = bodyCompleteness({
    polygon: body.polygon as { type: string; coordinates: unknown },
    name: body.name,
    publicAccess: body.publicAccess ?? null,
    accessKind: body.accessKind ?? null,
    maxDepthM: body.maxDepthM,
    meanDepthM: body.meanDepthM,
    elevationM: body.elevationM,
    windRose: body.windRose,
    putIns: putIns.length,
    lots: lots ? 1 : 0,
    landmarks: landmarks ? 1 : 0,
    hasContours,
  });
  const aliases = aliasesOf(body);
  const states = libraryScopes(body.states).slice(1);
  const area =
    body.surfaceAreaSqM !== undefined && body.surfaceAreaSqM > 0 ? body.surfaceAreaSqM : null;
  const areaKeys = unknownLastKeys(area);
  const size = sizeOption(area);
  return {
    waterBodyId: body._id,
    lane: laneOf(standing),
    standing,
    name: body.name,
    nameKey: nameSortKey(body.name),
    aliases,
    searchText: librarySearchText(body.name, aliases, idsOf(body)),
    bodyClass: body.type,
    classKey: waterBodyClassLabel(body.type).toLocaleLowerCase('en-US'),
    states,
    statesKey: states.join(' '),
    ...(area !== null ? { areaSqM: area } : {}),
    areaAsc: areaKeys.asc,
    areaDesc: areaKeys.desc,
    ...(size !== null ? { size } : {}),
    outline: (body.geometrySource ?? body.source) === 'user' ? 'drawn' : 'catalog',
    hasPutIns: putIns.length > 0,
    completeHave: complete.have,
    completeOf: complete.of,
    missing: complete.missing,
    complete: completeOption(complete.have, complete.of),
    asks: asks.count,
    asksWaiting: asks.waiting,
    reports: reportFacts.reports,
    reportsSeason: reportFacts.season,
    everReported: reportFacts.everReported,
    curated: (body.curatedBoost ?? 0) > 0,
    intake: body.reviewReason !== undefined,
    awaitingEnrichment: awaitingEnrichment(body),
    refreshedAt: now,
  };
}

// ── Footprints and counts ────────────────────────────────────────────────────────────────────

/** The facet facts a stored row was filed under. */
export function factsOfRow(row: Pick<Row, keyof LibraryFacetFacts | 'areaSqM'>): LibraryFacetFacts {
  return {
    bodyClass: row.bodyClass,
    areaSqM: row.areaSqM ?? null,
    outline: row.outline,
    hasPutIns: row.hasPutIns,
    reports: row.reports,
    everReported: row.everReported,
    completeHave: row.completeHave,
    completeOf: row.completeOf,
    curated: row.curated,
    asks: row.asks,
    intake: row.intake,
    awaitingEnrichment: row.awaitingEnrichment,
  };
}

function footprintOf(rows: readonly RowFields[]): CountFootprint | null {
  const all = rows.find((r) => r.scope === SCOPE_ALL);
  if (all === undefined) return null;
  return { lane: all.lane, scopes: rows.map((r) => r.scope), keys: countKeysOf(factsOfRow(all)) };
}

/** Apply count deltas: each count moves in place; a count of zero is deleted. */
export async function applyCountDeltas(
  ctx: MutationCtx,
  deltas: ReadonlyMap<string, number>,
): Promise<void> {
  for (const [address, delta] of deltas) {
    if (delta === 0) continue;
    const { lane, scope, key } = parseCountAddress(address);
    const row = await ctx.db
      .query('bodyLibraryCounts')
      .withIndex('by_lane_scope_key', (q) => q.eq('lane', lane).eq('scope', scope).eq('key', key))
      .first();
    const next = (row?.count ?? 0) + delta;
    if (row === null) {
      // A decrement of a count never written is drift; it stays at zero rather than going negative.
      if (next > 0) await ctx.db.insert('bodyLibraryCounts', { lane, scope, key, count: next });
    } else if (next <= 0) {
      await ctx.db.delete(row._id);
    } else {
      await ctx.db.patch(row._id, { count: next });
    }
  }
}

// ── The refresh ──────────────────────────────────────────────────────────────────────────────

/** Whether two stored rows say the same thing, ignoring when they were refreshed. */
function sameRow(a: RowFields, b: RowFields): boolean {
  const { refreshedAt: _a, ...ra } = a;
  const { refreshedAt: _b, ...rb } = b;
  return JSON.stringify(ra, Object.keys(ra).sort()) === JSON.stringify(rb, Object.keys(rb).sort());
}

function stripSystem(row: Row): RowFields {
  const { _id, _creationTime, ...rest } = row;
  return rest;
}

/**
 * Recompute one body's library rows from its records and move the counts with them.
 *
 * - `known` — the body, when the caller already holds it (a backfill page);
 * - `changedAt` — stamp *Changed* (a moderator acted on the body or its bays, landmarks, put-ins);
 *   otherwise the stored date stands.
 *
 * A body that is gone or merged loses its rows. Writes only what changed.
 */
export async function refreshBodyLibrary(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  opts: { known?: Doc<'waterBodies'>; changedAt?: number; now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  const existing = await ctx.db
    .query('bodyLibraryRows')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(MAX_SCOPES);
  const body = opts.known ?? (await ctx.db.get(waterBodyId));
  const standing = body ? libraryStandingOf(body) : null;
  const before = footprintOf(existing.map(stripSystem));

  if (!body || standing === null) {
    for (const row of existing) await ctx.db.delete(row._id);
    await applyCountDeltas(ctx, countDeltas(before, null));
    return;
  }

  const shared = await libraryFieldsFor(ctx, body, standing, now);
  const storedChange = existing.reduce<number | undefined>(
    (latest, r) =>
      r.changedAt === undefined ? latest : Math.max(latest ?? r.changedAt, r.changedAt),
    undefined,
  );
  const changedAt =
    opts.changedAt === undefined
      ? storedChange
      : Math.max(opts.changedAt, storedChange ?? opts.changedAt);
  const changedKeys = unknownLastKeys(changedAt);
  const next: RowFields[] = libraryScopes(body.states).map((scope) => ({
    ...shared,
    scope,
    ...(changedAt !== undefined ? { changedAt } : {}),
    changedAsc: changedKeys.asc,
    changedDesc: changedKeys.desc,
  }));

  const byScope = new Map(existing.map((r) => [r.scope, r]));
  for (const row of next) {
    const old = byScope.get(row.scope);
    byScope.delete(row.scope);
    if (old === undefined) {
      await ctx.db.insert('bodyLibraryRows', row);
    } else if (!sameRow(stripSystem(old), row)) {
      // `replace` rather than `patch`: a field that became unknown (an area cleared) is dropped.
      await ctx.db.replace(old._id, row);
    } else if (old.refreshedAt < now - REFRESHED_STALE_MS) {
      // Unchanged, but read again: say so, at most daily, so the drift repair moves on from it.
      await ctx.db.patch(old._id, { refreshedAt: now });
    }
  }
  for (const stale of byScope.values()) await ctx.db.delete(stale._id);
  await applyCountDeltas(ctx, countDeltas(before, footprintOf(next)));
}

// ── Which body an audited action belongs to ──────────────────────────────────────────────────

/** Targets a moderator's action on stamps *Changed* (the ruling: the body, its bays, landmarks, put-ins). */
const CHANGES_THE_BODY: ReadonlySet<ModerationTargetType> = new Set([
  'waterbody',
  'waterBodySubArea',
  'bodyLandmark',
  'putIn',
]);

/** The most bodies one lot's audit row refreshes. */
const LOT_BODY_CAP = 16;

/**
 * The bodies an audited action's target belongs to, and whether it counts as a change to them.
 * A target that is not about a body (a person, a report, a comment) belongs to none.
 */
export async function bodiesOfTarget(
  ctx: QueryCtx,
  targetType: ModerationTargetType,
  targetId: string,
): Promise<{ bodies: Id<'waterBodies'>[]; changes: boolean }> {
  const changes = CHANGES_THE_BODY.has(targetType);
  const one = (id: Id<'waterBodies'> | undefined | null) => ({
    bodies: id ? [id] : [],
    changes,
  });
  switch (targetType) {
    case 'waterbody':
      return one(ctx.db.normalizeId('waterBodies', targetId));
    case 'waterBodySubArea': {
      const id = ctx.db.normalizeId('waterBodySubAreas', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'bodyLandmark': {
      const id = ctx.db.normalizeId('bodyLandmarks', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'putIn': {
      const id = ctx.db.normalizeId('putIns', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'bodyFeature': {
      const id = ctx.db.normalizeId('bodyFeatures', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'waterBodyRequest': {
      const id = ctx.db.normalizeId('waterBodyRequests', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'corpusPlaceName': {
      const id = ctx.db.normalizeId('corpusPlaceNames', targetId);
      return one(id ? (await ctx.db.get(id))?.waterBodyId : null);
    }
    case 'contentFlag': {
      // A flag on a body is one of its asks; a flag on anything else is not about a body.
      const id = ctx.db.normalizeId('contentFlags', targetId);
      const flag = id ? await ctx.db.get(id) : null;
      return one(
        flag?.targetType === 'waterbody' ? ctx.db.normalizeId('waterBodies', flag.targetId) : null,
      );
    }
    case 'parkingArea': {
      const id = ctx.db.normalizeId('parkingAreas', targetId);
      if (!id) return { bodies: [], changes };
      const links = await ctx.db
        .query('parkingAreaBodies')
        .withIndex('by_parking_area', (q) => q.eq('parkingAreaId', id))
        .take(LOT_BODY_CAP);
      return { bodies: [...new Set(links.map((l) => l.waterBodyId))], changes };
    }
    default:
      return { bodies: [], changes: false };
  }
}

/**
 * The audit hook: refresh the bodies an action belongs to, stamping *Changed* when a moderator acted
 * on the body or its bays, landmarks or put-ins. Called by `writeAudit` after the row is written.
 */
export async function noteAuditedAction(
  ctx: MutationCtx,
  entry: {
    actorId?: Id<'profiles'>;
    targetType: ModerationTargetType;
    targetId: string;
    createdAt: number;
  },
): Promise<void> {
  const { bodies, changes } = await bodiesOfTarget(ctx, entry.targetType, entry.targetId);
  const stamp = changes && entry.actorId !== undefined;
  for (const id of bodies) {
    await refreshBodyLibrary(ctx, id, stamp ? { changedAt: entry.createdAt } : {});
  }
}

/**
 * Stamp *Changed* on a body's rows when `at` is later than what they hold — the audit-log backfill's
 * write. *Changed* is no facet, so no count moves.
 */
export async function stampChanged(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  at: number,
): Promise<void> {
  const rows = await ctx.db
    .query('bodyLibraryRows')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(MAX_SCOPES);
  const keys = unknownLastKeys(at);
  for (const row of rows) {
    if (row.changedAt !== undefined && row.changedAt >= at) continue;
    await ctx.db.patch(row._id, { changedAt: at, changedAsc: keys.asc, changedDesc: keys.desc });
  }
}

// ── The queue: the machine's bulk writes ─────────────────────────────────────────────────────

/** Queue bodies for a refresh by the minute cron: one row each, whatever the number of writes. */
export async function queueLibraryRefresh(
  ctx: MutationCtx,
  ids: Iterable<Id<'waterBodies'>>,
  now: number = Date.now(),
): Promise<void> {
  for (const waterBodyId of new Set(ids)) {
    const queued = await ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first();
    if (queued === null) await ctx.db.insert('bodyLibraryQueue', { waterBodyId, queuedAt: now });
  }
}

/** Refresh up to `limit` queued bodies, oldest first; returns how many it took and whether more wait. */
export async function drainLibraryQueue(
  ctx: MutationCtx,
  limit: number,
): Promise<{ refreshed: number; more: boolean }> {
  const due = await ctx.db
    .query('bodyLibraryQueue')
    .withIndex('by_queued_at')
    .take(limit + 1);
  const batch = due.slice(0, limit);
  for (const row of batch) {
    await refreshBodyLibrary(ctx, row.waterBodyId);
    await ctx.db.delete(row._id);
  }
  return { refreshed: batch.length, more: due.length > limit };
}

/** The rows a lane, scope and key count, read as the library's lanes and facets use them. */
export async function readCount(
  ctx: QueryCtx,
  lane: string,
  scope: string,
  key: string,
): Promise<number> {
  const row = await ctx.db
    .query('bodyLibraryCounts')
    .withIndex('by_lane_scope_key', (q) => q.eq('lane', lane).eq('scope', scope).eq('key', key))
    .first();
  return row?.count ?? 0;
}

export type { Row as LibraryRow };
