/**
 * **The cron registry** (D343, D347, B01-8b): every scheduled job, one entry each, in the order
 * `crons.ts` registered them before the backbone. `crons.ts` is now a loop over these entries that
 * registers each against one of the two dispatchers in `cronRuns.ts` (`tickMutation` for a mutation
 * job, `tickAction` for an action job) with `{ job: <name> }`; the dispatcher looks the entry up here,
 * runs its function with its arguments, and records the tick.
 *
 * An entry's `name` is the cron's registered name, unchanged from before the move, so Convex keeps
 * its history and its no-overlap rule per name. Its `schedule` is the one it was registered with,
 * byte for byte, except *watch for the imagery season to open*, which moved from every 24 hours to a
 * fixed 11:30 UTC (D346: a fixed-time cron's next run can be shown). The comment above each entry is
 * the one that sat above its registration, moved whole.
 *
 * A cron added with a bare `crons.interval` (rather than an entry here) fails `cronJobs.test.ts`.
 *
 * Every entry is a data literal: no entry reads the database, the clock or the environment, so the
 * registry is the same at push time and at run time.
 */

import type { CronSchedule } from '@skating/core';
import type { FunctionReference } from 'convex/server';
import type { Value } from 'convex/values';
import { internal } from './_generated/api';

const DAY_MS = 86_400_000;

/**
 * A cron's schedule as `cronJobs()` takes it: an interval (`crons.interval`'s object), a fixed UTC
 * time each day (`crons.daily`) or each week (`crons.weekly`).
 */
export type CronJobSchedule =
  | { every: { seconds: number } | { minutes: number } | { hours: number } }
  | { daily: { hourUTC: number; minuteUTC: number } }
  | { weekly: { dayOfWeek: CronDayOfWeek; hourUTC: number; minuteUTC: number } };

/** `crons.weekly`'s day names, Sunday first (so the index is `Date.getUTCDay`'s). */
export const CRON_DAYS_OF_WEEK = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type CronDayOfWeek = (typeof CRON_DAYS_OF_WEEK)[number];

/**
 * What a cron is part of, for Health (B01-8e) and the pipeline pages (8c) to group by. A label, not a
 * permission: nothing gates on it.
 */
export const CRON_PIPELINES = [
  'notifications',
  'bounties',
  'hazards',
  'analytics',
  'hygiene',
  'accounts',
  'erasure',
  'weather',
  'photos',
  'access',
  'rollovers',
  'imagery',
  'bodies',
  'inbox',
  'corpus',
  'people',
  'consent',
  'geometry',
] as const;
export type CronPipeline = (typeof CRON_PIPELINES)[number];

/**
 * How long a cron's records are kept, in days, stamped as `keepUntil` by the recorder and swept by
 * `cronRunJobs.prune`: its tick rows, its run rows, and its runs' log lines.
 */
export interface CronRetention {
  tickDays: number;
  runDays: number;
  lineDays: number;
}

/** Every cron's: ticks 35 days (Health's seven days of failures, with margin), runs and lines 30. */
export const CRON_RETENTION: CronRetention = { tickDays: 35, runDays: 30, lineDays: 30 };
/**
 * The imagery jobs': runs kept 200 days, so the poll's *Since the start* strip and the runs list
 * cover a whole season; their lines stay 30.
 */
export const SEASON_CRON_RETENTION: CronRetention = { tickDays: 35, runDays: 200, lineDays: 30 };

/**
 * **How much of a cron's ticks the recorder writes** (B01-8b's fork 1, with the founder).
 *
 * - `every` — every tick is recorded as it happens: the heartbeat patched and the tick appended to
 *   its bucket row, each tick; a tick that worked or failed also gets its run row (and its lines).
 * - `sparse` — a tick that failed or was killed, or that reported work, is recorded as it happens,
 *   exactly as under `every`. A quiet `ok` tick is recorded only when it is the job's first in its
 *   UTC hour: at most one heartbeat write and one tick write per UTC hour for the quiet ticks, the
 *   rest not written at all. The heartbeat's `lastTickAt` then lags a quiet job by up to an hour,
 *   and the tick strip shows one quiet tick an hour; failures and work are never lost.
 *
 * The recorder (`cronRuns.ts`) implements both; the mode is read from the entry. The founder ruled
 * fork 1 (2026-11-27, option c): the app stays well inside Convex's free plan, so the most frequent
 * crons record sparsely ({@link FREQUENT_CRON_RECORD}) and every other cron records every tick.
 */
