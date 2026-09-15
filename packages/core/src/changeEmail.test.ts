import { describe, expect, test, vi } from 'vitest';
import {
  beginEmailChange,
  completeEmailChange,
  type EmailAddressLike,
  isCurrentEmail,
  isVerifiedEmail,
  normalizeEmail,
  type UserLike,
} from './changeEmail';

/**
 * A fake address. Like Clerk's resource, a successful `attemptVerification` flips its own
 * `verification.status` in place — that is what a retry after a failed make-primary step sees.
 */
function address(
  id: string,
  emailAddress: string,
  over: Partial<EmailAddressLike> = {},
): EmailAddressLike {
  const a: EmailAddressLike = {
    id,
    emailAddress,
    verification: { status: 'unverified' },
    prepareVerification: vi.fn(async () => undefined),
    attemptVerification: vi.fn(async () => {
      a.verification = { status: 'verified' };
      return { verification: a.verification };
    }),
    destroy: vi.fn(async () => undefined),
    ...over,
  };
  return a;
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

  test('an address already verified on the account skips the code: no send, no attempt, straight to primary', async () => {
    // The retained Google-linked address from the case above, wanted back as primary. Clerk
    // refuses to prepare or attempt a verification on it ("already verified"), so neither is tried.
    const google = address('e0', 'me@gmail.test', { verification: { status: 'verified' } });
    const u = user(address('e1', 'me@example.com'), [google]);
    const pending = await beginEmailChange(u, 'Me@Gmail.test');
    expect(pending).toBe(google);
    expect(isVerifiedEmail(pending)).toBe(true);
    expect(google.prepareVerification).not.toHaveBeenCalled();
    const result = await completeEmailChange(u, pending, '');
    expect(google.attemptVerification).not.toHaveBeenCalled();
    expect(u.update).toHaveBeenCalledWith({ primaryEmailAddressId: 'e0' });
    expect(result).toEqual({ email: 'me@gmail.test', removedOld: true });
  });

  test('a retry after the make-primary step failed does not verify twice', async () => {
    // The code was accepted, then `update` threw (network). The address is verified now; a second
    // pass must go to primary without re-running a verification Clerk would reject.
    const old = address('e1', 'me@example.com');
    const u = user(old);
    (u.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const pending = await beginEmailChange(u, 'new@example.com');
    await expect(completeEmailChange(u, pending, '123456')).rejects.toThrow(/offline/);
    expect(isVerifiedEmail(pending)).toBe(true);
    expect(old.destroy).not.toHaveBeenCalled();

    // Backing out and starting over with the same address sends no second code...
    const again = await beginEmailChange(user(old, [pending]), 'new@example.com');
    expect(again).toBe(pending);
    expect(pending.prepareVerification).toHaveBeenCalledTimes(1);

    // ...and finishing, by either path, verifies nothing a second time.
    const result = await completeEmailChange(u, pending, '');
    expect(pending.attemptVerification).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ email: 'new@example.com', removedOld: true });
  });

  test('an account with no primary yet simply gains one', async () => {
    const u = user(null);
    const pending = await beginEmailChange(u, 'first@example.com');
    const result = await completeEmailChange(u, pending, '123456');
    expect(result).toEqual({ email: 'first@example.com', removedOld: false });
  });
});
