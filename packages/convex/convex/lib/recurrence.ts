/**
 * Computing one body's cross-season recurrence (N5c / §C4) — the part that is about *this lake*, split
 * out from the staged job that decides *which lake*.
 *
 * **This pass is never capped, and that is the whole design.** Its job is completeness: a cap here is
 * the `listPromotionCandidates` finding one level up, where a 500-row bound was fine for one season and
 * wrong as a multi-season basis. It reads a body's hazards across the window in full, and if a lake
 * ever holds enough of them to strain a transaction, that is a thing to *see in the logs* rather than
 * to silently truncate — a recurrence record computed over a corpus missing rows is a count that looks
 * complete and isn't.
 */

import {
  clusterHazards,
  dayOfSeason,
  type HazardShape,
  hazardBbox,
  isMeasuredDepthSource,
  isShallowDepth,
  medoidOf,
  percentileDay,
  RECURRENCE_FAMILIES,
  RECURRENCE_MATCH_METERS,
  RECURRENCE_MAX_CLUSTER_SPREAD_M,
  RECURRENCE_WINDOW_SEASONS,
  type RecurrenceFamily,
  recurrencePriority,
  type Season,
  seasonOf,
  seasonStartMs,
  suggestedFeatureTypeFor,
  tierForTypes,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * A lake whose hazard count is worth a line in the logs.
 *
 * **Not a cap.** Everything over it is still processed in full; the number exists so that a body large
 * enough to matter announces itself before it becomes a transaction failure nobody can explain.
 */
const NOISY_BODY_HAZARD_COUNT = 400;

/** What one computed cluster carries into the stored row. */
export interface ComputedCluster {
  family: RecurrenceFamily;
  memberHazardIds: Id<'hazards'>[];
  representativeHazardId: Id<'hazards'>;
  seasonsObserved: Season[];
  windowSeasons: number;
  geometryKind: Doc<'hazards'>['geometryKind'];
  geometry: Doc<'hazards'>['geometry'];
  radiusMeters?: number;
  bufferMeters?: number;
  bbox: Doc<'hazards'>['bbox'];
  firstReportedDayOfSeasonP25: number;
  firstReportedDayOfSeasonP75: number;
  distinctAuthorCount: number;
  suggestedFeatureType?: Doc<'bodyFeatures'>['type'];
  priority: number;
  subAreaId?: Id<'waterBodySubAreas'>;
  subAreaName?: string;
}

/** The window's first season — inclusive, and the bound the corpus walk shares. */
export function windowStartSeason(currentSeason: Season): Season {
  return currentSeason - RECURRENCE_WINDOW_SEASONS + 1;
}

/** Epoch ms of the window's start, for the `by_first_reported` range. */
export function windowStartMs(currentSeason: Season): number {
  return seasonStartMs(windowStartSeason(currentSeason));
}

/**
 * Compute every cluster for one body across the window.
 *
 * **What is excluded, and why each one is a judgement rather than a filter** (§C2):
 *
 * - **Moderator-hidden pins.** A moderator judged the pin bad; it is not evidence.
 * - **Merge tombstones**, which are represented by the pin they were folded into (D80) — counting both
 *   would let one merge inflate a season's corroboration.
 * - **Hazards the community said never existed.** A claim the report was bogus is the opposite of
 *   corroboration. This has to read `hazardConfirmations` rather than `goneCount`, because that column
 *   pools `never_existed` with `fully_healed` (D65) and the two mean opposite things here.
 *
 * **Deliberately included:** archived rows. A ridge the community voted healed in March is exactly the
 * kind that comes back in December — "it healed" is a fact about last winter, not about this one. And
 * **promoted** rows, since the D53 amendment: the record is the evidence the promotion rests on and the
 * thing a demotion returns to, so it stays complete and goes on growing after a promotion.
 */
export async function computeClustersForBody(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  currentSeason: Season,
): Promise<ComputedCluster[]> {
  const from = windowStartMs(currentSeason);
  const rows = await ctx.db
    .query('hazards')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
    .collect();
  if (rows.length >= NOISY_BODY_HAZARD_COUNT) {
    console.warn(
      `recurrence: ${body._id} holds ${rows.length} hazards — processed in full, but worth watching`,
    );
  }

  const eligible: Doc<'hazards'>[] = [];
  for (const hazard of rows) {
    if (hazard.moderationStatus !== 'visible') continue;
    if (hazard.mergedIntoHazardId !== undefined) continue;
    if (hazard.firstReportedAt < from) continue;
    if (await wasSaidNeverToExist(ctx, hazard)) continue;
    eligible.push(hazard);
  }
  if (eligible.length === 0) return [];

  const clusters = clusterHazards(
    eligible.map((h) => ({
      id: h._id,
      type: h.type,
      geometryKind: h.geometryKind,
      geometry: h.geometry as HazardShape['geometry'],
      ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
      ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
      ...(h.clippedFootprint !== undefined
        ? { clippedFootprint: h.clippedFootprint as HazardShape['geometry'] }
        : {}),
      bbox: h.bbox,
      firstReportedAt: h.firstReportedAt,
    })),
    {
      matchMeters: RECURRENCE_MATCH_METERS,
      maxSpreadMeters: RECURRENCE_MAX_CLUSTER_SPREAD_M,
      families: RECURRENCE_FAMILIES,
    },
  );

  const byId = new Map(eligible.map((h) => [h._id as string, h]));
  const computed: ComputedCluster[] = [];
  for (const cluster of clusters) {
    const members = cluster.members
      .map((m) => byId.get(m.id))
      .filter((h): h is Doc<'hazards'> => h !== undefined);
    if (members.length === 0) continue;
    computed.push(
      await describeCluster(ctx, body, cluster.family as RecurrenceFamily, members, currentSeason),
    );
  }
  // Highest priority first, so the stored order is the order an operator reads and a `take` off the
  // per-body index is already the answer rather than a page that needs re-sorting.
  return computed.sort((a, b) => b.priority - a.priority);
}

/**
 * Did the community say this pin was never real?
 *
 * Two distinct non-author users whose **current** verdict is `never_existed` — the same distinct-user,
 * latest-vote rule `deriveHazardLifecycle` archives under, applied to the one verdict that is a claim
 * about the *report* rather than about the ice.
 */
async function wasSaidNeverToExist(ctx: MutationCtx, hazard: Doc<'hazards'>): Promise<boolean> {
  const votes = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard', (q) => q.eq('hazardId', hazard._id))
    .collect();
  const latest = new Map<string, (typeof votes)[number]>();
  for (const vote of votes) {
    const prior = latest.get(vote.userId);
    if (!prior || vote.createdAt >= prior.createdAt) latest.set(vote.userId, vote);
  }
  let bogus = 0;
  for (const vote of latest.values()) {
    if (vote.userId === hazard.createdByUserId) continue;
    if (vote.verdict === 'never_existed') bogus += 1;
  }
  return bogus >= 2;
}

/** The bbox centre of a hazard's stored footprint — what the medoid is measured on. */
function centreOf(hazard: Doc<'hazards'>) {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}

async function describeCluster(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  family: RecurrenceFamily,
  members: readonly Doc<'hazards'>[],
  currentSeason: Season,
): Promise<ComputedCluster> {
  // **A season contributes at most one.** Three skaters pinning the same ridge in one January is one
  // winter of evidence; a set rather than a count is what makes that true by construction.
  const seasons = [...new Set(members.map((m) => seasonOf(m.firstReportedAt)))].sort(
    (a, b) => a - b,
  );
  const newest = seasons[seasons.length - 1] as Season;

  const days = members.map((m) => dayOfSeason(m.firstReportedAt));
  const authors = new Set(members.map((m) => m.createdByUserId as string));

  // Corroboration per season, not across members: one enthusiastic winter must not outweigh a quiet
  // recurring one. Healed seasons are counted the same way, since "it healed" is a fact about a winter.
  let confirmations = 0;
  const healedSeasons = new Set<Season>();
  let neverExistedCount = 0;
  for (const member of members) {
    confirmations += member.confirmCount;
    if (member.status === 'archived') healedSeasons.add(seasonOf(member.firstReportedAt));
    const votes = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_hazard', (q) => q.eq('hazardId', member._id))
      .collect();
    const latest = new Map<string, (typeof votes)[number]>();
    for (const vote of votes) {
      const prior = latest.get(vote.userId);
      if (!prior || vote.createdAt >= prior.createdAt) latest.set(vote.userId, vote);
    }
    for (const vote of latest.values()) {
      if (vote.userId !== member.createdByUserId && vote.verdict === 'never_existed') {
        neverExistedCount += 1;
      }
    }
  }

  const medoid =
    medoidOf(
      members.map((m) => ({
        id: m._id as string,
        centre: centreOf(m),
        firstReportedAt: m.firstReportedAt,
      })),
    ) ?? null;
  const representative =
    (medoid && members.find((m) => m._id === medoid.id)) ?? (members[0] as Doc<'hazards'>);

  const shape: HazardShape = {
    geometryKind: representative.geometryKind,
    geometry: representative.geometry as HazardShape['geometry'],
    ...(representative.radiusMeters !== undefined
      ? { radiusMeters: representative.radiusMeters }
      : {}),
    ...(representative.bufferMeters !== undefined
      ? { bufferMeters: representative.bufferMeters }
      : {}),
  };

  const priority = recurrencePriority({
    seasonsObserved: seasons.length,
    windowSeasons: RECURRENCE_WINDOW_SEASONS,
    tier: tierForTypes(members.map((m) => m.type)),
    seasonsSinceLastObserved: Math.max(0, currentSeason - newest),
    confirmationsPerSeason: confirmations / seasons.length,
    healedSeasons: healedSeasons.size,
    neverExistedCount,
  });

  return {
    family,
    // Sorted so two runs over the same data produce byte-identical arrays — the idempotence the job
    // asserts is only meaningful if the field order is deterministic too.
    memberHazardIds: [...members.map((m) => m._id)].sort(),
    representativeHazardId: representative._id,
    seasonsObserved: seasons,
    windowSeasons: RECURRENCE_WINDOW_SEASONS,
    geometryKind: representative.geometryKind,
    geometry: representative.geometry,
    ...(representative.radiusMeters !== undefined
      ? { radiusMeters: representative.radiusMeters }
      : {}),
    ...(representative.bufferMeters !== undefined
      ? { bufferMeters: representative.bufferMeters }
      : {}),
    bbox: hazardBbox(shape),
    firstReportedDayOfSeasonP25: percentileDay(days, 0.25),
    firstReportedDayOfSeasonP75: percentileDay(days, 0.75),
    distinctAuthorCount: authors.size,
    ...(suggestionFor(family, body) !== null
      ? { suggestedFeatureType: suggestionFor(family, body) as Doc<'bodyFeatures'>['type'] }
      : {}),
    priority,
    // The place phrase comes from the representative, so "which bay is this pattern in" is answered by
    // the same pin whose shape a promotion would inherit (N2/D60).
    ...(representative.subAreaId !== undefined ? { subAreaId: representative.subAreaId } : {}),
    ...(representative.subAreaName !== undefined
      ? { subAreaName: representative.subAreaName }
      : {}),
  };
}

/**
 * What this family proposes on this body — with §C7's depth cross-check for the volatile one.
 *
 * **Depth is how the proposal gets checked** (D68/D69). A recurring thin-ice cluster proposing
 * `shallow_early_thaw` is a claim about the lake *bed*: shallow water over a sandbar or a reef goes out
 * from the bottom first. If the body's depth says it is deep, that claim is at odds with the only
 * physical measurement we hold — so the suggestion is withheld when the depth **positively
 * contradicts** it *and* was **measured** rather than modelled. D68's provenance ladder exists exactly
 * so a claim can be weighted by what it was read off, and a modelled mean is not evidence enough to
 * overrule several winters of people standing there.
 *
 * The cluster is still recorded either way. What is withheld is the *suggestion*, not the history.
 */
function suggestionFor(
  family: RecurrenceFamily,
  body: Doc<'waterBodies'>,
): Doc<'bodyFeatures'>['type'] | null {
  const suggested = suggestedFeatureTypeFor(family);
  if (suggested === null) return null;
  if (family !== 'volatile') return suggested;

  if (isShallowDepth(body)) return suggested; // the depth agrees — nothing to withhold
  const source = body.meanDepthM !== undefined ? body.meanDepthSource : body.maxDepthSource;
  const measured = source !== undefined && isMeasuredDepthSource(source);
  const hasDepth = body.meanDepthM !== undefined || body.maxDepthM !== undefined;
  // Deep *and* measured is the one combination that withholds. Unknown depth doesn't contradict
  // anything, and a modelled depth is a guess this evidence outweighs.
  return hasDepth && measured ? null : suggested;
}
