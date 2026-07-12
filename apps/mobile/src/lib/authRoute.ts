import { isCurrentRiskAckVersion } from '@skating/core'

/**
 * Which top-level navigation surface a user should see. Pure so the root navigator's
 * gating (D26/D45) is unit-testable without an Expo Router / React render harness.
 *
 *  - `loading`    — Clerk not ready yet, or (signed in) the profile query still resolving;
 *                   render a blank frame so we don't flash sign-in or bounce to onboarding.
 *  - `auth`       — signed out.
 *  - `onboarding` — signed in but no profile row yet: collect fields + first consent.
 *  - `reack`      — signed in, profile exists, but its acknowledgment is missing/stale
 *                   (e.g. after a `RISK_ACK_VERSION` bump): renew consent only.
 *  - `app`        — signed in and the profile records the current acknowledgment.
 */
export type AuthRoute = 'loading' | 'auth' | 'onboarding' | 'reack' | 'app'

export function resolveAuthRoute({
  isLoaded,
  isSignedIn,
  profile,
}: {
  isLoaded: boolean
  // Clerk reports `isSignedIn` as `undefined` until `isLoaded` — treated as not-signed-in,
  // though the `!isLoaded` guard fires first in that window anyway.
  isSignedIn: boolean | undefined
  // `undefined` = query still resolving; `null` = signed-in but not provisioned.
  profile: { riskAckVersion?: string | null } | null | undefined
}): AuthRoute {
  if (!isLoaded) return 'loading'
  if (!isSignedIn) return 'auth'
  if (profile === undefined) return 'loading'
  if (profile === null) return 'onboarding'
  return isCurrentRiskAckVersion(profile.riskAckVersion) ? 'app' : 'reack'
}
