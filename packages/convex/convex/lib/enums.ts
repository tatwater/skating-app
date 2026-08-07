/**
 * Enum vocabularies that live only in the backend data model (06-data-model.md).
 *
 * The shared, cross-surface vocabulary (ice types, surface tags, hazard types,
 * visibility, roles, statuses, water-body types, skate qualities) is single-sourced
 * in `@skating/core` and imported directly into the schema — NOT redefined here.
 * These are the backend-centric enums the apps rarely need to enumerate.
 */

import { BODY_FEATURE_TYPES as CORE_BODY_FEATURE_TYPES, HAZARD_VERDICTS } from '@skating/core';

/**
 * Where a GPS activity came *in* from — the A-inputs of the Phase 8 pipeline (D24).
 *
 * `native` is our own in-app recorder and is the only one wired today. It matters that it's a
 * first-class provider value rather than a special case: an activity recorded here is **our**
 * first-party data, legally free to aggregate and draw on public reports, where a track pulled from
 * `strava` never could be (L7). The remaining values are the deferred watch adapters, kept so adding
 * one later is an adapter, not a schema migration.
 */
export const ACTIVITY_PROVIDERS = [
  'native',
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

/**
 * Where a water body came from (D14).
 *
 * **`3dhp` is here for completeness rather than for traffic.** The merge's last run produced zero
 * 3DHP-sourced bodies — 3DHP re-publishes NHD across the whole Northeast, so every 3DHP feature that
 * survives the filter has an NHD counterpart that outranks it as identity (D92). But a 3DHP feature
 * matching nothing is a lake neither other catalogue draws, and refusing to store it would mean the
 * import silently dropping exactly the kind of body this phase exists to find.
 */
export const WATER_BODY_SOURCES = ['osm', 'nhd', '3dhp', 'user'] as const;

/** Canonical (non-user) sources — the external feeds `importCanonical` upserts (D14). */
export const CANONICAL_SOURCES = ['osm', 'nhd', '3dhp'] as const;

/**
 * Whose polygon a body actually draws — a superset of `WATER_BODY_SOURCES` (N7 / D92).
 *
 * **`3dhp` appears here and not in `WATER_BODY_SOURCES`**, and the asymmetry is the design. D92
 * settled that 3DHP cannot be the identity spine — it carries no `Permanent_Identifier`, so it can
 * hold neither the MIDAS bathymetry linkage nor the OSM duplicate collapse — but *geometry* is a
 * separate question that `geometrySource` exists to answer per lake. A 3DHP-drawn body still has an
 * OSM or NHD identity.
 *
 * It is empty in practice today: the merge's last run drew 19,455 bodies from OSM and 6,002 from NHD
 * and **zero** from 3DHP, because 3DHP re-publishes NHD across the whole Northeast and every 3DHP
 * feature that survives the filter has an NHD counterpart that outranks it. The value exists so that
 * the day elevation-derived hydrography lands here, storing it is a field write rather than a
 * migration — which is the entire argument for `geometrySource` being a field at all.
 */
export const GEOMETRY_SOURCES = ['osm', 'nhd', '3dhp', 'user'] as const;

/** Moderation review lifecycle for user-created water bodies (D37). */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** Administrative-boundary granularity for point→place labels (Phase 5). */
export const ADMIN_AREA_LEVELS = ['state', 'county', 'town'] as const;

/** Dedup state for user-created water bodies (D36). */
/**
 * Dedup lifecycle (D36). `near_certain` is the top match-on-create tier — kept distinct from
 * `suspected_duplicate` so the moderator queue can put the obvious ones first, and because the two
 * mean genuinely different things ("these might be the same water" vs "these are almost certainly
 * the same water"). Adding a member to the union is migration-free: no stored row carries it yet.
 *
 * A `near_certain` body is still **listed** (`isListed`) — it is auto-visible then reviewed (D37).
 * Hiding it would take any reports and hazards filed against it off the map on a machine's guess,
 * which is exactly the never-hide line we don't cross (D3).
 */
export const DEDUP_STATUSES = ['clean', 'suspected_duplicate', 'near_certain', 'merged'] as const;

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
 * The hazard confirmation vote — **re-exported from `@skating/core`, not redefined here.**
 *
 * Three tiers of "is it still there" (D52), replacing the old binary `still_there | gone`: "gone"
 * conflated *healed* with *safe*, but a refrozen lead is thin ice and a healed ridge is a line of
 * refrozen blocks. Plus `never_existed` (D65), which is a claim about the *report* rather than the
 * ice — it pools with `fully_healed` toward the same 2-vote archive and additionally files a
 * moderation flag, because two people calling a pin bogus is a pattern somebody should see.
 *
 * It used to be a second hand-written copy of core's union, which is how D65's addition reached the
 * validator and the schema while a test that iterated "every verdict" went on iterating three. The
 * file header already says shared vocabulary is single-sourced in core; this one now is.
 */
export const HAZARD_CONFIRM_VERDICTS = HAZARD_VERDICTS;
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
  // The draw-time duplicate nudge (N5c / D80): a skater about to mark a hazard was shown the pin
  // already there and confirmed that one instead. Distinct from the others because it is the *only*
  // trigger that also tells us a duplicate was prevented, which is how the nudge's conversion rate
  // becomes measurable rather than assumed.
  'duplicate_nudge',
] as const;

/** The authoring primitive a hazard was drawn with (D51). */
export const HAZARD_GEOMETRY_KINDS = ['point_radius', 'line', 'polygon'] as const;

/**
 * The annotation on a hazard, derived from its votes (D52) — plus `disputed` (D64), which is
 * **passage markers only**: one skater reporting a crossing closed is one vote short of retiring it,
 * and until D64 that first vote changed nothing on screen. On a danger the same disclosure would
 * invite skaters to discount a live warning, which is why it is not allowed to reach one.
 */
