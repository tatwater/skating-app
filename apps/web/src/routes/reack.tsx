import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { type FormEvent, useState } from 'react';
import { AuthCard } from '../components/AuthCard';
import { RiskAckConsent } from '../components/RiskAckConsent';
import { Button } from '../components/ui/button';
import { RISK_ACK_VERSION } from '../lib/riskAck';

/**
 * Re-acceptance gate (D45). Reached when a signed-in user already has a profile but its
 * recorded acknowledgment is missing or stale — e.g. after we bump `RISK_ACK_VERSION`.
 * Unlike onboarding, it asks for nothing but renewed consent: existing profile fields are
 * untouched. On success the reactive `profiles.current` query flips and the `AuthGate`
 * routes to the app.
 */
export const Route = createFileRoute('/reack')({ component: ReAckPage });

function ReAckPage() {
  const { signOut } = useAuth();
  const acceptCurrentRiskAck = useMutation(api.profiles.acceptCurrentRiskAck);

  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAccept(e: FormEvent) {
    e.preventDefault();
    if (busy || !ack) return;
    setBusy(true);
    setError(null);
    try {
      await acceptCurrentRiskAck({ riskAckVersion: RISK_ACK_VERSION });
      // Success: no navigation — the AuthGate reacts to the refreshed acknowledgment.
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : err instanceof Error
            ? err.message
            : 'Could not save your acknowledgment',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="One quick thing">
      <p className="text-foreground-muted text-sm">
        We've updated our safety acknowledgment. Please review and accept it to keep using Skating —
        nothing else about your account changes.
      </p>
      <form onSubmit={onAccept} className="flex flex-col gap-3">
        <RiskAckConsent checked={ack} onToggle={() => setAck((v) => !v)} />
        {error ? <p className="text-danger text-sm">{error}</p> : null}
        <Button type="submit" disabled={busy || !ack}>
          {busy ? 'Saving…' : 'Accept and continue'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => signOut()}>
          Not now — sign out
        </Button>
      </form>
    </AuthCard>
  );
}
