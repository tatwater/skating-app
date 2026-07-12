/**
 * Interim assumption-of-risk acknowledgment (D45). The version is single-sourced in
 * `@skating/core` so the app and the Convex backend agree on what "current" means; the
 * backend now *requires* a current acknowledgment in `upsertFromClerk` (the trust
 * boundary, D37). Full legal wording remains Q10.
 *
 * The onboarding screen collects the acknowledgment and passes it — with the DOB — to
 * `upsertFromClerk`, which records it on the `profiles` row and rejects anything but the
 * current version. It is never staged in Clerk `unsafeMetadata`. The copy below is the
 * presentational wording shown at that point.
 */
export { RISK_ACK_VERSION } from '@skating/core'

export const RISK_ACK_COPY =
  'Reports in this app are peers’ observations at a specific time and place — never a ' +
  'guarantee that ice is safe. Weather changes ice fast. You alone decide whether to ' +
  'step onto any ice, and you assume the risk of doing so.'
