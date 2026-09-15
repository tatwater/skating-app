import { useUser } from '@clerk/tanstack-react-start';
import {
  beginEmailChange,
  completeEmailChange,
  type EmailAddressLike,
  isVerifiedEmail,
  type OldEmailOutcome,
  removeOldEmail,
  type UserLike,
} from '@skating/core';
import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

/**
 * Change the email on the account (N8 post-merge). Clerk owns the address (D26); the sequence is
 * `@skating/core`'s `changeEmail` — add, code, verify, make primary, release the old one — and this
 * is the form around it. The server learns through Clerk's webhook, not from us.
 *
 * Split like `ProfileEdit`: `ChangeEmailView` is the form given its state and callbacks (what the
 * tests render), `ChangeEmail` wires it to Clerk's `useUser()`.
 */

export type ChangeEmailStep = 'idle' | 'enter' | 'code' | 'done';

export interface ChangeEmailViewProps {
  currentEmail: string | null;
  step: ChangeEmailStep;
  /** The address the code went to, once `step === 'code'` or `'done'`. */
  pendingEmail: string | null;
  busy: boolean;
  error: string | null;
  /** What became of the previous address, once `step === 'done'`. */
  old: OldEmailOutcome | null;
  onStart: () => void;
  /** Back to the resting row — from a cancelled step or from the confirmation. */
  onCancel: () => void;
  onSendCode: (email: string) => void;
  onVerify: (code: string) => void;
  /** Try again to remove the old address, after a `remove_failed`. */
  onRetryRemove: () => void;
}

/**
 * The form. Its two text fields are local state, and they belong to *one run* of the sequence:
 * the wiring below remounts this component whenever the step returns to `idle`, so a cancelled
 * attempt's address — or a wrong code from the last try — never greets the next one.
 */
export function ChangeEmailView(props: ChangeEmailViewProps) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  if (props.step === 'idle') {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-foreground-muted">{props.currentEmail ?? 'No email on this account'}</p>
        <Button variant="outline" size="sm" onClick={props.onStart}>
          Change email
        </Button>
      </div>
    );
  }

  if (props.step === 'done') {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-foreground">Your email is now {props.pendingEmail}.</p>
        {props.old?.kind === 'kept_linked' ? (
          <p className="text-foreground-muted text-sm">
            Your old address stays on the account because it’s linked to your {props.old.provider}{' '}
            sign-in; it won’t receive notifications.
          </p>
        ) : null}
        {props.old?.kind === 'remove_failed' ? (
          <p className="text-destructive text-sm">
            We couldn’t remove your old address ({props.old.message}). It’s still on your account as
            a secondary and won’t receive notifications — you can try removing it again.
          </p>
        ) : null}
        <p className="text-foreground-muted text-sm">
          Notification emails go to the new address from here on.
        </p>
        <div className="flex gap-2">
          {props.old?.kind === 'remove_failed' ? (
            <Button size="sm" onClick={props.onRetryRemove} disabled={props.busy}>
              {props.busy ? 'Removing…' : 'Remove old address'}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={props.onCancel} disabled={props.busy}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (props.step === 'code') {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          props.onVerify(code);
        }}
      >
        <p className="text-foreground-muted text-sm">
          Enter the code we emailed to <span className="text-foreground">{props.pendingEmail}</span>
          .
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="change-email-code">Verification code</Label>
          <Input
            id="change-email-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </div>
        {props.error ? <p className="text-destructive text-sm">{props.error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={props.busy || code.trim().length === 0}>
            {props.busy ? 'Verifying…' : 'Verify'}
          </Button>
          <Button type="button" variant="ghost" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSendCode(email);
      }}
    >
      <p className="text-foreground-muted text-sm">
        We’ll email a code to the new address to confirm it’s yours. Sign-in codes and notification
        emails go there afterwards.
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="change-email-new">New email</Label>
        <Input
          id="change-email-new"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>
      {props.error ? <p className="text-destructive text-sm">{props.error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={props.busy || email.trim().length === 0}>
          {props.busy ? 'Sending…' : 'Email me a code'}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The hook-wired half: Clerk's `UserResource` satisfies core's structural `UserLike` unchanged. */
export function ChangeEmail() {
  const { user } = useUser();
  const [step, setStep] = useState<ChangeEmailStep>('idle');
  const [pending, setPending] = useState<EmailAddressLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [old, setOld] = useState<OldEmailOutcome | null>(null);
  // The previous address, kept for the retry when removing it failed.
  const [previous, setPrevious] = useState<EmailAddressLike | null>(null);

  const reset = () => {
    setStep('idle');
    setPending(null);
    setPrevious(null);
    setError(null);
    setOld(null);
  };

  /** The make-primary half, shared by the code step and the no-code path for a verified address. */
  const finish = async (u: UserLike, address: EmailAddressLike, code: string) => {
    const wasPrimary = u.primaryEmailAddress;
    const result = await completeEmailChange(u, address, code);
    setPrevious(wasPrimary);
    setOld(result.old);
    setStep('done');
  };

  return (
    <ChangeEmailView
      // A fresh form per run — see `ChangeEmailView`.
      key={step === 'idle' ? 'idle' : 'run'}
      currentEmail={user?.primaryEmailAddress?.emailAddress ?? null}
      step={step}
      pendingEmail={pending?.emailAddress ?? null}
      busy={busy}
      error={error}
      old={old}
      onStart={() => setStep('enter')}
      onCancel={reset}
      onSendCode={async (email) => {
        if (!user || busy) return;
        setBusy(true);
        setError(null);
        try {
          const address = await beginEmailChange(user, email);
          setPending(address);
          // An address Clerk already holds verified (a Google-linked one that stayed) has no code
          // to enter; it goes straight to primary.
          if (isVerifiedEmail(address)) await finish(user, address, '');
          else setStep('code');
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not send a code');
        } finally {
          setBusy(false);
        }
      }}
      onVerify={async (code) => {
        if (!user || !pending || busy) return;
        setBusy(true);
        setError(null);
        try {
          await finish(user, pending, code);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Verification failed');
        } finally {
          setBusy(false);
        }
      }}
      onRetryRemove={async () => {
        if (!previous || busy) return;
        setBusy(true);
        try {
          setOld(await removeOldEmail(previous));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