export const HAZARD_HEALING_STATES = ['none', 'healing_unsafe', 'disputed'] as const;

/**
 * Persistent, non-decaying known features of a water body (D53) — **re-exported from `@skating/core`,
 * not redefined here**, for the same reason `HAZARD_CONFIRM_VERDICTS` is: a second hand-written copy
 * is how D65's new verdict reached the validator while a test iterating "every verdict" went on
 * iterating three. D79's authoring form made this the third reader of the list.
 */
export const BODY_FEATURE_TYPES = CORE_BODY_FEATURE_TYPES;

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
  // Named sub-areas (N2/D60). Drawing one is a content lever with real reach — it renames what a
  // skater sees on their own report — so each write is attributed. Delisting and restoring reuse the
  // generic `remove` / `restore` verbs, disambiguated by the `waterBodySubArea` target type, exactly
  // as `hide` / `remove` are already shared across content kinds.
  // Duplicate hazards folded into one (N5c / D80). `merge_hazards` is written by the **machine** as
  // well as by a moderator — deliberately, because an automatic merge that leaves no audit row is a
  // mechanism nobody can check, and this one is meant to be watched before it is trusted.
  'merge_hazards',
  'unmerge_hazards',
  // A cross-season pattern a moderator judged not to be one (N5c / §7.3) — three pins in one cove
  // across three winters that are three people misreading the same shadow. Never a delete: the
  // cluster stops being suggested and stops being publicly advisable, and the reason stays readable.
  'suppress_recurrence',
  'unsuppress_recurrence',
  // A cluster graduated into a permanent feature (D53 + §8.2). Distinct from `promote_body_feature`,
  // which records a *single hazard* graduating: this one is a claim about several winters, and an
  // audit that could not tell them apart would lose the difference between "somebody saw this once
  // and thought it permanent" and "this came back four times".
  'promote_recurrence',
  'set_weather_sample_points', // placed the multi-cell weather sampling grid on a giant (D56 §5)
  'set_lake_depth', // typed a surveyed depth in, the top rung of the D68 ladder (N6a)
  'create_sub_area',
  'redraw_sub_area', // geometry changed — schedules a re-stamp of the parent's reports + hazards
  'rename_sub_area', // name or aliases changed — also a re-stamp, since the name is denormalized
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
  'waterBodySubArea', // N2 (D60): a named region inside one body
  'hazardRecurrence', // N5c (D78): a cross-season pattern a moderator suppressed or restored
] as const;

/** In-app support inbox (D37). */
export const SUPPORT_CATEGORIES = ['bug', 'account', 'safety', 'other'] as const;
export const SUPPORT_STATUSES = ['open', 'in_progress', 'resolved'] as const;

/**
 * Data-export bundle lifecycle (D33/D62, N3). `building` is a real state rather than an
 * implementation detail: assembling a bundle is an action that can take a while and can fail, and a
 * user who clicked "export my data" and sees nothing has no way to tell "still working" from
 * "broken". `failed` carries a reason for the same reason.
 */
export const DATA_EXPORT_STATUSES = ['building', 'ready', 'failed'] as const;

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

/**
 * Which loader an `importRuns` row describes (N6c F2). One member per manual ETL under `scripts/`,
 * because "how did the last import go" is a question about a *pipeline*, and the coverage of the
 * depth join is not comparable to the coverage of the wind-rose fetch.
 */
export const IMPORT_RUN_KINDS = [
  'canonical_water', // scripts/etl — OSM extract → waterBodies
  // scripts/etl merge — the three archives reconciled offline into one master list (N7). Distinct
  // from `canonical_water`, which is the *load*: this pass writes nothing to Convex and is where
  // every admission decision is actually made, so "how many bodies did the corpus lose and why" is
  // a question only this row can answer.
  'corpus_merge',
  // scripts/etl load-sub-areas — the bays the merge found a parent for (N7 second audit). A bay
  // with a parent is an arm of it, not a lake beside it, so it lands in `waterBodySubAreas` and not
  // in the corpus. Its own kind because it fails differently: a bay that cannot find its parent is
  // an ordering error in the campaign, not a body that failed a rule.
  'sub_area_seed',
  'osm_depths', // scripts/etl load-depths — the N6a rung-7 tag stream
  'admin_areas', // scripts/admin-areas
  'lake_depth', // scripts/lake-depth — HydroLAKES/GLOBathy/LAGOS-US join
  'elevation', // scripts/lake-depth load-elevation — Open-Meteo
  'wind_climate', // scripts/wind-climate — NREL WIND Toolkit winter roses
  'bathymetry_coverage', // scripts/bathymetry coverage — D2's hasContours
  'region_stats', // convex regionStats:recompute — derived, but it is a pass and it can fail
  // The steps *before* a loader — where the third-party data is actually acquired, and where a
  // source most often turns out to have moved, changed schema, or quietly returned less than
  // last time. Logging only the load answers "how many rows landed" and never "landed from what".
  'raw_archive', // a `.raw/` archive populated from third parties (OSM extracts, agency services)
  'r2_mirror', // scripts/lib/mirror-r2.sh — pushing an archive to its private R2 bucket
  'bathymetry_join', // scripts/bathymetry join — archived lakes matched to corpus bodies
  'bathymetry_build', // scripts/bathymetry build-contours — soundings/contours → drawable isobaths
  'bathymetry_tiles', // scripts/bathymetry tile — contours → PMTiles
] as const;

/**
 * A run's terminal state. **`running` is not merely a transient** — a row left in it is the
 * signature of a loader whose process died without getting to write a summary, which is exactly
 * the failure mode a printed-to-stderr summary could never record.
 */
export const IMPORT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
