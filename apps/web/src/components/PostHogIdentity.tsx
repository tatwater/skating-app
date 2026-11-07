import { useAuth } from '@clerk/tanstack-react-start';
import { usePostHog } from '@posthog/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { isConfigured } from '../lib/env';

/**
 * Binds PostHog's distinct id to Clerk's user id once auth has settled (D235).
 *
 * ## What it sends, and what it refuses to
 *
 * **The Clerk `userId` and nothing else.** No email, no display name, no person properties at all.
 * The founder's call, and the reasoning is the shape of this app rather than a general preference:
 * the population includes 16- and 17-year-olds (D41 sets the floor at 16), this is a *location*
 * app, and the minor-data posture is one of the things still waiting on the legal pass (Q10). PII
 * in a third-party processor under those conditions is a commitment, not a convenience — and it
 * buys very little, because `/admin` already resolves a `userId` to a person, so every analysis
 * that wants a name can get one without PostHog ever holding it. It also keeps account deletion
 * honest: there is nothing in PostHog that a deletion would have to reach in and erase.
 *
 * ## Why the identity has to be managed rather than left alone
 *
 * PostHog assigns an anonymous id at init and keeps it until told otherwise, so without this a
 * returning user is a new person every session and no retention or funnel figure means anything.
 * The two resets matter as much as the identify: on **sign-out**, so a shared device does not
 * attribute the next person's session to the previous account, and on an **account switch**, so
 * the second account does not inherit the first's history through an alias. Neither is reachable
 * by identifying alone.
 *
 * Sits inside `AppProviders` because it needs Clerk, and renders its children untouched.
 */
export function PostHogIdentity({ children }: { children: ReactNode }) {
  const posthog = usePostHog();
  const { isLoaded, isSignedIn, userId } = useAuth();
  /**
   * The id PostHog was last told about, which is not the same question as "who is signed in".
   * Without it, a re-render re-sends `identify` for an unchanged user, and — more importantly —
   * a signed-out visitor who was never identified would be `reset` on every mount, throwing away
   * the anonymous id that ties their pre-sign-up pageviews to the onboarding funnel they are in
   * the middle of.
   */
  const identified = useRef<string | null>(null);

  useEffect(() => {
    // `isLoaded` false means Clerk has not resolved yet, which is indistinguishable from signed
    // out if we acted on it — and acting on it would reset a perfectly good identity on every
    // page load.
    if (!isConfigured.posthog || !isLoaded) return;

    if (!isSignedIn || !userId) {
      if (identified.current !== null) {
        posthog.reset();
        identified.current = null;
      }
      return;
    }

    if (identified.current === userId) return;

    // An account switch in the same browser: drop the first account's identity before claiming
    // the second, or PostHog aliases them into one person.
    if (identified.current !== null) posthog.reset();

    posthog.identify(userId);
    identified.current = userId;
  }, [isLoaded, isSignedIn, posthog, userId]);

  return <>{children}</>;
}
