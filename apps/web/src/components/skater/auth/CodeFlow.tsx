import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useAnalytics } from '../../../lib/analytics';
import { Button } from '../../kit/button';
import { Input } from '../../kit/input';
import { AuthField, NEED_INPUT } from './AuthField';
import {
  type AuthFailure,
  type AuthOutcome,
  FAILURE_COPY,
  failed,
  failurePlace,
  formatCooldown,
  isPlausibleEmail,
  RESEND_COOLDOWN_S,
} from './authFlow';
import { CODE_LENGTH, CodeInput } from './CodeInput';
import { FormLine, SystemCard, SystemCardHead } from './SystemStage';

/** The two calls the flow makes of Clerk, reduced to what the screen needs. See `SignInFlow`. */
export interface AuthCodeClient {
  /** Starts an attempt for this address and sends its first code. */
  sendCode: (email: string) => Promise<AuthOutcome>;
  /** Sends another code for the attempt under way. */
  resendCode: () => Promise<AuthOutcome>;
  /** Checks the code; on success the session is active and `AuthGate` takes over. */
  verifyCode: (code: string) => Promise<AuthOutcome>;
  /** Forgets the attempt, for "Use a different email". */
  reset: () => Promise<unknown>;
}

const COPY = {
  'sign-in': {
    kicker: 'Sign in',
    title: 'Sign in to Gli',
    lede: 'We’ll email you a six-digit code. Gli doesn’t use passwords.',
    placeholder: undefined,
    verify: 'Sign in',
    other: 'New to Gli?',
  },
  'sign-up': {
    kicker: 'Create an account',
    title: 'Join Gli',
    lede: 'Start with your email. We’ll send a six-digit code to confirm it — Gli doesn’t use passwords.',
    placeholder: 'you@example.com',
    verify: 'Create account',
    other: 'Already have an account?',
  },
} as const;

/**
 * A thrown call becomes a generic failure here, in the one place every call passes through. Its
 * message goes nowhere: it could name the address, and an unhandled rejection would carry it to
 * Sentry's global handler.
 */
async function guarded(call: () => Promise<AuthOutcome>): Promise<AuthOutcome> {
  try {
    return await call();
  } catch {
    return failed('unreachable');
  }
}

/**
 * Email, then a six-digit code (8.1–8.4, 8.15). `client` is the only thing that differs between
 * signing in and signing up, so this holds the steps, the resend clock and the focus, and the Clerk
 * bindings beside it stay small enough to read. Holds both the address and the code in component
 * state only: never the URL, never a store, never an event.
 */
