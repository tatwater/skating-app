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

export default crons;
