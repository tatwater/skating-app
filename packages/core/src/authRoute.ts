import { needsProfileSetup } from './profile';
import { isCurrentRiskAckVersion } from './riskAck';

/**
 * Which top-level navigation surface a signed-in-or-not user should see (D26/D45). Pure so
 * each app's root gating is unit-testable without a render harness — and shared (D7) so
 * mobile (Expo Router) and web (TanStack Router) resolve the *same* four states from the
 * same inputs, differing only in how they render each one.
 *
 *  - `loading`    — Clerk not ready yet, or (signed in) the profile query still resolving;
 *                   render a blank frame so we don't flash sign-in or bounce to onboarding.
 *  - `auth`       — signed out.
 *  - `onboarding` — signed in but no profile row yet: collect fields + first consent. Also the
 *                   landing spot for a **cancelled deletion** (D62 amendment): the row survived but
 *                   its identity was really scrubbed at request time and cancelling does not restore
 *                   it, so the account has to be introduced again before it can be used. Being sent
 *                   here is the honest version of "you'll have to re-add all of it" — the gentler
 *                   alternative is an account with no name posting under "Deleted skater".
 *  - `reack`      — signed in, profile exists, but its acknowledgment is missing/stale
 *                   (e.g. after a `RISK_ACK_VERSION` bump): renew consent only.
 *  - `app`        — signed in and the profile records the current acknowledgment.
 */
export type AuthRoute = 'loading' | 'auth' | 'onboarding' | 'reack' | 'app';

export function resolveAuthRoute({
  isLoaded,
  isSignedIn,
  profile,
}: {
  isLoaded: boolean;
  // Clerk reports `isSignedIn` as `undefined` until `isLoaded` — treated as not-signed-in,
  // though the `!isLoaded` guard fires first in that window anyway.
  isSignedIn: boolean | undefined;
  // `undefined` = query still resolving; `null` = signed-in but not provisioned.
  profile:
    | { riskAckVersion?: string | null; displayName?: string; deletionRequestedAt?: number }
    | null
    | undefined;
}): AuthRoute {
  if (!isLoaded) return 'loading';
  if (!isSignedIn) return 'auth';
  if (profile === undefined) return 'loading';
  if (profile === null) return 'onboarding';
  // A row that exists but was emptied by a deletion the user then cancelled. Checked before the
  // ack gate because an account with no name is less usable than one with a stale acknowledgment,
  // and onboarding re-collects the acknowledgment on its way through anyway.
  if (needsProfileSetup(profile)) return 'onboarding';
  return isCurrentRiskAckVersion(profile.riskAckVersion) ? 'app' : 'reack';
}
