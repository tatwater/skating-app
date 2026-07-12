/**
 * Interim assumption-of-risk acknowledgment (D45). The version is single-sourced in
 * `@skating/core` so the apps and the Convex backend agree on what "current" means; the
 * backend *requires* a current acknowledgment in `upsertFromClerk` (the trust boundary,
 * D37). The onboarding page collects it and passes it — with the DOB — to that mutation.
 *
 * The copy below is presentational and deliberately lives per-surface (mirroring mobile),
 * not in `@skating/core`.
 */
export { RISK_ACK_VERSION } from '@skating/core'

export const RISK_ACK_COPY =
  'Reports in this app are peers’ observations at a specific time and place — never a ' +
  'guarantee that ice is safe. Weather changes ice fast. You alone decide whether to ' +
  'step onto any ice, and you assume the risk of doing so.'
