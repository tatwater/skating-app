/**
 * Assumption-of-risk acknowledgment versioning (D45).
 *
 * Single-sourced here so the apps (which collect the acknowledgment) and the Convex
 * backend (which requires + records it) agree on what "current" means. Bump this string
 * when the risk/terms wording materially changes — the backend then rejects profiles
 * carrying an older acknowledgment, so users are re-prompted.
 *
 * The presentational copy shown to the user lives with each surface's UI, not here.
 */
export const RISK_ACK_VERSION = '2026-07-11';

/** Whether a recorded acknowledgment version is the one we currently require. */
export function isCurrentRiskAckVersion(version: string | undefined | null): boolean {
  return version === RISK_ACK_VERSION;
}
