/**
 * Computing one body's cross-season recurrence (N5c / §C4) — the part that is about *this lake*, split
 * out from the staged job that decides *which lake*.
 *
 * **This pass reads a body's window in full, and says so when it can't.** Its job is completeness, and
 * a silent cap here would be the `listPromotionCandidates` finding one level up — a recurrence record
 * computed over a corpus missing rows is a count that looks complete and isn't.
 *
 * ⚠ **It is bounded all the same, and the plan's "never capped" was wrong about which risk was
 * bigger** (Greptile, PR #35 — see {@link MAX_BODY_HAZARDS}). The window bound rides
 * `by_water_body_first_reported` rather than a filter after a full read, so the transaction is sized by
 * four winters of one lake instead of by everything that lake has ever accumulated; above the ceiling
 * the truncation is recorded on every row and warned about, rather than swallowed. An unbounded read
 * defending completeness does not degrade when it finally fails — it stops the annual pass for the
 * entire corpus at that lake.
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
 * Everything up to {@link MAX_BODY_HAZARDS} is still processed in full; this number exists so that a
 * body large enough to matter announces itself well before it reaches the ceiling.
 */
const NOISY_BODY_HAZARD_COUNT = 400;

/**
 * The most hazards one body's recompute will read — the ceiling that keeps this a mutation that can
 * always commit.
 *
 * **The plan said "never capped, and that is the whole design", and that was right about the wrong
 * risk.** Its argument is against a cap that *silently truncates*, because a recurrence record computed
 * over a corpus missing rows is a count that looks complete and isn't. That argument still holds and is
 * why the truncation is recorded on every row it affects rather than swallowed.
 *
 * What the plan did not weigh is that the read set here is a function of **accumulated user-created
 * rows** on one lake, with no upper bound in time — `hazards` never ages out. A mutation like that does
 * not fail gracefully when it finally exceeds a backend limit: it rolls back, so the queue row is never
 * deleted and nothing downstream is scheduled, and the *annual* pass stops at that lake and stays
 * stopped. An unbounded read defending completeness costs the whole corpus its recompute the first time
 * one popular lake gets busy enough. Bounded, the worst case is one lake's oldest sightings missing from
 * one denominator, said out loud (Greptile, PR #35).
 *
 * Read **newest first**, so what a ceiling drops is the oldest end of the window — the seasons furthest
 * from the one being computed for, which are also the ones contributing least to a recurrence claim.
 */
const MAX_BODY_HAZARDS = 4_000;

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
  /** The body hit {@link MAX_BODY_HAZARDS}, so this cluster's history starts later than the window. */
  computedFromPartialHistory?: boolean;
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
  // The window bound rides the **index**, not a filter after it. `by_water_body` is creation-ordered,
  // so bounding four winters there meant reading every hazard the lake has ever held and dropping the
  // old ones in memory — a read that grows for the life of the app. Descending, so the ceiling below
  // drops the oldest sightings rather than the most recent ones.
  const rows = await ctx.db
    .query('hazards')
    .withIndex('by_water_body_first_reported', (q) =>
      q.eq('waterBodyId', body._id).gte('firstReportedAt', from),
    )
    .order('desc')
    .take(MAX_BODY_HAZARDS);
  if (rows.length >= NOISY_BODY_HAZARD_COUNT) {
    console.warn(
      `recurrence: ${body._id} holds ${rows.length} hazards in the window — worth watching`,
    );
  }
  const truncated = rows.length === MAX_BODY_HAZARDS;
  if (truncated) {
    // Loud, because §11's "no silent caps" rule is the reason a ceiling is tolerable here at all: a
    // denominator computed over a partial history has to say so, and it does — on every row, through
    // `computedFromPartialHistory`, all the way out to the operator card.
    console.warn(
      `recurrence: ${body._id} hit the ${MAX_BODY_HAZARDS}-hazard ceiling — clusters computed from the most recent sightings only`,
    );
  }

  // **One confirmation read per hazard, not two.** `never_existed` decides both whether a sighting is
  // evidence at all and how hard the cluster is ranked down, and reading the votes twice for those two
  // questions doubled the largest read in the pass — on the table users add to most freely.
  const eligible: Doc<'hazards'>[] = [];
  const neverExistedByHazard = new Map<string, number>();
  for (const hazard of rows) {
    if (hazard.moderationStatus !== 'visible') continue;
    if (hazard.mergedIntoHazardId !== undefined) continue;
    const bogus = await countNeverExisted(ctx, hazard);
    // Two distinct non-author users saying it was never real — the same distinct-user, latest-vote
    // rule `deriveHazardLifecycle` archives under. A claim the report was bogus is the opposite of
    // corroboration, so the sighting is not evidence.
    if (bogus >= 2) continue;
    neverExistedByHazard.set(hazard._id, bogus);
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
      describeCluster(
        body,
        cluster.family as RecurrenceFamily,
        members,
        currentSeason,
        neverExistedByHazard,
        truncated,
      ),
    );
  }
  // Highest priority first, so the stored order is the order an operator reads and a `take` off the
  // per-body index is already the answer rather than a page that needs re-sorting.
  return computed.sort((a, b) => b.priority - a.priority);
}

/**
 * How many distinct non-author users currently say this pin was never real.
 *
 * The same distinct-user, latest-vote rule `deriveHazardLifecycle` archives under, applied to the one
 * verdict that is a claim about the *report* rather than about the ice. Two of them and the sighting
 * stops being evidence; below that the count still ranks the cluster down, which is why this returns a
 * number rather than a boolean — one read answering both questions.
 */
async function countNeverExisted(ctx: MutationCtx, hazard: Doc<'hazards'>): Promise<number> {
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
  return bogus;
}

/** The bbox centre of a hazard's stored footprint — what the medoid is measured on. */
function centreOf(hazard: Doc<'hazards'>) {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}

/**
 * Everything one cluster stores, from members already in hand.
 *
 * **Pure — no reads.** It used to re-query every member's confirmations for the `never_existed` count
 * the eligibility pass had already read, which made the pass's largest read set twice the size it
 * needed to be on the one table users add to most freely. The counts come in through
 * `neverExistedByHazard` now, so the whole recompute reads each hazard's votes exactly once.
 */
function describeCluster(
  body: Doc<'waterBodies'>,
  family: RecurrenceFamily,
  members: readonly Doc<'hazards'>[],
  currentSeason: Season,
  neverExistedByHazard: ReadonlyMap<string, number>,
  computedFromPartialHistory: boolean,
): ComputedCluster {
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
    neverExistedCount += neverExistedByHazard.get(member._id) ?? 0;
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
    // Carried out to the operator card. §11's rule is no silent caps: a denominator computed over a
    // partial history reads exactly like one computed over all of it, and the difference is the only
    // thing that would make the number wrong.
    ...(computedFromPartialHistory ? { computedFromPartialHistory: true } : {}),
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
