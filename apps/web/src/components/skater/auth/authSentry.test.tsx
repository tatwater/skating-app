import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedSentryOptions } from '../../../lib/sentryOptions';
import { SignInFlow } from './SignInFlow';
import { SignUpFlow } from './SignUpFlow';

/**
 * **The custom Clerk flow leaks no email address and no code to Sentry (B03 §4.3).** Replacing the
 * prebuilt `<SignIn>` put Clerk's API errors through our own code, so this runs the real browser SDK
 * with the options the app ships (as `sentryWire.ts` does) and every default integration — DOM
 * clicks and key presses, console, history, global error and rejection handlers — then drives both
 * flows end to end with Clerk answers that carry the address and the code in their messages, and a
 * call that throws one. What the transport would have sent is then searched for both.
 *
 * The values are assembled at runtime, so this file's own source can't put them on the wire.
 * The controls prove the pipe was live: the marker event went out, carrying click breadcrumbs and a
 * console breadcrumb, so an empty send can't pass.
 */
type SentryModule = typeof import('@sentry/tanstackstart-react');
type Envelope = [Record<string, unknown>, [Record<string, unknown>, unknown][]];

const EMAIL = ['kate.donovan', ['example', 'org'].join('.')].join('@');
const CODE = [7, 3, 8, 1, 6, 5].join('');
const TICKET = ['tok', 'withheld', String(Date.now())].join('_');

const m = vi.hoisted(() => ({
  signIn: {
    status: 'needs_first_factor' as string,
    emailCode: { sendCode: vi.fn(), verifyCode: vi.fn() },
    ticket: vi.fn(),
    finalize: vi.fn(),
    reset: vi.fn(),
  },
  signUp: {
    status: 'missing_requirements' as string,
    create: vi.fn(),
    verifications: { sendEmailCode: vi.fn(), verifyEmailCode: vi.fn() },
    finalize: vi.fn(),
    reset: vi.fn(),
  },
  capture: vi.fn(),
}));

vi.mock('@clerk/tanstack-react-start', () => ({
  useSignIn: () => ({ signIn: m.signIn }),
  useSignUp: () => ({ signUp: m.signUp }),
}));
vi.mock('../../../lib/analytics', () => ({ useAnalytics: () => ({ capture: m.capture }) }));

/** A Clerk API error the way Clerk shapes one, with the person's values in every text field. */
const clerkError = (code: string) => {
  const error = Object.assign(new Error(`${code}: ${EMAIL} ${CODE}`), {
    errors: [
      {
        code,
        message: `Couldn't find ${EMAIL}`,
        longMessage: `The code ${CODE} for ${EMAIL} is not valid.`,
        meta: { paramName: 'identifier', emailAddress: EMAIL, code: CODE },
      },
    ],
  });
  return { error };
};

const sent: Envelope[] = [];
let Sentry: SentryModule;

beforeAll(async () => {
  // The browser build, by file path: Vitest doesn't select the package's `browser` condition.
  const root = dirname(
    createRequire(import.meta.url).resolve('@sentry/tanstackstart-react/package.json'),
  );
  Sentry = await import(pathToFileURL(join(root, 'build/esm/index.client.js')).href);
  Sentry.init({
    ...sharedSentryOptions,
    dsn: 'https://public@o0.ingest.sentry.io/0',
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(envelope as Envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
});

afterAll(async () => {
  await Sentry?.getClient()?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  Sentry.getCurrentScope().clearBreadcrumbs();
  Sentry.getIsolationScope().clearBreadcrumbs();
});

/** Flush a marker event, which carries the breadcrumbs, and return everything sent as text. */
async function wire(): Promise<string> {
  // The control: proves console breadcrumbs are recorded.
  console.info('auth-flow-control');
  Sentry.captureException(new Error('auth-flow-marker'));
  await Sentry.flush(2000);
  const text = JSON.stringify(sent);
  expect(text).toContain('auth-flow-marker');
  expect(text).toContain('auth-flow-control');
  expect(text).toContain('"category":"ui.click"');
  return text;
}

function expectWithheld(text: string) {
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(encodeURIComponent(EMAIL));
  expect(text).not.toContain(CODE);
  expect(text).not.toContain(TICKET);
}

const link = <a href="/other">Other</a>;

describe('the custom Clerk flow, through the real Sentry SDK', () => {
  it('sign-in: a refused address, a wrong code, a thrown resend and a reset leak neither value', async () => {
    const user = userEvent.setup();
    m.signIn.emailCode.sendCode
      .mockResolvedValueOnce(clerkError('form_identifier_not_found'))
      .mockResolvedValueOnce({ error: null })
      .mockRejectedValueOnce(new Error(`network down for ${EMAIL}`));
    m.signIn.emailCode.verifyCode.mockResolvedValue(clerkError('form_code_incorrect'));
    m.signIn.reset.mockRejectedValue(new Error(`reset failed for ${EMAIL}`));

    render(<SignInFlow otherLink={link} />);
    const email = screen.getByRole('textbox', { name: 'Email address' });
    await user.type(email, EMAIL);
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByText(/There’s no Gli account/);
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByText('Check your email');
    await user.keyboard(CODE);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/That code doesn’t match/);
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await screen.findByText(/Couldn’t reach Gli/);
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    await waitFor(() => expect(m.signIn.reset).toHaveBeenCalled());

    const text = await wire();
    expectWithheld(text);
    // Only the marker went out: the flow captured nothing of its own.
    const errors = sent.flatMap(([, items]) => items.filter(([h]) => h.type === 'event'));
    expect(errors).toHaveLength(1);
    // And nothing reached the analytics either.
    expect(JSON.stringify(m.capture.mock.calls)).not.toContain(EMAIL);
  });

  it('sign-up: a taken address, an expired code and a dead end leak neither value', async () => {
    const user = userEvent.setup();
    m.signUp.create
      .mockResolvedValueOnce(clerkError('form_identifier_exists'))
      .mockResolvedValueOnce({ error: null });
    m.signUp.verifications.sendEmailCode.mockResolvedValue({ error: null });
    m.signUp.verifications.verifyEmailCode
      .mockResolvedValueOnce(clerkError('verification_expired'))
      .mockResolvedValueOnce({ error: null });

    render(<SignUpFlow otherLink={link} />);
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), `${EMAIL}{Enter}`);
    await screen.findByText(/Sign in instead/);
    await user.keyboard('{Enter}');
    await screen.findByText('Check your email');
    await user.keyboard(`${CODE}{Enter}`);
    await screen.findByText(/That code has expired/);
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(m.signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(2));
    await user.keyboard(`${CODE}{Enter}`);
    await screen.findByText(/We couldn’t finish/);

    expectWithheld(await wire());
  });

  it('the headless path: the sign-in token never reaches an event, a breadcrumb or a URL', async () => {
    window.history.pushState(null, '', `/sign-in?__clerk_ticket=${TICKET}`);
    m.signIn.ticket.mockResolvedValue(clerkError('form_identifier_not_found'));
    const user = userEvent.setup();
    render(<SignInFlow otherLink={link} />);
    await screen.findByText(/That sign-in link didn’t work/);
    await user.click(screen.getByRole('textbox', { name: 'Email address' }));

    const text = await wire();
    expectWithheld(text);
    expect(text).toContain('/sign-in');
    window.history.replaceState(null, '', '/');
  });
});