export function CodeFlow({
  mode,
  client,
  otherLink,
  initialFailure = null,
}: {
  mode: 'sign-in' | 'sign-up';
  client: AuthCodeClient;
  /** The kit link to the other flow, in the card's foot. */
  otherLink: ReactElement;
  /** Something that went wrong before this mounted (a sign-in link that didn't work). */
  initialFailure?: AuthFailure | null;
}) {
  const analytics = useAnalytics();
  const copy = COPY[mode];

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'resend' | 'verify' | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(initialFailure);
  // A code Clerk refused can't be tried again until it changes.
  const [refused, setRefused] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  // Focus moves after the render that follows: a refused code's slots are still disabled from the
  // check when the answer arrives, and the pressed button is about to be — so a focus taken in the
  // handler would land nowhere, and the page's body would be left holding it.
  const [focusTick, setFocusTick] = useState(0);
  const focusStep = () => setFocusTick((t) => t + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each step and each request to refocus
  useEffect(() => {
    if (emailRef.current) emailRef.current.focus();
    else codeRef.current?.querySelector<HTMLInputElement>('input[tabindex="0"]')?.focus();
  }, [step, focusTick]);

  const counting = cooldown > 0;
  useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [counting]);

  const trimmed = email.trim();
  const place = failure && failurePlace(failure);
  const canSend = busy === null && isPlausibleEmail(email);
  const canVerify = busy === null && code.length === CODE_LENGTH && code !== refused;
  const canResend = busy === null && cooldown === 0;

  async function onSend() {
    if (!canSend) return;
    setBusy('send');
    setFailure(null);
    const outcome = await guarded(() => client.sendCode(trimmed));
    setBusy(null);
    if (outcome.ok) {
      analytics.capture('sign_in_code_sent', { method: 'email_code' });
      setCode('');
      setRefused(null);
      setCooldown(RESEND_COOLDOWN_S);
      setStep('code');
    } else {
      setFailure(outcome.failure);
      focusStep();
    }
  }

  async function onVerify() {
    if (!canVerify) return;
    setBusy('verify');
    setFailure(null);
    const outcome = await guarded(() => client.verifyCode(code));
    if (outcome.ok) {
      analytics.capture('sign_in_completed', { method: 'email_code' });
      return; // stays busy: `AuthGate` is about to replace this screen
    }
    setBusy(null);
    setFailure(outcome.failure);
    setRefused(code);
    // The clock's job is to stop someone asking twice for a code that's on its way; a refused code
    // is the moment they need another (8.3 draws it live).
    setCooldown(0);
    focusStep();
  }

  async function onResend() {
    if (!canResend) return;
    setBusy('resend');
    setFailure(null);
    const outcome = await guarded(() => client.resendCode());
    setBusy(null);
    if (outcome.ok) {
      analytics.capture('sign_in_code_sent', { method: 'email_code' });
      setCode('');
      setRefused(null);
      setCooldown(RESEND_COOLDOWN_S);
    } else {
      setFailure(outcome.failure);
    }
    focusStep();
  }

  function onDifferentEmail() {
    setStep('email');
    setCode('');
    setRefused(null);
    setFailure(null);
    setCooldown(0);
    client.reset().catch(() => undefined);
  }

  const formLine = place === 'form' && failure && <FormLine>{FAILURE_COPY[failure]}</FormLine>;

  if (step === 'email') {
    return (
      <SystemCard
        foot={
          <>
            <span>{copy.other}</span>
            {otherLink}
          </>
        }
      >
        <SystemCardHead kicker={copy.kicker} step="1 / 2" title={copy.title}>
          {copy.lede}
        </SystemCardHead>
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <AuthField
            label="Email address"
            need={place === 'email' && failure ? FAILURE_COPY[failure] : null}
          >
            <Input
              ref={emailRef}
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={copy.placeholder}
              value={email}
              // Held while the code is on its way: an address changed now would be the one the code
              // screen names, while the code went to the one sent.
              disabled={busy === 'send'}
              onValueChange={(next) => {
                setEmail(next);
                setFailure(null);
              }}
              className={NEED_INPUT}
            />
          </AuthField>
          {formLine}
          {/* Clerk mounts its bot check here; a custom flow must offer the element (sign-up only). */}
          {mode === 'sign-up' && <div id="clerk-captcha" className="empty:hidden" />}
          <Button
            type="submit"
            variant="primary"
            disabled={!isPlausibleEmail(email) || busy === 'send'}
            loading={busy === 'send'}
            className="h-[2.625rem] w-full"
          >
            Email me a code
          </Button>
        </form>
      </SystemCard>
    );
  }

  return (
    <SystemCard
      foot={
        <>
          <span>No email? Check spam, or wait a minute.</span>
          <span />
        </>
      }
    >
      <SystemCardHead kicker={copy.kicker} step="2 / 2" title="Check your email">
        We sent a six-digit code to <b className="font-medium text-fg1">{trimmed}</b>. It works for
        10 minutes.
      </SystemCardHead>
      <form
        noValidate
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void onVerify();
        }}
      >
        <AuthField label="Code" need={place === 'code' && failure ? FAILURE_COPY[failure] : null}>
          <CodeInput
            rootRef={codeRef}
            value={code}
            disabled={busy === 'verify'}
            onValueChange={(next) => {
              setCode(next);
              if (next !== refused) setFailure(null);
            }}
          />
        </AuthField>
        {formLine}
        <Button
          type="submit"
          variant="primary"
          disabled={code.length !== CODE_LENGTH || code === refused}
          loading={busy === 'verify'}
          className="h-[2.625rem] w-full"
        >
          {copy.verify}
        </Button>
      </form>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={busy === 'verify'}
          onClick={onDifferentEmail}
        >
          Use a different email
        </Button>
        <Button
          size="sm"
          className="flex-1"
          disabled={cooldown > 0 || busy === 'verify'}
          loading={busy === 'resend'}
          onClick={() => void onResend()}
        >
          {cooldown > 0 ? `Send a new code · ${formatCooldown(cooldown)}` : 'Send a new code'}
        </Button>
      </div>
    </SystemCard>
  );
}