export type CronRecordMode = 'every' | 'sparse';

/**
 * The five crons that tick every one to three minutes (the notification flush, the bodies library
 * drain, and the bodies library, inbox and corpus tasks drift repairs: most of the day's ticks). The
 * founder's ruling on fork 1 (2026-11-27) records them sparsely: their failures and work as they
 * happen, their quiet ticks once an hour. The imagery pump (every 3 minutes) is not in it: its quiet
 * ticks are its runs drawer's folded *quiet checks* line.
 */
export const FREQUENT_CRON_RECORD: CronRecordMode = 'sparse';

interface CronJobBase {
  /** The cron's registered name: the dispatcher's `{ job }`, the heartbeat's key. */
  name: string;
  schedule: CronJobSchedule;
  /** The job's arguments, as it was registered with them. */
  args: Record<string, Value>;
  pipeline: CronPipeline;
  retention: CronRetention;
  record: CronRecordMode;
}

/** A mutation job: run by `cronRuns.tickMutation` as a nested transaction. */
export interface CronMutationJob extends CronJobBase {
  kind: 'mutation';
  fn: FunctionReference<'mutation', 'internal'>;
}

/**
 * An action job: run by `cronRuns.tickAction`. `announces`: a long job whose start is stamped on its
 * heartbeat (`runningSince`) by `begin`, so a tick killed by Convex's action limit or a deploy reads
 * as killed on the next one.
 */
export interface CronActionJob extends CronJobBase {
  kind: 'action';
  fn: FunctionReference<'action', 'internal'>;
  announces: boolean;
}

export type CronJobEntry = CronMutationJob | CronActionJob;

/** The registry's entry for a cron name, or `null` (own entries only). */
export function cronJob(name: string): CronJobEntry | null {
  return CRON_JOBS_BY_NAME.get(name) ?? null;
}

/** An entry's schedule as core's liveness rule reads it: an interval in ms, or a fixed UTC time. */
export function cronScheduleOf(schedule: CronJobSchedule): CronSchedule {
  if ('every' in schedule) {
    const e = schedule.every;
    const ms =
      'hours' in e ? e.hours * 3_600_000 : 'minutes' in e ? e.minutes * 60_000 : e.seconds * 1_000;
    return { every: ms };
  }
  if ('daily' in schedule) return { daily: { ...schedule.daily } };
  const { dayOfWeek, hourUTC, minuteUTC } = schedule.weekly;
  return { weekly: { dayOfWeek: CRON_DAYS_OF_WEEK.indexOf(dayOfWeek), hourUTC, minuteUTC } };
}

/** How often an entry ticks, in ms: its interval, a day, or a week. */
export function cronPeriodMs(schedule: CronJobSchedule): number {
  const s = cronScheduleOf(schedule);
  return 'every' in s ? s.every : 'daily' in s ? DAY_MS : 7 * DAY_MS;
}

