import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthOutcome } from './authFlow';
import { type AuthCodeClient, CodeFlow } from './CodeFlow';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ useAnalytics: () => ({ capture }) }));

const EMAIL = 'kate.donovan@gmail.com';
const ok: AuthOutcome = { ok: true };

function client(overrides: Partial<AuthCodeClient> = {}): AuthCodeClient {
  return {
    sendCode: vi.fn(async () => ok),
    resendCode: vi.fn(async () => ok),
    verifyCode: vi.fn(async () => ok),
    reset: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderFlow(c: AuthCodeClient, mode: 'sign-in' | 'sign-up' = 'sign-in') {
  render(<CodeFlow mode={mode} client={c} otherLink={<a href="/sign-up">Create an account</a>} />);
}

const emailBox = () => screen.getByRole('textbox', { name: 'Email address' });

async function toCodeStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(emailBox(), `${EMAIL}{Enter}`);
  await screen.findByText('Check your email');
}

beforeEach(() => capture.mockClear());

describe('CodeFlow, the email step', () => {
  it('opens focused on the email, with the primary off until the address could be one', async () => {
    const user = userEvent.setup();
    renderFlow(client());
    await waitFor(() => expect(emailBox()).toHaveFocus());
    const send = screen.getByRole('button', { name: 'Email me a code' });
    expect(send).toBeDisabled();
    await user.type(emailBox(), 'kate@');
    expect(send).toBeDisabled();
    await user.type(emailBox(), 'example.com');
    expect(send).toBeEnabled();
  });

  it('sends the trimmed address on Enter, counts the send without it, and moves to the code', async () => {
    const user = userEvent.setup();
    const c = client();
    renderFlow(c);
    await user.type(emailBox(), `  ${EMAIL}  {Enter}`);
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(c.sendCode).toHaveBeenCalledWith(EMAIL);
    expect(capture).toHaveBeenCalledWith('sign_in_code_sent', { method: 'email_code' });
    expect(JSON.stringify(capture.mock.calls)).not.toContain(EMAIL);
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Code' })).toHaveFocus());
  });

  it('sends once however often Enter is pressed while a send is under way', async () => {
    const user = userEvent.setup();
    let release: (o: AuthOutcome) => void = () => undefined;
    const c = client({ sendCode: vi.fn(() => new Promise<AuthOutcome>((r) => (release = r))) });
    renderFlow(c);
    await user.type(emailBox(), `${EMAIL}{Enter}{Enter}{Enter}`);
    expect(c.sendCode).toHaveBeenCalledOnce();
    release(ok);
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
  });

  it('holds the address while its code is on the way, so the code screen names the inbox sent to', async () => {
    const user = userEvent.setup();
    let release: (o: AuthOutcome) => void = () => undefined;
    const c = client({ sendCode: vi.fn(() => new Promise<AuthOutcome>((r) => (release = r))) });
    renderFlow(c);
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    expect(emailBox()).toBeDisabled();
    // The button stays focusable while it loads (Base UI), so it says so with aria-disabled.
    expect(screen.getByRole('button', { name: 'Email me a code' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.type(emailBox(), 'other@example.com');
    expect(emailBox()).toHaveValue(EMAIL);
    await act(async () => release(ok));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(c.sendCode).toHaveBeenCalledWith(EMAIL);
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it('gives the address back, focused, when the send fails', async () => {
    const user = userEvent.setup();
    let release: (o: AuthOutcome) => void = () => undefined;
    renderFlow(client({ sendCode: vi.fn(() => new Promise<AuthOutcome>((r) => (release = r))) }));
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    expect(emailBox()).toBeDisabled();
    await act(async () => release({ ok: false, failure: 'unknown_email' }));
    expect(emailBox()).toBeEnabled();
    await waitFor(() => expect(emailBox()).toHaveFocus());
  });

  it('says an unknown address under the field and keeps focus there', async () => {
    const user = userEvent.setup();
    renderFlow(
      client({ sendCode: vi.fn(async () => ({ ok: false, failure: 'unknown_email' }) as const) }),
    );
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('There’s no Gli account');
    expect(emailBox()).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(emailBox()).toHaveFocus());
    expect(capture).not.toHaveBeenCalled();
    // Typing again clears it.
    await user.type(emailBox(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('turns a thrown call into the generic line, never its message', async () => {
    const user = userEvent.setup();
    renderFlow(client({ sendCode: vi.fn(async () => Promise.reject(new Error(`no ${EMAIL}`))) }));
    await user.type(emailBox(), `${EMAIL}{Enter}`);
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent('Couldn’t reach Gli');
    expect(line).not.toHaveTextContent(EMAIL);
  });

  it('starts with a failure handed in (a sign-in link that did not work)', () => {
    render(
      <CodeFlow
        mode="sign-in"
        client={client()}
        otherLink={<a href="/x">x</a>}
        initialFailure="ticket"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('That sign-in link didn’t work');
  });

  it('offers the bot check’s element on sign-up only, and the sign-up words', () => {
    renderFlow(client(), 'sign-up');
    expect(screen.getByText('Join Gli')).toBeInTheDocument();
    expect(emailBox()).toHaveAttribute('placeholder', 'you@example.com');
    expect(document.getElementById('clerk-captcha')).not.toBeNull();
  });

  it('has no bot check element on sign-in', () => {
    renderFlow(client());
    expect(document.getElementById('clerk-captcha')).toBeNull();
  });
});

describe('CodeFlow, the code step', () => {
  afterEach(() => vi.useRealTimers());

  it('verifies a full code on Enter, counts the completion, and stays busy for AuthGate', async () => {
    const user = userEvent.setup();
    const c = client();
    renderFlow(c);
    await toCodeStep(user);
    const primary = screen.getByRole('button', { name: 'Sign in' });
    expect(primary).toBeDisabled();
    await user.keyboard('419207');
    expect(primary).toBeEnabled();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(c.verifyCode).toHaveBeenCalledWith('419207'));
    await waitFor(() =>
      expect(capture).toHaveBeenCalledWith('sign_in_completed', { method: 'email_code' }),
    );
    expect(primary).toHaveAttribute('aria-busy', 'true');
  });

  it('refuses a wrong code: amber under the slots, focus back, off until it changes, resend now', async () => {
    const user = userEvent.setup();
    const c = client({
      verifyCode: vi.fn(async () => ({ ok: false, failure: 'wrong_code' }) as const),
    });
    renderFlow(c);
    await toCodeStep(user);
    expect(screen.getByRole('button', { name: /Send a new code · 0:\d\d/ })).toBeDisabled();
    await user.keyboard('419200{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code doesn’t match');
    const slots = screen.getAllByRole('textbox');
    await waitFor(() => expect(slots.find((s) => s.tabIndex === 0)).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
    expect(capture).not.toHaveBeenCalledWith('sign_in_completed', expect.anything());
    // Changing the code clears the refusal; the primary waits for six digits again.
    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('keeps a form-level failure on its own line', async () => {
    const user = userEvent.setup();
    renderFlow(
      client({ verifyCode: vi.fn(async () => ({ ok: false, failure: 'incomplete' }) as const) }),
    );
    await toCodeStep(user);
    await user.keyboard('419207{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t finish setting up');
  });

  it('sends a new code once the clock runs out, and restarts it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const c = client();
    renderFlow(c);
    await toCodeStep(user);
    expect(screen.getByRole('button', { name: 'Send a new code · 0:30' })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    const resend = screen.getByRole('button', { name: 'Send a new code' });
    await user.click(resend);
    await waitFor(() => expect(c.resendCode).toHaveBeenCalledOnce());
    expect(capture).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: /Send a new code · 0:\d\d/ })).toBeDisabled();
  });

  it('says a failed resend', async () => {
    const user = userEvent.setup();
    renderFlow(
      client({
        verifyCode: vi.fn(async () => ({ ok: false, failure: 'wrong_code' }) as const),
        resendCode: vi.fn(async () => ({ ok: false, failure: 'rate_limited' }) as const),
      }),
    );
    await toCodeStep(user);
    await user.keyboard('419200{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries. Wait a minute');
  });

  it('goes back for a different email, keeping the address and forgetting the attempt', async () => {
    const user = userEvent.setup();
    const c = client({ reset: vi.fn(async () => Promise.reject(new Error('ignored'))) });
    renderFlow(c);
    await toCodeStep(user);
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(c.reset).toHaveBeenCalledOnce();
    expect(emailBox()).toHaveValue(EMAIL);
    await waitFor(() => expect(emailBox()).toHaveFocus());
  });

  it('uses the sign-up words for its primary', async () => {
    const user = userEvent.setup();
    renderFlow(client(), 'sign-up');
    await toCodeStep(user);
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });
});
