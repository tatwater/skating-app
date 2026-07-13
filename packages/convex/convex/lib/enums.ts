/**
 * Enum vocabularies that live only in the backend data model (06-data-model.md).
 *
 * The shared, cross-surface vocabulary (ice types, surface tags, hazard types,
 * visibility, roles, statuses, water-body types, skate qualities) is single-sourced
 * in `@skating/core` and imported directly into the schema — NOT redefined here.
 * These are the backend-centric enums the apps rarely need to enumerate.
 */

/** Linked GPS providers — all six v1-scoped, provider-agnostic (D24). */
export const ACTIVITY_PROVIDERS = [
  'strava',
  'garmin',
  'coros',
  'polar',
  'apple_health',
  'google_health_connect',
  'other',
] as const

/** Lifecycle of a detected GPS skate → report prompt (D24). */
export const ACTIVITY_PROMPT_STATES = ['pending', 'prompted', 'converted', 'dismissed'] as const

/** Where a water body came from (D14). */
export const WATER_BODY_SOURCES = ['osm', 'nhd', 'user'] as const

/** Canonical (non-user) sources — the external feeds `importCanonical` upserts (D14). */
export const CANONICAL_SOURCES = ['osm', 'nhd'] as const

/** Moderation review lifecycle for user-created water bodies (D37). */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

/** Dedup state for user-created water bodies (D36). */
export const DEDUP_STATUSES = ['clean', 'suspected_duplicate', 'merged'] as const

/** Why an admin soft-delisted a water body — reversible, never a hard delete (D48). */
export const REMOVAL_REASONS = [
  'landowner_request',
  'unskateable',
  'junk',
  'duplicate',
  'other',
] as const

/** How a report entered the system. */
export const REPORT_SOURCES = ['native', 'activity', 'imported'] as const

// THICKNESS_METHODS moved to `@skating/core` (shared report vocab — the report form + the
// `validateReportInput` contract both need it), alongside ICE_TYPES / SURFACE_TAGS.

// SKY_CONDITIONS / PRECIP_TYPES / CONDITION_SOURCES moved to `@skating/core` (shared report vocab —
// the report form + `validateReportInput` need them), alongside ICE_TYPES / SURFACE_TAGS.

/** Content moderation state shared by reports/comments (D32). */
export const MODERATION_STATUSES = ['visible', 'hidden', 'removed'] as const

/** Where a comment came from (native app vs. forum/email ingestion, Q8). */
export const COMMENT_SOURCES = ['native', 'imported'] as const

/** Hazard entity lifecycle status (archived, never hard-deleted, D15). */
export const HAZARD_STATUSES = ['active', 'archived'] as const

/** Waze-style hazard confirmation vote + its trigger (D12/D15). */
export const HAZARD_CONFIRM_VERDICTS = ['still_there', 'gone'] as const
export const HAZARD_CONFIRM_VIA = ['app_open_nearby', 'report_flow', 'strava_path'] as const

/** Follow request state; pending only when the followee requires approval (D13). */
export const FOLLOW_STATUSES = ['pending', 'accepted'] as const

/** Abuse/safety flag targets, reasons, and lifecycle (D32/D37). */
export const FLAG_TARGET_TYPES = ['report', 'comment', 'photo', 'user'] as const
export const FLAG_REASONS = [
  'unsafe_false_report',
  'spam',
  'harassment',
  'inappropriate',
  'other',
] as const
export const FLAG_STATUSES = ['open', 'reviewing', 'actioned', 'dismissed'] as const

/** Moderator/admin audit-log actions and their targets (D37). */
export const MODERATION_ACTIONS = [
  'hide',
  'remove',
  'restore',
  'ban',
  'suspend',
  'unban',
  'merge_waterbody',
  'approve_waterbody',
  'reject_waterbody',
  'resolve_flag',
  'dismiss_flag',
  'grant_role',
  'revoke_role',
] as const
export const MODERATION_TARGET_TYPES = [
  'report',
  'comment',
  'photo',
  'user',
  'waterbody',
  'contentFlag',
] as const

/** In-app support inbox (D37). */
export const SUPPORT_CATEGORIES = ['bug', 'account', 'safety', 'other'] as const
export const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'] as const

/** Bounty lifecycle (D17). */
export const BOUNTY_STATUSES = ['open', 'fulfilled', 'expired', 'cancelled'] as const

/** Helpful/unhelpful thumb on a report (D17). */
export const RATING_VERDICTS = ['helpful', 'unhelpful'] as const

/**
 * Notification types (snake_case) and the matching `notificationPrefs` keys
 * (camelCase). D16 invariant: these two lists mirror each other 1:1.
 */
export const NOTIFICATION_TYPES = [
  'activity_detected',
  'bounty_request',
  'followed_posted_nearby',
  'hazard_confirmation',
  'bounty_fulfilled',
  'new_follower',
  'report_rated',
  'content_flag_resolved',
] as const
export const NOTIFICATION_PREF_KEYS = [
  'activityDetected',
  'bountyRequest',
  'followedPostedNearby',
  'hazardConfirmation',
  'bountyFulfilled',
  'newFollower',
  'reportRated',
  'contentFlagResolved',
] as const

/** Reputation ledger reasons (D17). */
export const POINT_EVENT_REASONS = [
  'report_submitted',
  'photo_evidence',
  'helpful_thumb',
  'hazard_confirmed',
  'bounty_fulfilled',
] as const
