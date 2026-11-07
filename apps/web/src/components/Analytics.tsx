import { PostHogProvider } from '@posthog/react';
import type { ReactNode } from 'react';
import { env, isConfigured } from '../lib/env';
import { posthogOptions } from '../lib/posthogOptions';

/**
 * Product analytics (D29's "later" half, wired in D235).
 *
 * `PostHogProvider` initializes the SDK inside an effect, so it is inert during SSR and this can
 * sit in the root document without a `typeof window` dance. The options — including the
 * session-replay lock that L12 still gates — are in `lib/posthogOptions.ts`, where a test reads
 * them.
 *
 * **Unconfigured means absent, not broken.** With no token the provider is skipped entirely: no
 * init, no network, and `useAnalytics`/`useFeatureFlag` degrade to a no-op and their fallbacks.
 * That is the same posture `lib/env.ts` takes for the basemap and the imagery archive, and the
 * reason this does not throw the way the generated version did — a missing analytics key is not a
 * reason for a skater to get a blank page, and on a field app it is not a reason to break the dev
 * server either.
 */
export function AnalyticsProvider({ children }: { children: ReactNode }) {
  if (!isConfigured.posthog) return children;

  return (
    <PostHogProvider apiKey={env.posthogKey} options={posthogOptions}>
      {children}
    </PostHogProvider>
  );
}
