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
] as const;

/** Lifecycle of a detected GPS skate → report prompt (D24). */
export const ACTIVITY_PROMPT_STATES = ['pending', 'prompted', 'converted', 'dismissed'] as const;

/** Where a water body came from (D14). */
export const WATER_BODY_SOURCES = ['osm', 'nhd', 'user'] as const;

/** Canonical (non-user) sources — the external feeds `importCanonical` upserts (D14). */
export const CANONICAL_SOURCES = ['osm', 'nhd'] as const;

/** Moderation review lifecycle for user-created water bodies (D37). */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** Administrative-boundary granularity for point→place labels (Phase 5). */
export const ADMIN_AREA_LEVELS = ['state', 'county', 'town'] as const;

/** Dedup state for user-created water bodies (D36). */
export const DEDUP_STATUSES = ['clean', 'suspected_duplicate', 'merged'] as const;

/** Why an admin soft-delisted a water body — reversible, never a hard delete (D48). */
export const REMOVAL_REASONS = [
  'landowner_request',
  'unskateable',
  'junk',
  'duplicate',
  'other',
] as const;

/** How a report entered the system. */
export const REPORT_SOURCES = ['native', 'activity', 'imported'] as const;

// THICKNESS_METHODS moved to `@skating/core` (shared report vocab — the report form + the
// `validateReportInput` contract both need it), alongside ICE_TYPES / SURFACE_TAGS.

// SKY_CONDITIONS / PRECIP_TYPES / CONDITION_SOURCES moved to `@skating/core` (shared report vocab —
// the report form + `validateReportInput` need them), alongside ICE_TYPES / SURFACE_TAGS.

/** Content moderation state shared by reports/comments (D32). */
export const MODERATION_STATUSES = ['visible', 'hidden', 'removed'] as const;

/** Where a comment came from (native app vs. forum/email ingestion, Q8). */
export const COMMENT_SOURCES = ['native', 'imported'] as const;

/**
 * Hazard **lifecycle** status (archived, never hard-deleted, D15).
 *
 * Deliberately a different axis from `MODERATION_STATUSES`, which hazards *also* carry (Phase 9).
 * Archiving means the community voted a hazard healed; hiding means a moderator judged the pin bad.
 * Collapsing them would make abuse indistinguishable from a safety verdict (D3).
 */
export const HAZARD_STATUSES = ['active', 'archived'] as const;

/**
 * The three-tier hazard confirmation vote (D52) + its trigger (D12/D15).
 *
 * Replaces the old binary `still_there | gone` (Phase 9): "gone" conflated *healed* with *safe*, but a
 * refrozen lead is thin ice and a healed ridge is a line of refrozen blocks. Only `fully_healed` counts
 * toward removal; `healing_unsafe` keeps the pin up so the next skater can read the healing ice.
 */
export const HAZARD_CONFIRM_VERDICTS = ['still_there', 'healing_unsafe', 'fully_healed'] as const;
/**
 * What triggered a confirmation (D12). Kept distinct because the trigger is evidence about the
 * confirmation's quality: `proximity_alert` means the skater was standing within alert range of the
 * hazard when they answered, which is a much stronger observation than confirming from a list — and
 * conflating the two would throw that signal away before we ever get to weigh it (D50).
 */
export const HAZARD_CONFIRM_VIA = [
  'app_open_nearby',
  'proximity_alert',
  'report_flow',
  'strava_path',
] as const;

/** The authoring primitive a hazard was drawn with (D51). */
export const HAZARD_GEOMETRY_KINDS = ['point_radius', 'line', 'polygon'] as const;

/** Latest "healing but unsafe" annotation on a hazard (D52). */
export const HAZARD_HEALING_STATES = ['none', 'healing_unsafe'] as const;

/**
 * Persistent, non-decaying known features of a water body (D53) — always shown, never re-marked,
 * no confirmation loop. Moving water at springs/constrictions/bridges is weaker *every* season
 * regardless of cold, and some ridges reform in the same place annually.
 */
export const BODY_FEATURE_TYPES = [
  'spring_current',
  'constriction',
  'bridge_narrows',
  'recurring_pressure_ridge',
  'gas_hole',
  'reef_hole',
  'delta',
  'shallow_bay_early_thaw',
  'other',
] as const;

/** Abuse/safety flag targets, reasons, and lifecycle (D32/D37). `hazard` added Phase 9 (D51). */
export const FLAG_TARGET_TYPES = ['report', 'comment', 'photo', 'user', 'hazard'] as const;
export const FLAG_REASONS = [
  'unsafe_false_report',
  'spam',
  'harassment',
  'inappropriate',
  // Auto-routed to the mod queue when a target crosses the net-unhelpful threshold (D50, Phase 6).
  // Written by `ratings.ts`; NEVER hides the target (visibility of safety content isn't score-gated, D3).
  'auto_low_quality',
  'other',
] as const;
export const FLAG_STATUSES = ['open', 'reviewing', 'actioned', 'dismissed'] as const;

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
  'set_curated_boost', // adjust a body's D49 display prominence (admin, Phase 2)
  'set_put_in', // admin placed an official put-in marker (Phase 4, decision #7)
  'resolve_flag',
  'dismiss_flag',
  'grant_role',
  'revoke_role',
  'set_posting_permission', // restrict/restore a canPost* right — finer than ban/suspend (D57, Phase 7)
  'promote_body_feature', // a recurring hazard graduated to a persistent body feature (D53, Phase 9)
  'demote_body_feature', // reversible: flips `active` off, never hard-deletes (D53)
] as const;
export const MODERATION_TARGET_TYPES = [
  'report',
  'comment',
  'photo',
  'user',
  'waterbody',
  'contentFlag',
  'hazard', // Phase 9 (D51): mods can hide a bad pin; admins promote/demote body features
  'bodyFeature',
] as const;

