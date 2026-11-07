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

import type { ChangeEmailStep, ChangeEmailViewProps } from './ChangeEmail';

/** Clerk's message, or ours when it has none worth showing. Never echoes the address. */
function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The flow's state and Clerk's calls. `user` is Clerk's `UserResource`, which satisfies core's
 * structural `UserLike` unchanged.
 */
export function useChangeEmail(): {
  currentEmail: string | null;
  step: ChangeEmailStep;
  view: Omit<ChangeEmailViewProps, 'step'>;
  start: () => void;
} {
  const { user } = useUser();
  const [step, setStep] = useState<ChangeEmailStep>('idle');
  const [pending, setPending] = useState<EmailAddressLike | null>(null);
  const [previous, setPrevious] = useState<EmailAddressLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [old, setOld] = useState<OldEmailOutcome | null>(null);

  const reset = () => {
    setStep('idle');
    setPending(null);
    setPrevious(null);
    setError(null);
    setOld(null);
  };

  const finish = async (u: UserLike, address: EmailAddressLike, code: string) => {
    const wasPrimary = u.primaryEmailAddress;
    const result = await completeEmailChange(u, address, code);
    setPrevious(wasPrimary);
    setOld(result.old);
    setStep('done');
  };

  const guard = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  return {
    currentEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    step,
    start: () => setStep('enter'),
    view: {
      pendingEmail: pending?.emailAddress ?? null,
      busy,
      error,
      old,
      onCancel: reset,
      onSendCode: (email) =>
        void guard(async () => {
          if (!user) return;
          const address = await beginEmailChange(user, email);
          setPending(address);
          // An address Clerk already holds verified has no code to enter.
          if (isVerifiedEmail(address)) await finish(user, address, '');
          else setStep('code');
        }, 'We couldn’t send a code to that address.'),
      onResend: () =>
        void guard(async () => {
          await pending?.prepareVerification({ strategy: 'email_code' });
        }, 'We couldn’t send a new code.'),
      onVerify: (code) =>
        void guard(async () => {
          if (!user || !pending) return;
          await finish(user, pending, code);
        }, 'That code didn’t work.'),
      onRetryRemove: () =>
        void guard(async () => {
          if (previous) setOld(await removeOldEmail(previous));
        }, 'We couldn’t remove the old address.'),
    },
  };
}
