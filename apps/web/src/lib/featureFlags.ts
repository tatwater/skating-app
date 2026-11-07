import { usePostHog } from '@posthog/react';
import { useEffect, useState } from 'react';
import { isConfigured } from './env';

/**
 * The feature-flag harness (D235), carrying its first registered keys since B03 (D240).
 *
 * ## Why it started empty
 *
 * `backlog/posthog.md` said flags would replace the two things that currently ship dark behind
 * constants. Neither survived being looked at, and both reasons are worth keeping written down
 * because they will come up again for the next candidate:
 *
 * - **`RECURRENCE_ADVISORIES_PUBLIC`** is read only inside Convex, where `isPubliclyVisible()`
 *   stamps `publiclyVisible` onto the row *at write time* — which its own doc explains is
 *   deliberate, because "a client-side filter is admin-only if you don't open the network tab". A
 *   browser flag cannot reach a server-side trust boundary, and moving the decision to the client
 *   to make it flaggable would be the exact regression that comment exists to prevent. (Convex
 *   queries cannot make network calls at all, so even a server-side SDK would need an action; and
 *   because the value is baked onto rows, flipping anything would need a backfill to be visible.)
 * - **`PROFILE_REVEAL_ALL`** is client-side and could technically move, but its real protection is
 *   `profileRevealEnabled()` forcing it off against the production deployment — "a flag whose only
 *   protection is remember to turn it off is a flag that ships on". A remote value is strictly
 *   weaker than a compile-time guard, and mobile reads the same constant, so flagging the web half
 *   would leave one rule with two answers.
 *
 * So the capability lands and the constants stay constants. A flag belongs here when it is
 * genuinely client-side, genuinely wants flipping without a redeploy, and guards nothing a skater's
 * safety rests on (D3) — the last of which is why neither of the above qualified.
 *
 * ## Registering one
 *
 * Add its key to {@link FEATURE_FLAGS}, create the flag in PostHog under the same key, and read it
 * with {@link useFeatureFlag} and an explicit fallback. The fallback is the value the app uses
 * before flags load and whenever PostHog is unreachable or unconfigured, so it must be the *safe*
 * side of the switch, never the exciting one.
 *
 * ## The B03 keys (D240)
 *
 * The first real registrations: the Latest features that wait on new server scope, and GPX
 * import. Each is genuinely client-side, wants flipping without a redeploy while its server half
 * settles, and guards a convenience, never anything a skater's safety rests on (D3). A flag
 * renders its fallback first and updates on load, so none of these may ever guard the shell
 * layout or anything above the fold.
 */
export const FEATURE_FLAGS = ['latest-text-search', 'latest-skater-filter', 'gpx-import'] as const;

/** A registered flag key — the only strings {@link useFeatureFlag} accepts (D240). */
export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number];

/**
 * Read a PostHog feature flag, with an explicit fallback for every state where there is no answer.
 *
 * Returns `fallback` when no token is configured (tests, and any deployment without one), while
 * flags are still in flight on first load, and if the flag does not exist in PostHog. A flag is
 * therefore never `undefined` to a caller, which keeps the "flash of the wrong variant" that a
 * tri-state would cause out of the call sites.
 *
 * Deliberately not `@posthog/react`'s own `useFeatureFlagEnabled`: outside a provider `usePostHog`
 * falls back to the uninitialized `posthog-js` singleton, and that hook subscribes to it
 * immediately — which logs an SDK error per mount in exactly the keyless case this wrapper exists
 * to make quiet.
 */
export function useFeatureFlag(flag: FeatureFlagKey, fallback: boolean): boolean {
  const posthog = usePostHog();
  const [enabled, setEnabled] = useState(fallback);

  useEffect(() => {
    if (!isConfigured.posthog) {
      // Keep following the caller's fallback rather than freezing on whatever it was at mount:
      // the fallback is the safe side of the switch, and a caller that recomputes which side that
      // is must not be ignored just because there is no PostHog to ask.
      setEnabled(fallback);
      return;
    }

    const read = () => setEnabled(posthog.isFeatureEnabled(flag) ?? fallback);
    read();
    return posthog.onFeatureFlags(read);
  }, [fallback, flag, posthog]);

  return enabled;
}