/** In-app support inbox (D37). */
export const SUPPORT_CATEGORIES = ['bug', 'account', 'safety', 'other'] as const;
export const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'] as const;

/** Bounty lifecycle (D17). */
export const BOUNTY_STATUSES = ['open', 'fulfilled', 'expired', 'cancelled'] as const;

/**
 * What the bounty-create gate decided (Phase 7b analytics). One row per *attempt* — including the two
 * rejections, which is the whole point: a gate you only observe when it passes tells you nothing about
 * whether it's set right. `suppressed` = a recent report still counted as fresh eyes (decision 8);
 * `capped` = the requester already holds MAX_OPEN_BOUNTIES_PER_DAY (decision 7).
 */
export const BOUNTY_GATE_DECISIONS = ['allowed', 'suppressed', 'capped'] as const;

/** Helpful/unhelpful thumb on a report (D17). */
export const RATING_VERDICTS = ['helpful', 'unhelpful'] as const;

/**
 * Notification types (snake_case) and the matching `notificationPrefs` keys
 * (camelCase). D16 invariant: these two lists mirror each other 1:1.
 *
 * The last three are Phase 4's drive-time/favorites set (decision #4): a favorited-body report
 * (default on, any distance), an opt-in "all reports within X₁" daily digest, and an opt-in
 * "great reports within X₂" alert. See `NOTIFICATION_PREF_DEFAULTS` for the per-key defaults.
 */
export const NOTIFICATION_TYPES = [
  'activity_detected',
  'bounty_request',
  'hazard_confirmation',
  'bounty_fulfilled',
  'report_rated',
  'report_commented', // someone commented on your report (D21; Phase 3) — delivery deferred
  'content_flag_resolved',
  'favorite_report', // a report on a body you favorited (Phase 4, decision #4)
  'nearby_report_digest', // daily 8pm-ET digest of all reports within X₁ (Phase 4)
  'great_report_nearby', // a `great` report within X₂ (Phase 4)
] as const;
export const NOTIFICATION_PREF_KEYS = [
  'activityDetected',
  'bountyRequest',
  'hazardConfirmation',
  'bountyFulfilled',
  'reportRated',
  'reportCommented', // mirrors `report_commented` (D21; Phase 3) — toggle exists, delivery deferred
  'contentFlagResolved',
  'favoriteReport', // mirrors `favorite_report` (Phase 4)
  'nearbyReportDigest', // mirrors `nearby_report_digest` (Phase 4)
  'greatReportNearby', // mirrors `great_report_nearby` (Phase 4)
] as const;

/**
 * Per-key default for a fresh profile (D16). Everything defaults ON *except* the two opt-in Phase-4
 * drive-time buckets (decision #4): favorites notify by default, but "all reports nearby" and "great
 * reports nearby" are conservative (push) surfaces the user must opt into. Single-sourced so
 * `upsertFromClerk`'s defaults and `backfillNotificationPrefs`'s missing-key fill agree.
 */
export const NOTIFICATION_PREF_DEFAULTS: Record<(typeof NOTIFICATION_PREF_KEYS)[number], boolean> =
  {
    activityDetected: true,
    bountyRequest: true,
    hazardConfirmation: true,
    bountyFulfilled: true,
    reportRated: true,
    reportCommented: true,
    contentFlagResolved: true,
    favoriteReport: true,
    nearbyReportDigest: false,
    greatReportNearby: false,
  };

/** Put-in marker provenance (Phase 4, decision #7): clustered from reports vs. admin-set. */
export const PUTIN_SOURCES = ['derived', 'official'] as const;

/** Put-in marker visibility — a moderator `hide` suppresses a coord regardless of re-clustering. */
export const PUTIN_STATUSES = ['visible', 'hidden'] as const;

/**
 * Coalescing-queue bucket (Phase 4, decision #4). `digest` = the once-daily 8pm-ET "all within X₁"
 * roll-up; `favorite` / `great` fire after a short per-`(user, body)` debounce. The bucket picks the
 * `flushAfter` when a row is enqueued; one cron drains everything whose `flushAfter` has passed.
 */
export const NOTIFICATION_QUEUE_KINDS = ['digest', 'favorite', 'great'] as const;

/** Reputation/trust ledger reasons (D17/D50). Boost-only in practice; no public penalties. */
export const POINT_EVENT_REASONS = [
  'report_submitted',
  'photo_evidence',
  'measured_thickness', // report carries ≥1 measured (not estimated) reading; once per report (D50)
  'helpful_thumb',
  'report_corroborated', // independent same-body report agreed within the window (D50)
  'hazard_confirmed',
  'hazard_corroborated', // your hazard confirmed by ≥2 peers — author-side boost (D50, Phase 6)
  'bounty_fulfilled',
] as const;
