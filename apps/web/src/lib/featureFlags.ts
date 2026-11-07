import { usePostHog } from '@posthog/react';
import { useEffect, useState } from 'react';
import { isConfigured } from './env';

/**
 * The feature-flag harness (D235) — plumbing, with nothing plumbed into it yet, on purpose.
 *
 * ## Why this is empty
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
 */
export const FEATURE_FLAGS: readonly string[] = [];

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
export function useFeatureFlag(flag: string, fallback: boolean): boolean {
  const posthog = usePostHog();
  const [enabled, setEnabled] = useState(fallback);

  useEffect(() => {
    if (!isConfigured.posthog) return;

    const read = () => setEnabled(posthog.isFeatureEnabled(flag) ?? fallback);
    read();
    return posthog.onFeatureFlags(read);
  }, [fallback, flag, posthog]);

  return enabled;
}
