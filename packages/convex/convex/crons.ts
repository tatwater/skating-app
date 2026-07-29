/**
 * Scheduled jobs (Convex crons). Phase 4 adds the notification-queue flush (decision #4): a single
 * frequent drain that delivers every queued row whose `flushAfter` has passed — favorites/great after
 * their short debounce, and the "all nearby" digest at its next-8pm-ET target. One unified drain keeps
 * delivery simple; the bucket picks the timing when the row is enqueued (see `notifications.ts`).
 */

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval(
  'flush notification queue',
  { minutes: 1 },
  internal.notifications.flushNotificationQueue,
  {},
);

// Expire bounties past their lifetime (Phase 6, decision 12): flip `open → expired`. Every 6h is ample
// for a ~30-day default lifetime — expiry is not time-critical, and the sweep reads a dedicated index.
crons.interval('expire bounties', { hours: 6 }, internal.bounties.expireBounties, {});

// Refresh weather-adjusted hazard decay (Phase 10 / D56 §6). Fixed hourly base tick; each hazard is
// actually re-fetched at most every WEATHER_REFRESH_MIN_INTERVAL_HOURS (the effective cadence gate, so
// the interval is tunable without a redeploy). Sweeps only bodies with an active hazard, not the corpus.
crons.interval(
  'refresh hazard weather',
  { hours: 1 },
  internal.hazardWeather.refreshHazardWeather,
  {},
);

// Operator analytics (Phase 7b / D37). Three cadences, because the three jobs answer to different
// things — see `analyticsRollup.ts`. The 6-hourly rollup recomputes today *and* yesterday, and its
// writes replace rather than accumulate, so re-running is idempotent: the dashboard gets near-live
// numbers without a second read path that scans the corpus, and a missed tick self-heals.
crons.interval('roll up operator metrics', { hours: 6 }, internal.analyticsRollup.runRollup, {});

// The whole-corpus sweep (bodies per state, bodies per zoom band). Both are properties of the ETL
// import and operator curation, not of user activity, so a daily full sweep would be waste. It pages
// through the corpus with a cursor and schedules its own continuation.
crons.interval(
  'sweep water-body coverage',
  { hours: 24 * 7 },
  internal.analyticsRollup.sweepCorpus,
  {},
);

// `bountyGateEvents` retention. The one append-per-attempt analytics table, and the one carrying a
// user id — so the bound is a privacy decision as much as a storage one.
crons.interval(
  'prune bounty gate events',
  { hours: 24 },
  internal.analyticsRollup.pruneGateEvents,
  {},
);

// `clientSignalEvents` retention — the client-signal rate-limit bookkeeping is worthless past its window.
crons.interval(
  'prune client signal events',
  { hours: 24 },
  internal.analyticsRollup.pruneClientSignals,
  {},
);

// Expired OAuth connect nonces (Phase 8). They're single-use and 15-minute-lived, so an abandoned
// connect flow is the only way one survives — but a nonce that lingers is a credential that lingers,
// so it gets swept rather than left to sit.
crons.interval('prune oauth states', { hours: 6 }, internal.strava.pruneOAuthStates, {});

// ─────────────────────────────────────────────────────────────────────────────
// Account lifecycle + storage hygiene (N3 / D33 / D62)
// ─────────────────────────────────────────────────────────────────────────────

// Finalize accounts whose 30-day grace window has run out. Hourly, not by-the-minute: the window is a
// month, so an hour of slack is invisible to the user and keeps the sweep cheap. It reads a sparse
// index bounded by "actually due", then hands each account to its own self-continuing job.
crons.interval(
  'finalize account deletions',
  { hours: 1 },
  internal.accountDeletion.finalizeDueDeletions,
  {},
);

// `weatherCache` retention. Rows are addressable only during their own hour bucket (the cache key
// contains it), so yesterday's rows are unreachable rather than merely stale — this is reclaiming
// dead weight, and N2's per-sample-point weather grid multiplied how fast it accrues.
crons.interval('prune weather cache', { hours: 6 }, internal.storageHygiene.pruneWeatherCache, {});

// Photo-orphan GC — the durable backstop behind the client's best-effort reclaim. Daily, because an
// orphan costs only storage and the grace window before a photo is even a candidate is 30 days.
crons.interval('sweep orphan photos', { hours: 24 }, internal.storageHygiene.sweepOrphanPhotos, {});

/**
 * A departed skater's photos, expired with the season they were taken in (D66/N5a).
 *
 * Daily rather than annually, even though the clock it enforces turns over once a year: accounts are
 * tombstoned continuously, and a skater who leaves in August has photos from a season that ended in
 * June. Waiting for the next boundary would hold those for eleven months for no reason.
 */
crons.interval(
  'expire departed skaters photos',
  { hours: 24 },
  internal.storageHygiene.sweepDepartedPhotos,
  {},
);

// Expired data-export bundles. Hourly, unlike the other two, because an export is the densest
// concentration of one person's data in the system and its whole point is being short-lived.
crons.interval(
  'sweep expired exports',
  { hours: 1 },
  internal.storageHygiene.sweepExpiredExports,
  {},
);

export default crons;
