import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInFlow } from './SignInFlow';
import { SignUpFlow } from './SignUpFlow';

/**
 * The Clerk bindings, against hand-rolled `useSignIn` / `useSignUp` stand-ins: what each step asks of
 * Clerk, what each answer becomes, and the headless `__clerk_ticket` path. No Clerk users, no network.
 */
const m = vi.hoisted(() => {
  type Navigate = (p: {
    session: { currentTask?: unknown };
    decorateUrl: (u: string) => string;
  }) => unknown;
  const finalizeWith =
    (opts: { task?: boolean; decorated?: string } = {}) =>
    async ({ navigate }: { navigate: Navigate }) => {
      await navigate({
        session: opts.task ? { currentTask: { key: 'choose-organization' } } : {},
        decorateUrl: (u) => opts.decorated ?? u,
      });
      return { error: null };
    };
  return {
    finalizeWith,
    signIn: {
      status: 'needs_first_factor' as string,
      emailCode: { sendCode: vi.fn(), verifyCode: vi.fn() },
      ticket: vi.fn(),
      finalize: vi.fn(),
      reset: vi.fn(async () => ({ error: null })),
    },
    signUp: {
      status: 'missing_requirements' as string,
      create: vi.fn(),
      verifications: { sendEmailCode: vi.fn(), verifyEmailCode: vi.fn() },
      finalize: vi.fn(),
      reset: vi.fn(async () => ({ error: null })),
    },
    capture: vi.fn(),
  };
});

vi.mock('@clerk/tanstack-react-start', () => ({
  useSignIn: () => ({ signIn: m.signIn }),
  useSignUp: () => ({ signUp: m.signUp }),
}));
vi.mock('../../../lib/analytics', () => ({ useAnalytics: () => ({ capture: m.capture }) }));

const EMAIL = 'kate.donovan@gmail.com';
const none = { error: null };
const apiError = (code: string) => ({ error: { errors: [{ code, message: `${code} ${EMAIL}` }] } });

beforeEach(() => {
  vi.clearAllMocks();
  m.signIn.status = 'needs_first_factor';
  m.signIn.emailCode.sendCode.mockResolvedValue(none);
  m.signIn.emailCode.verifyCode.mockImplementation(async () => {
    m.signIn.status = 'complete';
    return none;
  });
  m.signIn.finalize.mockImplementation(m.finalizeWith());
  m.signUp.status = 'missing_requirements';
  m.signUp.create.mockResolvedValue(none);
  m.signUp.verifications.sendEmailCode.mockResolvedValue(none);
  m.signUp.verifications.verifyEmailCode.mockImplementation(async () => {
    m.signUp.status = 'complete';
    return none;
  });
  m.signUp.finalize.mockImplementation(m.finalizeWith());
});

afterEach(() => window.history.replaceState(null, '', '/'));

const link = <a href="/other">Other</a>;
const emailBox = () => screen.getByRole('textbox', { name: 'Email address' });

async function signInThrough(user: ReturnType<typeof userEvent.setup>, code = '419207') {
  await user.type(emailBox(), `${EMAIL}{Enter}`);
  await screen.findByText('Check your email');
  await user.keyboard(`${code}{Enter}`);
}

