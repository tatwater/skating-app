import { api } from '@skating/convex/api';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { ReackForm } from '../components/skater/auth/ReackForm';
import { SystemStage } from '../components/skater/auth/SystemStage';
import { RISK_ACK_VERSION } from '../lib/riskAck';
import { useSignOut } from '../lib/sheetOwner';

/**
 * Re-acceptance gate (D45). Reached when a signed-in user already has a profile but its recorded
 * acknowledgment is missing or stale — e.g. after we bump `RISK_ACK_VERSION`. Existing profile
 * fields are untouched. On success the reactive `profiles.current` query flips and the `AuthGate`
 * routes to the app.
 */
export const Route = createFileRoute('/reack')({ component: ReAckPage });

function ReAckPage() {
  const signOut = useSignOut();
  const acceptCurrentRiskAck = useMutation(api.profiles.acceptCurrentRiskAck);

  return (
    <SystemStage>
      <ReackForm
        onSignOut={() => void signOut()}
        onAccept={async () => {
          try {
            await acceptCurrentRiskAck({ riskAckVersion: RISK_ACK_VERSION });
            return null;
          } catch (error) {
            return error instanceof ConvexError
              ? String(error.data)
              : 'Could not save your acknowledgment';
          }
        }}
      />
    </SystemStage>
  );
}
