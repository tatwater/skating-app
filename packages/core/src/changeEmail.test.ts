import { describe, expect, test, vi } from 'vitest';
import {
  beginEmailChange,
  completeEmailChange,
  type EmailAddressLike,
  isCurrentEmail,
  normalizeEmail,
  type UserLike,
} from './changeEmail';

function address(
  id: string,
  emailAddress: string,
  over: Partial<EmailAddressLike> = {},
): EmailAddressLike {
  return {
    id,
    emailAddress,
    prepareVerification: vi.fn(async () => undefined),
    attemptVerification: vi.fn(async () => ({ verification: { status: 'verified' } })),
    destroy: vi.fn(async () => undefined),
    ...over,
  };
}

function user(primary: EmailAddressLike | null, others: EmailAddressLike[] = []): UserLike {
  const created: EmailAddressLike[] = [];
  return {
    primaryEmailAddress: primary,
    emailAddresses: [...(primary ? [primary] : []), ...others],
    createEmailAddress: vi.fn(async ({ email }) => {
      const a = address(`new-${created.length}`, email);
      created.push(a);
      return a;
    }),
    update: vi.fn(async () => undefined),
  };
}

describe('changeEmail — the Clerk sequence, against a fake', () => {
  test('normalizes, and refuses the address already on the account', async () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    const u = user(address('e1', 'me@example.com'));
    expect(isCurrentEmail(u, 'ME@example.com')).toBe(true);
    expect(isCurrentEmail(u, 'other@example.com')).toBe(false);
    await expect(beginEmailChange(u, 'Me@Example.com')).rejects.toThrow(/already your email/);
    await expect(beginEmailChange(u, '   ')).rejects.toThrow(/enter an email/i);
    expect(u.createEmailAddress).not.toHaveBeenCalled();
  });

  test('begin adds the address and sends a code; a retry re-sends to the unverified one', async () => {
    const u = user(address('e1', 'me@example.com'));
    const pending = await beginEmailChange(u, ' New@Example.com ');
    expect(u.createEmailAddress).toHaveBeenCalledWith({ email: 'new@example.com' });
    expect(pending.prepareVerification).toHaveBeenCalledWith({ strategy: 'email_code' });

    // Backed out and started again with the same address: reuse, don't re-create.
    const retryUser = user(address('e1', 'me@example.com'), [pending]);
    const again = await beginEmailChange(retryUser, 'new@example.com');
    expect(again).toBe(pending);
    expect(retryUser.createEmailAddress).not.toHaveBeenCalled();
    expect(pending.prepareVerification).toHaveBeenCalledTimes(2);
  });

  test('complete verifies, makes primary, and releases the old address', async () => {
    const old = address('e1', 'me@example.com');
    const u = user(old);
    const pending = await beginEmailChange(u, 'new@example.com');
    const result = await completeEmailChange(u, pending, ' 123456 ');
    expect(pending.attemptVerification).toHaveBeenCalledWith({ code: '123456' });
    expect(u.update).toHaveBeenCalledWith({ primaryEmailAddressId: pending.id });
    expect(old.destroy).toHaveBeenCalled();
    expect(result).toEqual({ email: 'new@example.com', removedOld: true });
  });

  test('a wrong code stops before anything changes', async () => {
    const old = address('e1', 'me@example.com');
    const u = user(old);
    const pending = await beginEmailChange(u, 'new@example.com');
    (pending.attemptVerification as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verification: { status: 'failed' },
    });
    await expect(completeEmailChange(u, pending, '000000')).rejects.toThrow(/didn’t verify/);
    await expect(completeEmailChange(u, pending, '')).rejects.toThrow(/enter the code/i);
    expect(u.update).not.toHaveBeenCalled();
    expect(old.destroy).not.toHaveBeenCalled();
  });

  test('an old address Clerk refuses to remove (a Google-linked one) stays as a secondary, and the change still completes', async () => {
    const old = address('e1', 'me@example.com', {
      destroy: vi.fn(async () => {
        throw new Error('linked to oauth_google');
      }),
    });
    const u = user(old);
    const pending = await beginEmailChange(u, 'new@example.com');
    const result = await completeEmailChange(u, pending, '123456');
    expect(u.update).toHaveBeenCalledWith({ primaryEmailAddressId: pending.id });
    expect(result).toEqual({ email: 'new@example.com', removedOld: false });
  });

  test('an account with no primary yet simply gains one', async () => {
    const u = user(null);
    const pending = await beginEmailChange(u, 'first@example.com');
    const result = await completeEmailChange(u, pending, '123456');
    expect(result).toEqual({ email: 'first@example.com', removedOld: false });
  });
});