describe('SignInFlow', () => {
  it('sends the code for the address, resends for the same attempt, and finalizes a complete sign-in', async () => {
    const user = userEvent.setup();
    render(<SignInFlow otherLink={link} />);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    await screen.findByText('Check your email');
    expect(m.signIn.emailCode.sendCode).toHaveBeenCalledWith({ emailAddress: EMAIL });
    await user.keyboard('419207{Enter}');
    await waitFor(() => expect(m.signIn.finalize).toHaveBeenCalledOnce());
    expect(m.signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: '419207' });
    expect(m.capture).toHaveBeenCalledWith('sign_in_completed', { method: 'email_code' });
  });

  it('asks for another code without an address', async () => {
    const user = userEvent.setup();
    m.signIn.emailCode.verifyCode.mockResolvedValue(apiError('form_code_incorrect'));
    render(<SignInFlow otherLink={link} />);
    await signInThrough(user, '000000');
    await user.click(await screen.findByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(m.signIn.emailCode.sendCode).toHaveBeenLastCalledWith());
  });

  it('says a Clerk refusal in its own words, never Clerk’s', async () => {
    const user = userEvent.setup();
    m.signIn.emailCode.sendCode.mockResolvedValue(apiError('form_identifier_not_found'));
    render(<SignInFlow otherLink={link} />);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('There’s no Gli account for that email');
    expect(alert).not.toHaveTextContent('form_identifier_not_found');
  });

  it('calls a verified attempt that is not complete incomplete, and does not finalize it', async () => {
    const user = userEvent.setup();
    m.signIn.emailCode.verifyCode.mockImplementation(async () => {
      m.signIn.status = 'needs_second_factor';
      return none;
    });
    render(<SignInFlow otherLink={link} />);
    await signInThrough(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t finish');
    expect(m.signIn.finalize).not.toHaveBeenCalled();
  });

  it('reports a wrong code under the slots', async () => {
    const user = userEvent.setup();
    m.signIn.emailCode.verifyCode.mockResolvedValue(apiError('form_code_incorrect'));
    render(<SignInFlow otherLink={link} />);
    await signInThrough(user, '000000');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code doesn’t match');
  });

  it('treats a session that still has a task as not signed in', async () => {
    const user = userEvent.setup();
    m.signIn.finalize.mockImplementation(m.finalizeWith({ task: true }));
    render(<SignInFlow otherLink={link} />);
    await signInThrough(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t finish');
  });

  it('reports a finalize that fails', async () => {
    const user = userEvent.setup();
    m.signIn.finalize.mockResolvedValue(apiError('too_many_requests'));
    render(<SignInFlow otherLink={link} />);
    await signInThrough(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries');
  });

  it('forgets the attempt for a different email', async () => {
    const user = userEvent.setup();
    render(<SignInFlow otherLink={link} />);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    await user.click(await screen.findByRole('button', { name: 'Use a different email' }));
    expect(m.signIn.reset).toHaveBeenCalledOnce();
  });

  describe('the headless path (`__clerk_ticket`)', () => {
    it('signs in with the token, takes it out of the URL first, and fires no analytics', async () => {
      window.history.replaceState(null, '', '/sign-in?__clerk_ticket=tok_single_use');
      m.signIn.ticket.mockImplementation(async () => {
        // By the time Clerk is asked, the token is gone from the address bar.
        expect(window.location.search).toBe('');
        m.signIn.status = 'complete';
        return none;
      });
      render(<SignInFlow otherLink={link} />);
      expect(screen.getByRole('progressbar', { name: 'Signing in' })).toBeInTheDocument();
      await waitFor(() => expect(m.signIn.finalize).toHaveBeenCalledOnce());
      expect(m.signIn.ticket).toHaveBeenCalledWith({ ticket: 'tok_single_use' });
      expect(window.location.pathname).toBe('/sign-in');
      expect(m.capture).not.toHaveBeenCalled();
      // It stays on the holding card; AuthGate moves on once the session flips.
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it.each([
      ['a refused token', async () => apiError('form_identifier_not_found')],
      ['a token that throws', async () => Promise.reject(new Error('boom'))],
      [
        'a token that leaves the attempt unfinished',
        async () => {
          m.signIn.status = 'needs_first_factor';
          return none;
        },
      ],
    ])('falls back to the email form after %s', async (_, outcome) => {
      window.history.replaceState(null, '', '/sign-in?__clerk_ticket=tok_bad');
      m.signIn.ticket.mockImplementation(outcome);
      render(<SignInFlow otherLink={link} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('That sign-in link didn’t work');
      expect(emailBox()).toBeInTheDocument();
      expect(m.signIn.finalize).not.toHaveBeenCalled();
    });

    it('does nothing with no token', () => {
      render(<SignInFlow otherLink={link} />);
      expect(m.signIn.ticket).not.toHaveBeenCalled();
      expect(emailBox()).toBeInTheDocument();
    });
  });

  it('takes the external route when Safari needs its cookie refreshed', async () => {
    const user = userEvent.setup();
    const assigned = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...original,
        search: '',
        set href(url: string) {
          assigned(url);
        },
      },
    });
    try {
      m.signIn.finalize.mockImplementation(
        m.finalizeWith({ decorated: 'https://clerk.example/v1/client/touch?redirect_url=/' }),
      );
      render(<SignInFlow otherLink={link} />);
      await signInThrough(user);
      await waitFor(() =>
        expect(assigned).toHaveBeenCalledWith(
          'https://clerk.example/v1/client/touch?redirect_url=/',
        ),
      );
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('SignUpFlow', () => {
  it('creates the account for the address, sends its code, and finalizes once complete', async () => {
    const user = userEvent.setup();
    render(<SignUpFlow otherLink={link} />);
    await signInThrough(user);
    await waitFor(() => expect(m.signUp.finalize).toHaveBeenCalledOnce());
    expect(m.signUp.create).toHaveBeenCalledWith({ emailAddress: EMAIL });
    expect(m.signUp.verifications.sendEmailCode).toHaveBeenCalledOnce();
    expect(m.signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({ code: '419207' });
  });

  it('stops honestly when the instance still wants a field (a required password)', async () => {
    const user = userEvent.setup();
    m.signUp.verifications.verifyEmailCode.mockResolvedValue(none); // stays missing_requirements
    render(<SignUpFlow otherLink={link} />);
    await signInThrough(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t finish');
    expect(m.signUp.finalize).not.toHaveBeenCalled();
  });

  it('says an address that already has an account', async () => {
    const user = userEvent.setup();
    m.signUp.create.mockResolvedValue(apiError('form_identifier_exists'));
    render(<SignUpFlow otherLink={link} />);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in instead');
    expect(m.signUp.verifications.sendEmailCode).not.toHaveBeenCalled();
  });

  it('says a code that could not be sent, and a wrong code', async () => {
    const user = userEvent.setup();
    m.signUp.verifications.sendEmailCode.mockResolvedValueOnce(apiError('captcha_invalid'));
    render(<SignUpFlow otherLink={link} />);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('confirm you’re a person');
    await user.keyboard('{Enter}');
    await screen.findByText('Check your email');
    m.signUp.verifications.verifyEmailCode.mockResolvedValue(apiError('verification_expired'));
    await user.keyboard('419207{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code has expired');
  });

  it('resends, and forgets the attempt for a different email', async () => {
    const user = userEvent.setup();
    m.signUp.verifications.verifyEmailCode.mockResolvedValue(apiError('form_code_incorrect'));
    render(<SignUpFlow otherLink={link} />);
    await signInThrough(user, '000000');
    m.signUp.verifications.sendEmailCode.mockResolvedValueOnce(apiError('too_many_requests'));
    await user.click(await screen.findByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries');
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(m.signUp.reset).toHaveBeenCalledOnce();
  });
});
