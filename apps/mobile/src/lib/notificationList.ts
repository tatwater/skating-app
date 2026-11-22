/**
 * What the inbox screen asks `notifications.list` for (B01-5c): the notification types this build's
 * core words, so the server serves each one it can describe as itself — and every type added after
 * this build as the `unknown` row, which every build words. Without it the server assumes the types
 * every build installed before the Inbox wave knows, and a type this build *does* word (a moderator's
 * decision, D285) would read as "an older notification" here.
 *
 * Its own module, beside the screen's other pure halves (`notificationCacheModel`,
 * `notificationRoutes`), so it is tested without a native runtime.
 */

import { NOTIFICATION_TYPES } from '@skating/core';

/** The list's arguments past pagination: this build's own vocabulary, read from its core. */
export const NOTIFICATION_LIST_ARGS: { knows: string[] } = { knows: [...NOTIFICATION_TYPES] };