export const CRON_JOBS: readonly CronJobEntry[] = [
  /**
   * The notification-queue flush (Phase 04, decision #4): a single frequent drain that delivers every
   * queued row whose `flushAfter` has passed — favorites/great after their short debounce, and the "all
   * nearby" digest at its next-8pm-ET target. One unified drain keeps delivery simple; the bucket picks
   * the timing when the row is enqueued (see `notifications.ts`).
   */
  {
    name: 'flush notification queue',
    schedule: { every: { minutes: 1 } },
    kind: 'mutation',
    fn: internal.notifications.flushNotificationQueue,
    args: {},
    pipeline: 'notifications',
    retention: CRON_RETENTION,
    record: FREQUENT_CRON_RECORD,
  },

  // Expire bounties past their lifetime (Phase 06, decision 12): flip `open → expired`. Every 6h is ample
  // for a ~30-day default lifetime — expiry is not time-critical, and the sweep reads a dedicated index.
  {
    name: 'expire bounties',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.bounties.expireBounties,
    args: {},
    pipeline: 'bounties',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Refresh weather-adjusted hazard decay (Phase 10 / D56 §6). Fixed hourly base tick; each hazard is
  // actually re-fetched at most every WEATHER_REFRESH_MIN_INTERVAL_HOURS (the effective cadence gate, so
  // the interval is tunable without a redeploy). Sweeps only bodies with an active hazard, not the corpus.
  {
    name: 'refresh hazard weather',
    schedule: { every: { hours: 1 } },
    kind: 'action',
    fn: internal.hazardWeather.refreshHazardWeather,
    args: {},
    pipeline: 'hazards',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },

  // Operator analytics (Phase 07-2 / D37). Three cadences, because the three jobs answer to different
  // things — see `analyticsRollup.ts`. The 6-hourly rollup recomputes today *and* yesterday, and its
  // writes replace rather than accumulate, so re-running is idempotent: the dashboard gets near-live
  // numbers without a second read path that scans the corpus, and a missed tick self-heals.
  {
    name: 'roll up operator metrics',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.analyticsRollup.runRollup,
    args: {},
    pipeline: 'analytics',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // The whole-corpus sweep (bodies per state, bodies per zoom band). Both are properties of the ETL
  // import and operator curation, not of user activity, so a daily full sweep would be waste. It pages
  // through the corpus with a cursor and schedules its own continuation.
  {
    name: 'sweep water-body coverage',
    schedule: { every: { hours: 24 * 7 } },
    kind: 'mutation',
    fn: internal.analyticsRollup.sweepCorpus,
    args: {},
    pipeline: 'analytics',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // `bountyGateEvents` retention. The one append-per-attempt analytics table, and the one carrying a
  // user id — so the bound is a privacy decision as much as a storage one.
  {
    name: 'prune bounty gate events',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.analyticsRollup.pruneGateEvents,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // `clientSignalEvents` retention — the client-signal rate-limit bookkeeping is worthless past its window.
  {
    name: 'prune client signal events',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.analyticsRollup.pruneClientSignals,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Expired OAuth connect nonces (Phase 08). They're single-use and 15-minute-lived, so an abandoned
  // connect flow is the only way one survives — but a nonce that lingers is a credential that lingers,
  // so it gets swept rather than left to sit.
  {
    name: 'prune oauth states',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.strava.pruneOAuthStates,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },
  // A web *From Google Photos* session holds a one-hour token (A10-8, D207). The page deletes its row
  // when it is done; this catches the tab that was closed mid-pick, soon after the hour runs out.
  {
    name: 'prune photo picker sessions',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.googlePhotos.pruneSessions,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Account lifecycle + storage hygiene (A03 / D33 / D62)
  // ─────────────────────────────────────────────────────────────────────────────

  // Finalize accounts whose 30-day grace window has run out. Hourly, not by-the-minute: the window is a
  // month, so an hour of slack is invisible to the user and keeps the sweep cheap. It reads a sparse
  // index bounded by "actually due", then hands each account to its own self-continuing job.
  {
    name: 'finalize account deletions',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.accountDeletion.finalizeDueDeletions,
    args: {},
    pipeline: 'accounts',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Erase what people withdrew, 30 days on unless held (D248). Hourly like the account sweep: the
  // window is a month, and the range it reads holds only rows already due (`erasure.eraseDue`).
  {
    name: 'erase withdrawn content',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.erasure.eraseDue,
    args: {},
    pipeline: 'erasure',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Settle the photos erasures let go of (D248). Each sweep run's end starts this too; its own hourly
  // tick means a debt is picked up even in an hour whose sweep failed, since the debts are rows.
  {
    name: 'settle photos erasure let go of',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.erasure.settleOwed,
    args: {},
    pipeline: 'erasure',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Parked erasure work heals itself (D248): once a day, a few parked settlements and items of each kind
  // are tried again, least recently tried first, so a deployed fix frees them without anyone remembering.
  {
    name: 'retry parked erasure work',
    schedule: { daily: { hourUTC: 9, minuteUTC: 40 } },
    kind: 'mutation',
    fn: internal.erasure.retryParkedDaily,
    args: {},
    pipeline: 'erasure',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // ── D258: one failing item never blocks a recurring job ─────────────────────────────────────────

  // A notification parked after three failed deliveries in a row is tried again hourly — hourly rather
  // than daily because it is only worth sending inside its twelve-hour freshness window; past that the
  // retry expires it instead (`notifications.retryParkedNotifications`).
  {
    name: 'retry parked notifications',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.notifications.retryParkedNotifications,
    args: {},
    pipeline: 'notifications',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Parked recurring work heals itself: once a day, a few parked skater prompts, map cards and
  // rollover bodies are tried again, least recently tried first (`recurringJobs.retryParkedDaily`).
  {
    name: 'retry parked recurring work',
    schedule: { daily: { hourUTC: 9, minuteUTC: 50 } },
    kind: 'mutation',
    fn: internal.recurringJobs.retryParkedDaily,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // The inbox's season purge (A08 §1.5): every notification created before this season's July 1 goes,
  // read or not. Daily, bounded, and a no-op for eleven months — the day after the boundary is the one
  // that matters, and a bounded pass means it clears over a few ticks rather than one huge transaction.
  {
    name: 'purge last season notifications',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.storageHygiene.purgeLastSeasonNotifications,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // The `activity_detected` producer (A08 §2.4): skates our recorder captured that sat `pending` past the
  // prompt delay get one "add a report?" notification, after a per-user dedup pass. Hourly is plenty —
  // the delay is hours, and the notification then rides the once-a-minute flush like every other.
  {
    name: 'prompt unreported skates',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.gpsActivities.sweepUnpromptedActivities,
    args: {},
    pipeline: 'notifications',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // `weatherCache` retention. Rows are addressable only during their own hour bucket (the cache key
  // contains it), so yesterday's rows are unreachable rather than merely stale — this is reclaiming
  // dead weight, and A02's per-sample-point weather grid multiplied how fast it accrues.
  {
    name: 'prune weather cache',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.storageHygiene.pruneWeatherCache,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },
  // The forward-forecast cache (A06c §2.5b), same cadence and the same argument: its rows become
  // unaddressable the moment their hour bucket passes, so this is reclaiming space rather than
  // invalidating anything.
  {
    name: 'prune forecast cache',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.storageHygiene.pruneForecastCache,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // **The weather cell registry safety net (A06h / D152).** `weatherCells` is a projection of the corpus
  // and the Tier-B sweep pages it, so a stale registry means a body is absent from weather discovery
  // and a vacated cell keeps costing Open-Meteo calls.
  //
  // ⚠ **This is the NET, not the mechanism.** The thing that actually invalidates the registry is a
  // corpus import completing, and `importRuns.finish` schedules a reconcile for exactly the run kinds
  // that can move a cell key (`WEATHER_CELL_INVALIDATING_KINDS`). That makes staleness ~zero on the few
  // days a year the corpus changes. This cron catches what the event misses: a dashboard hand-edit, a
  // loader that died before `finish`, a restore.
  //
  // **Weekly rather than daily** because a walk is ~85 MB per tier (a body row averages 3,383 bytes),
  // so daily over both tiers is ~5.1 GB/month — ~10% of Convex Pro's included 50 GB spent re-deriving
  // keys that did not change. Weekly is ~1.5%. NOT season-gated: the registry must be populated
  // *before* a season opens, and the corpus drifts in the off-season as readily as in it.
  {
    name: 'reconcile weather cell registry',
    schedule: { every: { hours: 24 * 7 } },
    kind: 'action',
    fn: internal.weatherArchive.maybeSyncWeatherCells,
    args: {},
    pipeline: 'weather',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  // **The Tier-B daily archive append (A06h / D153, D161).** Corpus-wide, ~3,043 `filter` cells, batched
  // and self-rescheduling. Daily rather than hourly because past days do not change — an append only has
  // to close yesterday and refresh today's partial row.
  //
  // ⚠ **Season-gated inside the action, not here.** Convex crons cannot be retuned at runtime, so the
  // tick is unconditional and `maybeRefreshFilterTier` decides whether to spend anything: running the
  // sweep year-round would burn ~43% of the annual free-tier budget mostly in July. Same
  // interval-with-a-gate shape as `maybeCheckSeasonOpen` and `recurrence.maybeRunRollover`, and for the
  // same reason — a tick that fails today is retried tomorrow, where a `cron` expression would wait a
  // year.
  {
    name: 'append daily weather archive',
    schedule: { every: { hours: 24 } },
    kind: 'action',
    fn: internal.weatherArchive.maybeRefreshFilterTier,
    args: {},
    pipeline: 'weather',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  // **The Tier-A bay append (A09 / Workstream 7).** Every live bay's browse cell, days and hours, so the
  // season's record is complete for every bay whether or not anyone opened it — ~128 calls a day. Same
  // interval-with-a-gate shape as the filter append above, for the same reason.
  {
    name: 'append daily bay weather archive',
    schedule: { every: { hours: 24 } },
    kind: 'action',
    fn: internal.weatherArchive.maybeRefreshBayTier,
    args: {},
    pipeline: 'weather',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  // The gap sweep (D161's recovery ladder). Separate from the append so a retry storm in one cannot
  // starve the other, and offset by running on its own 24h interval: past data is immutable, so a gap
  // is permanent unless something notices — and nothing in the weather path retried before A06h.
  {
    name: 'repair weather archive gaps',
    schedule: { every: { hours: 24 } },
    kind: 'action',
    fn: internal.weatherArchive.maybeSweepGaps,
    args: {},
    pipeline: 'weather',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },

  // Photo-orphan GC — the durable backstop behind the client's best-effort reclaim. Daily, because an
  // orphan costs only storage and the grace window before a photo is even a candidate is 30 days. Each
  // tick starts a lap (or stands down while one is running); the lap walks every photo past grace from
  // a saved position and owes the unshown ones to the photo settlement, which deletes (D258).
  {
    name: 'sweep orphan photos',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.storageHygiene.sweepOrphanPhotos,
    args: {},
    pipeline: 'photos',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // A removed photo's purge (B01-5e, D222): daily, the photos whose 30-day clock is due lose their bytes
  // and keep their rows as tombstones (`photoPurge`); a run takes a bounded page and continues itself.
  {
    name: 'purge removed photos',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.photoPurge.purgeDuePhotos,
    args: {},
    pipeline: 'photos',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // The stored-files sweep (B01-5e, `lib/photoFiles`): rotation attempts that can't be alive are
  // reconciled and doomed files retried — whatever a photo's own watch can no longer reach.
  {
    name: 'sweep photo files',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.photoPurge.sweepPhotoFiles,
    args: {},
    pipeline: 'photos',
    retention: CRON_RETENTION,
    record: 'every',
  },

  /**
   * Lapse access alerts whose TTL ran out, or whose season did (A06d / D73).
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
  {
    name: 'expire access alerts',
    schedule: { every: { hours: 6 } },
    kind: 'mutation',
    fn: internal.accessAlerts.expireLapsedAlerts,
    args: {},
    pipeline: 'access',
    retention: CRON_RETENTION,
    record: 'every',
  },

  /**
   * A departed skater's photos, expired with the season they were taken in (D66/A05a).
   *
   * Daily rather than annually, even though the clock it enforces turns over once a year: accounts are
   * tombstoned continuously, and a skater who leaves in August has photos from a season that ended in
   * June. Waiting for the next boundary would hold those for eleven months for no reason.
   */
  {
    name: 'expire departed skaters photos',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.storageHygiene.sweepDepartedPhotos,
    args: {},
    pipeline: 'photos',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // Expired data-export bundles. Hourly, unlike the other two, because an export is the densest
  // concentration of one person's data in the system and its whole point is being short-lived.
  {
    name: 'sweep expired exports',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.storageHygiene.sweepExpiredExports,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
  },

  /**
   * The season-rollover recurrence pass (A05c / §3.4) — the once-a-year job, checked daily.
   *
   * A daily tick with a month gate rather than a `crons.cron` expression, for two reasons. It keeps this
   * file uniform (every other job here is an interval), and more usefully it makes the rollover
   * **retryable**: a run that fails on July 2 is picked up on July 3, where a once-a-year expression
   * would wait a year. `maybeRunRollover` is a no-op outside the first week of July and a no-op again
   * once the season has been computed, so 358 of the 365 ticks cost one indexed read.
   */
  {
    name: 'recompute hazard recurrence at the rollover',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.recurrence.maybeRunRollover,
    args: {},
    pipeline: 'rollovers',
    retention: CRON_RETENTION,
    record: 'every',
  },

  /**
   * The corpus-standing rollover (A07b) — the third once-a-year job, same shape.
   *
   * Every active body with no report, track or hazard in the last `INACTIVE_SEASONS` (three) seasons,
   * no standing human decision (a curated boost, a favorite) and no saved put-in (D245) becomes
   * dormant: off every push
   * surface, drawn only when zoomed in on, and back the moment someone reports on it. Automatic
   * because dormancy is cheap to undo; recorded as an `importRuns` row so "did this season's pass
   * finish" is a fact, and gated on that row so the daily tick outside July 1–14 costs one indexed
   * read. Removal stays a human act (D48).
   */
  {
    name: 'demote inactive bodies at the rollover',
    schedule: { every: { hours: 24 } },
    kind: 'mutation',
    fn: internal.standing.maybeRunStandingRollover,
    args: {},
    pipeline: 'rollovers',
    retention: CRON_RETENTION,
    record: 'every',
  },

  /**
   * The season watch (A06e §3.3 / D149; A06i) — the other once-a-year job, same shape.
   *
   * Daily from the settings' floor (1 October by default), this keeps the observed overnight lows,
   * records when the ice watch opens, the first 20 °F sentinel night, winter region-wide and the end,
   * and sends at most one queued staff email a day (D212). It **does not** start the imagery: an admin
   * does, on `/admin/seasons` (D214). See `imageryIngest.ts` for why there is a floor at all — the
   * summit trigger can register a freeze on Mt Washington in August.
   *
   * At a fixed 11:30 UTC since B01-8b (D346; it was every 24 hours from whenever the last deploy set
   * its phase): 06:30 Eastern in winter, after the night's low and before the day, so its once-a-day
   * staff email lands at a fixed morning time and the page can show its next run.
   */
  {
    name: 'watch for the imagery season to open',
    schedule: { daily: { hourUTC: 11, minuteUTC: 30 } },
    kind: 'action',
    fn: internal.imageryIngest.maybeCheckSeasonOpen,
    args: {},
    pipeline: 'imagery',
    retention: CRON_RETENTION,
    announces: false,
    record: 'every',
  },

  /**
   * Live satellite imagery (A06i §5 / D214). Every six hours, once an admin has pressed *Start imagery*
   * on `/admin/seasons`, ask the catalog for passes published since the last check and queue each new
   * one for the pump. Whenever imagery is not running — most of the year — it is one indexed read and
   * a wake of the pump, which finds nothing to do and schedules nothing.
   *
   * Six hours rather than timed to orbits: what matters is when a processed granule reaches the
   * catalog, and that lags the pass by hours to a day on no schedule. One cheap request finds out.
   */
  {
    name: 'poll for new satellite imagery',
    schedule: { every: { hours: 6 } },
    kind: 'action',
    fn: internal.imageryLive.poll,
    args: {},
    pipeline: 'imagery',
    retention: SEASON_CRON_RETENTION,
    announces: true,
    record: 'every',
  },

  /**
   * The live imagery pump and index build (A06i §5 / D214). Fixed ticks rather than runs that schedule
   * their own next run — a fixed tick cannot be lost, doubled or wedged, which three review rounds of
   * self-scheduling could not say. With nothing queued or cutting, the pump tick is one read; with no
   * new frame, the index tick is one read.
   */
  {
    name: 'pump live satellite imagery',
    schedule: { every: { minutes: 3 } },
    kind: 'action',
    fn: internal.imageryLive.pump,
    args: {},
    pipeline: 'imagery',
    retention: SEASON_CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  {
    name: 'rebuild the live imagery index',
    schedule: { every: { minutes: 10 } },
    kind: 'action',
    fn: internal.imageryLive.buildIndex,
    args: {},
    pipeline: 'imagery',
    retention: SEASON_CRON_RETENTION,
    announces: true,
    record: 'every',
  },

  /**
   * NWS active alerts (A06c §2.5). Fifteen minutes because a winter storm warning is issued on that kind
   * of timescale and a skater deciding at 7am should not be reading 6am's picture — and because five
   * requests a quarter-hour is nothing to an unauthenticated public API that asks only for a
   * `User-Agent`. The sweep that retires a silent state's rows rides the same tick.
   */
  {
    name: 'refresh nws alerts',
    schedule: { every: { minutes: 15 } },
    kind: 'action',
    fn: internal.weatherAlerts.refreshAlerts,
    args: {},
    pipeline: 'weather',
    retention: CRON_RETENTION,
    announces: false,
    record: 'every',
  },

  /**
   * Map summary cards (A06c §5). The only thing this catches is *time* — a report aging out of the
   * 14-day window, or a season boundary; every event-driven change to a card already happens
   * synchronously on the write that caused it.
   *
   * **Reads only the cards that are due** (`bodySummaryRefreshes`), so a tick costs what has aged
   * out since the last one — usually an empty index range — rather than a walk of the whole corpus
   * (~84 MB a tick at six-hourly, ~10 GB a month, before this). That is also why it is hourly now: a
   * card that has lost a report says so within the hour, for a handful of small function calls a day.
   */
  {
    name: 'sweep body summaries',
    schedule: { every: { hours: 1 } },
    kind: 'action',
    fn: internal.waterBodies.sweepDueBodySummaries,
    args: {},
    pipeline: 'bodies',
    retention: CRON_RETENTION,
    announces: false,
    record: 'every',
  },

  // ── B01-3: the Bodies library ─────────────────────────────────────────────────────────────────

  /**
   * The library's rows, kept current where no moderator's write refreshes them (B01 §12.8): the
   * machine's bulk writes queue their bodies and this drains them, a bounded batch a minute; an empty
   * queue is one empty index read.
   */
  {
    name: 'drain the bodies library queue',
    schedule: { every: { minutes: 1 } },
    kind: 'mutation',
    fn: internal.bodyLibrary.drainQueue,
    args: {},
    pipeline: 'bodies',
    retention: CRON_RETENTION,
    record: FREQUENT_CRON_RECORD,
  },
  /** The season turning re-counts the rows of the last season; any other hour reads an empty range. */
  {
    name: 'turn the bodies library season',
    schedule: { every: { hours: 1 } },
    kind: 'mutation',
    fn: internal.bodyLibrary.turnSeason,
    args: {},
    pipeline: 'bodies',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /** The drift repair: the oldest-refreshed rows, a few a tick — the corpus about every four days. */
  {
    name: 'repair bodies library drift',
    schedule: { every: { minutes: 2 } },
    kind: 'mutation',
    fn: internal.bodyLibrary.repairDrift,
    args: {},
    pipeline: 'bodies',
    retention: CRON_RETENTION,
    record: FREQUENT_CRON_RECORD,
  },

  // ── The Inbox (B01-5) ──
  /**
   * The drift repair: the oldest-refreshed open items, a few a tick, each re-derived from its members and
   * their sources; and the backfill's failures retried. Nothing a moderator does depends on it.
   */
  {
    name: 'repair inbox items drift',
    schedule: { every: { minutes: 3 } },
    kind: 'mutation',
    fn: internal.inboxItems.repair,
    args: {},
    pipeline: 'inbox',
    retention: CRON_RETENTION,
    record: FREQUENT_CRON_RECORD,
  },

  // ── The Corpus tasks (B01-7a) ──
  /**
   * The drift repair: the oldest-refreshed open tasks and a lap over every body with a review reason,
   * each body re-synced from its fields, and each lane's counts recounted; and the backfill's failures
   * retried. The net for a write that skipped the one writer; its fixes and failures show on Machinery.
   */
  {
    name: 'repair corpus tasks drift',
    schedule: { every: { minutes: 3 } },
    kind: 'mutation',
    fn: internal.corpusTaskJobs.repair,
    args: {},
    pipeline: 'corpus',
    retention: CRON_RETENTION,
    record: FREQUENT_CRON_RECORD,
  },

  // ── People (B01 §5.7) ──
  /**
   * A lapsed suspension's stored status is reset to active (D222): each person in their own nested
   * transaction, a failure counted and walked past, three in a row parked. Never an account in its
   * deletion window, being finalized, or deleted.
   */
  {
    name: 'reset lapsed suspensions',
    schedule: { every: { minutes: 15 } },
    kind: 'mutation',
    fn: internal.peopleJobs.sweepLapsedSuspensions,
    args: {},
    pipeline: 'people',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /** Parked suspension resets tried again once a day, least recently tried first. */
  {
    name: 'retry parked suspension resets',
    schedule: { daily: { hourUTC: 9, minuteUTC: 50 } },
    kind: 'mutation',
    fn: internal.peopleJobs.retryLapsedDaily,
    args: {},
    pipeline: 'people',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /** The People rows' drift repair: the oldest-refreshed rows re-derived from their profiles. */
  {
    name: 'repair people rows drift',
    schedule: { every: { minutes: 10 } },
    kind: 'mutation',
    fn: internal.peopleJobs.repairDrift,
    args: {},
    pipeline: 'people',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /**
   * Clerk's sign-in lock checked against Convex's status (B01-4k, D277): every profile banned in Convex
   * must be locked in Clerk, every Clerk user locked must be banned in Convex, and a mismatch is repaired
   * through `clerkAdmin.setBanned`. Daily is enough for the two rare gaps it closes; its repairs are
   * counted on Machinery (`clerkMirror`) and mailed to the operator in one summary.
   */
  {
    name: 'reconcile clerk ban locks',
    schedule: { daily: { hourUTC: 10, minuteUTC: 20 } },
    kind: 'action',
    fn: internal.clerkReconcile.run,
    args: {},
    pipeline: 'people',
    retention: CRON_RETENTION,
    announces: false,
    record: 'every',
  },

  // ── B03 §9: the consent record (D295, D297) ──────────────────────────────────────────────────

  /** Terms readings that never became an acceptance go 30 days after they opened, a bounded page a run. */
  {
    name: 'prune terms readings',
    schedule: { daily: { hourUTC: 10, minuteUTC: 30 } },
    kind: 'mutation',
    fn: internal.consent.pruneReadings,
    args: {},
    pipeline: 'consent',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /**
   * Severed consent records whose six years are up (D297): the only delete of a record. Bounded, and
   * its range starts at `purgeAt >= 1` — the index is on an optional field (`consent.purgeDue`).
   */
  {
    name: 'purge due consent records',
    schedule: { daily: { hourUTC: 10, minuteUTC: 40 } },
    kind: 'mutation',
    fn: internal.consent.purgeDue,
    args: {},
    pipeline: 'consent',
    retention: CRON_RETENTION,
    record: 'every',
  },

  // ── B01-3b: the geometry facts ──────────────────────────────────────────────────────────────────

  /** Recompute the bodies whose touching bodies and places are stale (an action: geometry has room). */
  {
    name: 'compute body geometry facts',
    schedule: { every: { minutes: 5 } },
    kind: 'action',
    fn: internal.bodyGeo.computeDue,
    args: {},
    pipeline: 'geometry',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  /** The daily retry of parked geometry computations, least recently tried first. */
  {
    name: 'retry parked body geometry',
    schedule: { every: { hours: 24 } },
    kind: 'action',
    fn: internal.bodyGeo.computeDue,
    args: {
      parked: true,
    },
    pipeline: 'geometry',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
  },
  /**
   * The drift repair: computed facts checked against their inputs, the longest-unchecked first — a net
   * for marks a writer missed, so slow on purpose (40 rows a half hour, the corpus in about two weeks;
   * each check reads a body's outline, so a faster sweep costs reads every day for rare misses).
   */
  {
    name: 'repair body geometry drift',
    schedule: { every: { minutes: 30 } },
    kind: 'mutation',
    fn: internal.bodyGeo.repairDrift,
    args: {},
    pipeline: 'geometry',
    retention: CRON_RETENTION,
    record: 'every',
  },
  /** Bodies with no geometry facts row at all, found from the library and marked — weekly. */
  {
    name: 'find bodies missing geometry',
    schedule: { every: { hours: 168 } },
    kind: 'mutation',
    fn: internal.bodyGeo.repairMissing,
    args: {},
    pipeline: 'geometry',
    retention: CRON_RETENTION,
    record: 'every',
  },
];

/** The entries by name, built once at module load. */
const CRON_JOBS_BY_NAME: ReadonlyMap<string, CronJobEntry> = new Map(
  CRON_JOBS.map((j) => [j.name, j]),
);
