import { useSignUp } from '@clerk/tanstack-react-start';
import { type ReactElement, useMemo } from 'react';
import { classifyClerkError, failed, OK } from './authFlow';
import { type AuthCodeClient, CodeFlow } from './CodeFlow';
import { finishSession } from './clerkSession';

/**
 * Sign up (8.4), on Clerk's `useSignUp`: the same two steps as signing in. It creates the Clerk
 * account only; the profile fields and the blocking gates (16+, D41; the acknowledgment, D45) come
 * right after on onboarding, where they go to the enforced `upsertFromClerk`.
 *
 * **It can only finish if the Clerk instance doesn't require a password at sign-up.** With `password`
 * required, the code verifies and the attempt stops at `missing_requirements`. That reads as
 * `incomplete`, an honest dead end, rather than by inventing a password nobody asked for.
 */
export function SignUpFlow({ otherLink }: { otherLink: ReactElement }) {
  const { signUp } = useSignUp();

  const client = useMemo<AuthCodeClient>(
    () => ({
      sendCode: async (emailAddress) => {
        const created = await signUp.create({ emailAddress });
        if (created.error) return failed(classifyClerkError(created.error));
        const { error } = await signUp.verifications.sendEmailCode();
        return error ? failed(classifyClerkError(error)) : OK;
      },
      resendCode: async () => {
        const { error } = await signUp.verifications.sendEmailCode();
        return error ? failed(classifyClerkError(error)) : OK;
      },
      verifyCode: async (code) => {
        const { error } = await signUp.verifications.verifyEmailCode({ code });
        if (error) return failed(classifyClerkError(error));
        return signUp.status === 'complete' ? finishSession(signUp) : failed('incomplete');
      },
      reset: () => signUp.reset(),
    }),
    [signUp],
  );

  return <CodeFlow mode="sign-up" client={client} otherLink={otherLink} />;
}
