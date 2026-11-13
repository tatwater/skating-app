import type { Doc } from '@skating/convex/dataModel';

/**
 * An audit row as History reads it, from the operator's side: a past-tense sentence ("Hid a
 * report", "Set the curated boost"), never the verb's code name. Every verb the audit table can hold
 * has its words here — the map is typed over the table's own union, so a verb added on the server
 * without its words fails to compile.
 */

export type AuditAction = Doc<'moderationActions'>['action'];
export type AuditTarget = Doc<'moderationActions'>['targetType'];

/** What a row acted on, with its article: "a report", "an account". */
const TARGET: Record<AuditTarget, string> = {
  report: 'a report',
  post: 'a post',
  comment: 'a comment',
  photo: 'a photo',
  user: 'an account',
  waterbody: 'a body',
  contentFlag: 'a flag',
  hazard: 'a hazard',
  bodyFeature: 'a known feature',
  waterBodySubArea: 'a sub-area',
  hazardRecurrence: 'a recurring hazard',
  putIn: 'a put-in',
  parkingArea: 'a lot',
  accessAlert: 'an access alert',
  waterBodyRequest: 'a request',
  bodyLandmark: 'a landmark',
  corpusPlaceName: 'a place name',
};

/** `{t}` is the target's words; a verb with no `{t}` names its subject itself. */
const VERB: Record<AuditAction, string> = {
  hide: 'Hid {t}',
  remove: 'Removed {t}',
  restore: 'Restored {t}',
  author_delete: 'Author deleted {t}',
  ban: 'Banned an account',
  suspend: 'Suspended an account',
  unban: 'Lifted a ban or suspension',
  merge_waterbody: 'Merged a body into another',
  approve_waterbody: 'Approved a drawn body',
  reject_waterbody: 'Rejected a drawn body',
  set_curated_boost: 'Set the curated boost',
  set_reference_links: 'Set the reference links',
  set_included_by_request: 'Changed whether a body is kept by request',
  set_standing: 'Set a body’s standing',
  activate_body: 'Activated a body',
  demote_body: 'Set a body dormant',
  approve_request: 'Approved a request',
  decline_request: 'Declined a request',
  set_put_in: 'Placed a put-in',
  resolve_flag: 'Actioned a flag',
  dismiss_flag: 'Dismissed a flag',
  grant_role: 'Granted a role',
  revoke_role: 'Revoked a role',
  grant_ledger_editor: 'Gave ledger editing',
  revoke_ledger_editor: 'Took ledger editing',
  set_posting_permission: 'Changed posting rights',
  promote_body_feature: 'Promoted a hazard to a known feature',
  demote_body_feature: 'Demoted a known feature',
  merge_hazards: 'Merged hazards',
  unmerge_hazards: 'Unmerged hazards',
  dismiss_duplicate: 'Said two bodies are distinct',
  suppress_recurrence: 'Suppressed a recurring hazard',
  unsuppress_recurrence: 'Brought back a recurring hazard',
  promote_recurrence: 'Promoted a recurring hazard to a known feature',
  set_weather_sample_points: 'Set the weather sample points',
  set_lake_depth: 'Set the depth',
  create_sub_area: 'Drew a sub-area',
  redraw_sub_area: 'Redrew a sub-area',
  rename_sub_area: 'Renamed a sub-area',
  set_water_body_name: 'Renamed a body',
  set_parking_area: 'Set a lot',
  set_approach_kind: 'Set an approach',
  pin_access_alert: 'Pinned an access alert',
  unpin_access_alert: 'Unpinned an access alert',
  retract_access_alert: 'Retracted an access alert',
  set_posted_access: 'Set the posted rules',
  set_satellite_imagery: 'Set the satellite link',
  set_public_access: 'Ruled on public access',
  create_landmark: 'Added a landmark',
  edit_landmark: 'Edited a landmark',
  promote_landmark: 'Promoted a landmark',
};

/** The row's sentence: "Hid a report", "Approved a request". */
export function actionLabel(action: AuditAction, targetType: AuditTarget): string {
  return VERB[action].replace('{t}', TARGET[targetType]);
}
