/**
 * Interim assumption-of-risk acknowledgment (D45). Recorded at signup with a version
 * so we can re-prompt if the wording changes. Stashed in Clerk `unsafeMetadata` at
 * sign-up; the Convex `profiles.upsertFromClerk` bridge persists it onto the profile
 * (`riskAckVersion` / `riskAckAt`). Full legal wording remains Q10.
 */
export const RISK_ACK_VERSION = '2026-07-11'

export const RISK_ACK_COPY =
  'Reports in this app are peers’ observations at a specific time and place — never a ' +
  'guarantee that ice is safe. Weather changes ice fast. You alone decide whether to ' +
  'step onto any ice, and you assume the risk of doing so.'
