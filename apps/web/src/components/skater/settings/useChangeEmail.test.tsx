import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  user: null as unknown,
  begin: vi.fn(),
  complete: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@clerk/tanstack-react-start', () => ({ useUser: () => ({ user: m.user }) }));
vi.mock('@skating/core', async (load) => ({
  ...(await load<typeof import('@skating/core')>()),
  beginEmailChange: m.begin,
  completeEmailChange: m.complete,
  removeOldEmail: m.remove,
}));

import { useChangeEmail } from './useChangeEmail';

const OLD = { id: 'e1', emailAddress: 'kate@donovan.net', verification: { status: 'verified' } };
const NEW = {
  id: 'e2',
  emailAddress: 'k@fastmail.com',
  verification: { status: 'unverified' },
  prepareVerification: vi.fn().mockResolvedValue(null),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { primaryEmailAddress: OLD };
});

describe('useChangeEmail', () => {
  it('sends, verifies, and lands on done with what became of the old address', async () => {
    m.begin.mockResolvedValue(NEW);
    m.complete.mockResolvedValue({ email: NEW.emailAddress, old: { kind: 'removed' } });
    const { result } = renderHook(() => useChangeEmail());
    expect(result.current.currentEmail).toBe('kate@donovan.net');
    act(() => result.current.start());
    expect(result.current.step).toBe('enter');
    await act(async () => result.current.view.onSendCode('k@fastmail.com'));
    expect(result.current.step).toBe('code');
    expect(result.current.view.pendingEmail).toBe('k@fastmail.com');
    await act(async () => result.current.view.onVerify('123456'));
    expect(m.complete).toHaveBeenCalledWith(m.user, NEW, '123456');
    expect(result.current.step).toBe('done');
    expect(result.current.view.old).toEqual({ kind: 'removed' });
    act(() => result.current.view.onCancel());
    expect(result.current.step).toBe('idle');
  });

  it('an address already verified skips the code', async () => {
    m.begin.mockResolvedValue({ ...NEW, verification: { status: 'verified' } });
    m.complete.mockResolvedValue({ email: NEW.emailAddress, old: { kind: 'none' } });
    const { result } = renderHook(() => useChangeEmail());
    await act(async () => result.current.view.onSendCode('k@fastmail.com'));
    expect(m.complete).toHaveBeenCalledWith(m.user, expect.anything(), '');
    expect(result.current.step).toBe('done');
  });

  it('retries removing the old address, and says when a step fails', async () => {
    m.begin.mockResolvedValue(NEW);
    m.complete.mockResolvedValue({
      email: NEW.emailAddress,
      old: { kind: 'remove_failed', addressId: 'e1', message: 'x' },
    });
    m.remove.mockResolvedValue({ kind: 'removed' });
    const { result } = renderHook(() => useChangeEmail());
    await act(async () => result.current.view.onSendCode('k@fastmail.com'));
    await act(async () => result.current.view.onVerify('123456'));
    await act(async () => result.current.view.onRetryRemove());
    expect(m.remove).toHaveBeenCalledWith(OLD);
    expect(result.current.view.old).toEqual({ kind: 'removed' });

    m.complete.mockRejectedValueOnce(new Error(''));
    await act(async () => result.current.view.onVerify('000000'));
    expect(result.current.view.error).toBe('That code didn’t work.');
    m.remove.mockRejectedValueOnce('nope');
    await act(async () => result.current.view.onRetryRemove());
    expect(result.current.view.error).toBe('We couldn’t remove the old address.');
    NEW.prepareVerification.mockRejectedValueOnce(new Error('Too many codes.'));
    await act(async () => result.current.view.onResend());
    expect(result.current.view.error).toBe('Too many codes.');
  });

  it('does nothing without a Clerk user or a pending address', async () => {
    m.user = null;
    const { result } = renderHook(() => useChangeEmail());
    expect(result.current.currentEmail).toBeNull();
    await act(async () => result.current.view.onSendCode('k@fastmail.com'));
    await act(async () => result.current.view.onVerify('1'));
    await act(async () => result.current.view.onRetryRemove());
    await act(async () => result.current.view.onResend());
    expect(m.begin).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('a press while busy is ignored', async () => {
    let resolve: (v: unknown) => void = () => {};
    m.begin.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useChangeEmail());
    act(() => result.current.view.onSendCode('a@b.c'));
    act(() => result.current.view.onSendCode('a@b.c'));
    expect(m.begin).toHaveBeenCalledTimes(1);
    await act(async () => resolve(NEW));
  });
});
