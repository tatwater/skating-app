/**
 * Interim assumption-of-risk acknowledgment (D45). The version is single-sourced in
 * `@skating/core` so the app and the Convex backend agree on what "current" means; the
 * backend now *requires* a current acknowledgment in `upsertFromClerk` (the trust
 * boundary, D37). Full legal wording remains Q10.
 *
 * NOTE (still to come — auth-provisioning PR): signup currently only stages the DOB +
 * acknowledgment in Clerk `unsafeMetadata`; the client does not yet *call*
 * `upsertFromClerk`, so no profile (and no recorded acceptance) exists until that wiring
 * lands. The server contract is ready and safe — it will reject any provisioning attempt
 * that omits a current acknowledgment — so the gap is purely the client wiring + the
 * username/displayName collection UI. Tracked in `plans/` (D45 / roadmap Phase 0).
 */
export { RISK_ACK_VERSION } from '@skating/core'

export const RISK_ACK_COPY =
  'Reports in this app are peers’ observations at a specific time and place — never a ' +
  'guarantee that ice is safe. Weather changes ice fast. You alone decide whether to ' +
  'step onto any ice, and you assume the risk of doing so.'
