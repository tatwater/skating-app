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
// The forward-forecast cache (N6c/B5b), same cadence and the same argument: its rows become
// unaddressable the moment their hour bucket passes, so this is reclaiming space rather than
// invalidating anything.
crons.interval(
  'prune forecast cache',
  { hours: 6 },
  internal.storageHygiene.pruneForecastCache,
  {},
);

// Photo-orphan GC — the durable backstop behind the client's best-effort reclaim. Daily, because an
// orphan costs only storage and the grace window before a photo is even a candidate is 30 days.
crons.interval('sweep orphan photos', { hours: 24 }, internal.storageHygiene.sweepOrphanPhotos, {});

/**
 * Lapse access alerts whose TTL ran out, or whose season did (N6d / D73).
 *
 * Six-hourly rather than daily, because an alert is read at exactly the moment somebody is deciding
 * whether to drive somewhere: a road that reopened is a wasted trip in one direction and a stale
 * warning is a lake nobody visits in the other, and neither deserves to hang for most of a day.
 *
 * **The season boundary needs no cron of its own.** Every write clamps expiry to
 * `min(TTL, season end)`, so a rollover is simply a batch whose expiry has passed — one mechanism, one
 * sweep, and no annual job that runs correctly for the first time eleven months after it was written.
 *
 * Moderator-pinned `official` alerts are exempt (founder call) and the sweep cannot reach them: they
 * sit under a different `status` prefix of `by_status_expires_at`, so this is a structural exemption
 * rather than a filter somebody has to remember.
 */
crons.interval('expire access alerts', { hours: 6 }, internal.accessAlerts.expireLapsedAlerts, {});

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

/**
 * The season-rollover recurrence pass (N5c / §C4) — the once-a-year job, checked daily.
 *
 * A daily tick with a month gate rather than a `crons.cron` expression, for two reasons. It keeps this
 * file uniform (every other job here is an interval), and more usefully it makes the rollover
 * **retryable**: a run that fails on July 2 is picked up on July 3, where a once-a-year expression
 * would wait a year. `maybeRunRollover` is a no-op outside the first week of July and a no-op again
 * once the season has been computed, so 358 of the 365 ticks cost one indexed read.
 */
crons.interval(
  'recompute hazard recurrence at the rollover',
  { hours: 24 },
  internal.recurrence.maybeRunRollover,
  {},
);

/**
 * NWS active alerts (N6c B5). Fifteen minutes because a winter storm warning is issued on that kind
 * of timescale and a skater deciding at 7am should not be reading 6am's picture — and because five
 * requests a quarter-hour is nothing to an unauthenticated public API that asks only for a
 * `User-Agent`. The sweep that retires a silent state's rows rides the same tick.
 */
crons.interval('refresh nws alerts', { minutes: 15 }, internal.weatherAlerts.refreshAlerts, {});

/**
 * Map summary cards (N6c/E). Six-hourly because the only thing this catches is *time* — a report
 * ageing out of the 14-day window, or a season boundary — and neither is urgent to the hour. Every
 * event-driven change to a card already happens synchronously on the write that caused it.
 */
crons.interval(
  'sweep body summaries',
  { hours: 6 },
  internal.waterBodies.sweepAllBodySummaries,
  {},
);

export default crons;
