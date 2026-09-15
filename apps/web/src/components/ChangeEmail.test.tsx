import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangeEmailView, type ChangeEmailViewProps } from './ChangeEmail';

function renderView(over: Partial<ChangeEmailViewProps> = {}) {
  const props: ChangeEmailViewProps = {
    currentEmail: 'me@example.test',
    step: 'idle',
    pendingEmail: null,
    busy: false,
    error: null,
    old: null,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onSendCode: vi.fn(),
    onVerify: vi.fn(),
    onRetryRemove: vi.fn(),
    ...over,
  };
  render(<ChangeEmailView {...props} />);
  return props;
}

describe('ChangeEmailView', () => {
  it('rests as the current address with one way in', () => {
    const p = renderView();
    expect(screen.getByText('me@example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    expect(p.onStart).toHaveBeenCalled();
  });

  it('says what the code is for before asking for an address, and submits it trimmed by the caller', () => {
    const p = renderView({ step: 'enter' });
    expect(screen.getByText(/email a code to the new address/i)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /email me a code/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(p.onSendCode).toHaveBeenCalledWith('new@example.test');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it('names the inbox the code went to and hands the code up', () => {
    const p = renderView({ step: 'code', pendingEmail: 'new@example.test' });
    expect(screen.getByText('new@example.test')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/verification code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(p.onVerify).toHaveBeenCalledWith('123456');
  });

  it('shows the error where the person is, and a busy step locks its buttons', () => {
    renderView({
      step: 'code',
      pendingEmail: 'new@example.test',
      error: 'That code didn’t verify',
      busy: true,
    });
    expect(screen.getByText(/didn’t verify/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verifying/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('confirms the new address, explains a Google-linked old one that had to stay, and has a way back', () => {
    const p = renderView({
      step: 'done',
      pendingEmail: 'new@example.test',
      old: { kind: 'kept_linked', provider: 'Google' },
    });
    expect(screen.getByText(/your email is now new@example.test/i)).toBeInTheDocument();
    expect(screen.getByText(/linked to your google sign-in/i)).toBeInTheDocument();
    expect(screen.getByText(/go to the new address from here on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove old address/i })).not.toBeInTheDocument();
    // The confirmation is not a dead end: the row rests again, now showing the new address.
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it('says nothing about the old address when it was released, or when there was none', () => {
    renderView({ step: 'done', pendingEmail: 'new@example.test', old: { kind: 'removed' } });
    expect(screen.queryByText(/old address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove old address/i })).not.toBeInTheDocument();
  });

  it('a cleanup failure is told as what it was, with a retry — never as a story about Google', () => {
    // Greptile, PR #57: the change is complete (primary moved), but the old address stayed for a
    // reason that was not the linked-account refusal. The person gets the real reason and a button.
    const p = renderView({
      step: 'done',
      pendingEmail: 'new@example.test',
      old: { kind: 'remove_failed', addressId: 'e1', message: 'Network request failed' },
    });
    expect(screen.getByText(/couldn’t remove your old address/i)).toBeInTheDocument();
    expect(screen.getByText(/network request failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/google/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove old address/i }));
    expect(p.onRetryRemove).toHaveBeenCalled();
  });
});
