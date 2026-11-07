import { useState } from 'react';
import { Button } from '../../kit/button';
import { RiskAck } from './RiskAck';
import { FormLine, SystemCard, SystemCardHead } from './SystemStage';

/**
 * One quick thing (8.8, D45): a signed-in person whose recorded acknowledgment is missing or stale.
 * It asks for nothing but renewed consent; `onAccept` resolves to what to say if it failed, or `null`
 * when it went through, and `AuthGate` moves on.
 */
export function ReackForm({
  onAccept,
  onSignOut,
}: {
  onAccept: () => Promise<string | null>;
  onSignOut: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function accept() {
    if (busy || !ack) return;
    setBusy(true);
    setMessage(null);
    const refusal = await onAccept();
    if (refusal === null) return;
    setBusy(false);
    setMessage(refusal);
  }

  return (
    <SystemCard>
      <SystemCardHead kicker="Safety acknowledgment" title="One quick thing">
        We’ve updated our safety acknowledgment. Please review and accept it to keep using Gli —
        nothing else about your account changes.
      </SystemCardHead>
      <form
        noValidate
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void accept();
        }}
      >
        <RiskAck checked={ack} onCheckedChange={setAck} />
        {message && <FormLine>{message}</FormLine>}
        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={!ack}
            loading={busy}
            className="h-[2.625rem] w-full"
          >
            Accept and continue
          </Button>
          <Button className="h-[2.625rem] w-full" onClick={onSignOut}>
            Not now — sign out
          </Button>
        </div>
      </form>
    </SystemCard>
  );
}
