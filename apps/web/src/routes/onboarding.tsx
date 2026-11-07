import { useUser } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { OnboardingForm } from '../components/skater/auth/OnboardingForm';
import { classifyUpsertError } from '../components/skater/auth/onboarding';
import { SystemStage } from '../components/skater/auth/SystemStage';
import { useAnalytics } from '../lib/analytics';
import { RISK_ACK_VERSION } from '../lib/riskAck';
import { useSignOut } from '../lib/sheetOwner';

/**
 * Profile provisioning (D26). Reached only when the user is Clerk-authenticated but has no
 * Convex `profiles` row yet (see `AuthGate`). It collects the profile fields and the blocking gates
 * — the 16+ age gate (D41) and the assumption-of-risk acknowledgment (D45) — then calls
 * `upsertFromClerk`, which *re-enforces* all of it server-side (D37). DOB + ack go straight to the
 * enforced mutation, never staged in Clerk `unsafeMetadata`. On success the reactive
 * `profiles.current` query flips and the `AuthGate` routes to the app.
 */
export const Route = createFileRoute('/onboarding')({ component: OnboardingPage });

function OnboardingPage() {
  const analytics = useAnalytics();
  const { user } = useUser();
  const signOut = useSignOut();
  const upsertFromClerk = useMutation(api.profiles.upsertFromClerk);

  return (
    <SystemStage>
      <OnboardingForm
        email={user?.primaryEmailAddress?.emailAddress ?? null}
        onSignOut={() => void signOut()}
        onSubmit={async (values) => {
          try {
            await upsertFromClerk({
              ...values,
              riskAckVersion: RISK_ACK_VERSION,
              // The acceptance time is stamped server-side (trust boundary, D37) — not sent.
            });
            analytics.capture('onboarding_completed');
            return null;
          } catch (error) {
            return classifyUpsertError(error);
          }
        }}
      />
    </SystemStage>
  );
}
