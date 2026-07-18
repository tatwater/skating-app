/**
 * Scheduled jobs (Convex crons). Phase 4 adds the notification-queue flush (decision #4): a single
 * frequent drain that delivers every queued row whose `flushAfter` has passed — favorites/great after
 * their short debounce, and the "all nearby" digest at its next-8pm-ET target. One unified drain keeps
 * delivery simple; the bucket picks the timing when the row is enqueued (see `notifications.ts`).
 */

import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'flush notification queue',
  { minutes: 1 },
  internal.notifications.flushNotificationQueue,
  {},
)

export default crons
