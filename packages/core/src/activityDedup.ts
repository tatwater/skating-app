/**
 * One skate, several sources: which recording is *the* recording (N8/B4a; D68's precedence
 * discipline, second application).
 *
 * Someone can connect two things that both saw the same session — most plausibly a watch **and** an
 * aggregator, e.g. Garmin plus Apple HealthKit re-exporting the Garmin recording. One skate, two
 * rows, and — once the `activity_detected` sweep exists — two "add a report?" prompts for the same
 * afternoon, which is where the user notices a data problem we could have caught.
 *
 * **This is unreachable today.** `native` is the only provider producing rows and Strava is push-only
 * (we send to them, they send us nothing). It is settled here anyway, before the second source lands,
 * because the first symptom of not having it would be a double notification. The two constants below
 * want one round of eyeballing against real dual-source data before they're trusted; they are pinned
 * by tests, not by evidence.
 *
 * ## The match rule
 *
 * Same user, time intervals that **overlap**, starts within {@link ACTIVITY_DEDUP_START_WINDOW_MS},
 * and a compatible resolved body (equal, or one unresolved). Two recordings of one skate rarely share
 * timestamps — a watch trims differently, a phone starts in the parking lot — so a start-time equality
 * test would miss most real duplicates.
 *
 * ## The precedence ladder
 *
 * Keep the best copy, and keep it *as* the best copy rather than merging geometries — a merge invents
 * a track nobody skated. The ladder sorts on two axes at once, **fidelity and displayability**, and
 * displayability is the one that can't be fixed by better hardware:
 *
 * 1. our native recorder — full fidelity, our own idempotency key, unambiguously ours to display;
 * 2. a direct watch connection — watch-grade GPS, ingested under that provider's own terms;
 * 3. an aggregator — usually carrying someone else's recording, often downsampled by the round trip;
 * 4. a Strava-sourced copy, last: D24 records that Strava's terms restrict showing one user's Strava
 *    data to other users, so a Strava copy may be one we can't draw on the public aggregate at all.
 *
 * The loser is never deleted — it is marked superseded (`supersededByActivityId`), the same posture as
 * water-body dedup: two devices genuinely saw this, the record is cheap, and a deletion is
 * unrecoverable if the ladder was wrong. A loser that already carries a `linkedReportId` hands the link
 * to the winner rather than breaking it — a report must never lose its path to a track.
 */

/** Starts more than this far apart are two skates, however much they overlap. Tunable; see above. */
export const ACTIVITY_DEDUP_START_WINDOW_MS = 10 * 60 * 1000;

/**
 * The input shape — the fields of a `gpsActivities` row the rule reads. Deliberately **not**
 * `linkedReportId`: which copy a report was filed from doesn't change which copy is the better
 * recording; the caller moves the link to the winner afterwards (see `sweepUnpromptedActivities`).
 */
export interface DedupActivity {
  id: string;
  userId: string;
  provider: string;
  startTime: number;
  endTime?: number;
  waterBodyId?: string;
}

/** Lower is better. Unknown providers rank with `other`, below everything named. */
export const ACTIVITY_PROVIDER_RANK: Readonly<Record<string, number>> = {
  native: 0,
  garmin: 1,
  coros: 1,
  polar: 1,
  apple_health: 2,
  google_health_connect: 2,
  strava: 3,
  other: 4,
};

export function activityProviderRank(provider: string): number {
  return ACTIVITY_PROVIDER_RANK[provider] ?? ACTIVITY_PROVIDER_RANK.other ?? 4;
}

/**
 * Whether two rows are plausibly the same skate. Symmetric. An activity with no `endTime` is treated
 * as an instant at its start, so it overlaps another only if that one spans its start — which is what
 * a watch that reported "started 14:02" and nothing else can honestly claim.
 */
export function activitiesMatch(
  a: DedupActivity,
  b: DedupActivity,
  startWindowMs = ACTIVITY_DEDUP_START_WINDOW_MS,
): boolean {
  if (a.id === b.id || a.userId !== b.userId) return false;
  if (Math.abs(a.startTime - b.startTime) > startWindowMs) return false;
  const aEnd = a.endTime ?? a.startTime;
  const bEnd = b.endTime ?? b.startTime;
  if (a.startTime > bEnd || b.startTime > aEnd) return false;
  if (
    a.waterBodyId !== undefined &&
    b.waterBodyId !== undefined &&
    a.waterBodyId !== b.waterBodyId
  ) {
    return false;
  }
  return true;
}

/**
 * Sort key for the ladder: better provider first, then the earlier start (the longer recording of
 * the same session, usually), then id for determinism.
 */
export function compareActivityPrecedence(a: DedupActivity, b: DedupActivity): number {
  const rank = activityProviderRank(a.provider) - activityProviderRank(b.provider);
  if (rank !== 0) return rank;
  if (a.startTime !== b.startTime) return a.startTime - b.startTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DedupResult {
  /** The best copy of each distinct skate, in precedence order. */
  winners: DedupActivity[];
  /** Each loser and the winner that supersedes it. */
  superseded: { loser: DedupActivity; winner: DedupActivity }[];
}

/**
 * Partition one user's activities into winners and superseded losers. Greedy in ladder order: each
 * activity either matches an already-chosen winner (and is superseded by it) or becomes a winner. A
 * loser is compared against winners only, never against other losers, so a chain A~B~C where A≁C
 * still resolves to one winner (A) — two devices that both saw B's skate saw the same skate.
 */
export function dedupActivities(
  activities: readonly DedupActivity[],
  startWindowMs = ACTIVITY_DEDUP_START_WINDOW_MS,
): DedupResult {
  const ordered = [...activities].sort(compareActivityPrecedence);
  const winners: DedupActivity[] = [];
  const superseded: DedupResult['superseded'] = [];
  for (const candidate of ordered) {
    const winner = winners.find((w) => activitiesMatch(w, candidate, startWindowMs));
    if (winner) superseded.push({ loser: candidate, winner });
    else winners.push(candidate);
  }
  return { winners, superseded };
}
