import { useSignIn } from '@clerk/tanstack-react-start';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { CellLoader } from '../../kit/meter';
import {
  type AuthFailure,
  type AuthOutcome,
  classifyClerkError,
  failed,
  OK,
  ticketFromSearch,
  withoutTicket,
} from './authFlow';
import { type AuthCodeClient, CodeFlow } from './CodeFlow';
import { finishSession } from './clerkSession';
import { SystemCard } from './SystemStage';

/**
 * Sign in (8.1–8.3, 8.15), on Clerk's `useSignIn`. Email code only: the instance has password enabled
 * but not as a first factor, so a password can never complete a sign-in and nothing here offers one.
 *
 * **The headless test path keeps working.** `/sign-in?__clerk_ticket=<token>` is how Playwright gets a
 * session (`POST /v1/sign_in_tokens`, A06h's recipe). The prebuilt `<SignIn>` consumed that parameter
 * on its own, so replacing it means consuming it here. A ticket isn't a sign-in a person made, so it
 * fires no analytics.
 */
export function SignInFlow({ otherLink }: { otherLink: ReactElement }) {
  const { signIn } = useSignIn();

  const client = useMemo<AuthCodeClient>(() => {
    const whenVerified = async (error: unknown): Promise<AuthOutcome> => {
      if (error) return failed(classifyClerkError(error));
      return signIn.status === 'complete' ? finishSession(signIn) : failed('incomplete');
    };
    return {
      sendCode: async (emailAddress) => {
        const { error } = await signIn.emailCode.sendCode({ emailAddress });
        return error ? failed(classifyClerkError(error)) : OK;
      },
      resendCode: async () => {
        const { error } = await signIn.emailCode.sendCode();
        return error ? failed(classifyClerkError(error)) : OK;
      },
      verifyCode: async (code) => {
        const { error } = await signIn.emailCode.verifyCode({ code });
        return whenVerified(error);
      },
      reset: () => signIn.reset(),
    };
  }, [signIn]);

  // Read once: the flow mounts client-only, behind `AuthGate`'s loading state.
  const [ticket] = useState(() => ticketFromSearch(window.location.search));
  const [ticketFailure, setTicketFailure] = useState<AuthFailure | null>(null);
  const [ticketPending, setTicketPending] = useState(ticket !== null);
  // Tokens are single-use, and StrictMode runs an effect twice.
  const consumed = useRef(false);

  useEffect(() => {
    if (ticket === null || consumed.current) return;
    consumed.current = true;
    window.history.replaceState(window.history.state, '', withoutTicket(window.location));
    void (async () => {
      let outcome: AuthOutcome;
      try {
        const { error } = await signIn.ticket({ ticket });
        outcome =
          !error && signIn.status === 'complete' ? await finishSession(signIn) : failed('ticket');
      } catch {
        outcome = failed('ticket');
      }
      if (!outcome.ok) {
        setTicketFailure('ticket');
        setTicketPending(false);
      }
    })();
  }, [ticket, signIn]);

  if (ticketPending) {
    return (
      <SystemCard>
        <CellLoader label="Signing in" className="self-center" />
      </SystemCard>
    );
  }
  return (
    <CodeFlow mode="sign-in" client={client} otherLink={otherLink} initialFailure={ticketFailure} />
  );
}
