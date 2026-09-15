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
    removedOld: null,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onSendCode: vi.fn(),
    onVerify: vi.fn(),
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

  it('confirms the new address, and explains a Google-linked old one that had to stay', () => {
    renderView({ step: 'done', pendingEmail: 'new@example.test', removedOld: false });
    expect(screen.getByText(/your email is now new@example.test/i)).toBeInTheDocument();
    expect(screen.getByText(/linked to your google sign-in/i)).toBeInTheDocument();
    expect(screen.getByText(/go to the new address from here on/i)).toBeInTheDocument();
  });

  it('says nothing about the old address when it was released', () => {
    renderView({ step: 'done', pendingEmail: 'new@example.test', removedOld: true });
    expect(screen.queryByText(/google sign-in/i)).not.toBeInTheDocument();
  });
});
