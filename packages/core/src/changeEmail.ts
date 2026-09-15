/**
 * Changing the email on a Clerk account — the sequence, written once (N8 post-merge).
 *
 * Clerk owns the address (D26); we never store a password or a verification code. The steps are
 * Clerk's own: add the new address, send it a code, verify it, make it primary, and let go of the
 * old one. Both clients used to have *no* way to do this, which is why the server-side mirror
 * (`profiles.email`) could never go stale in practice — and why adding this affordance is what
 * brought the Clerk webhook in beside it.
 *
 * Written against a **structural** slice of Clerk's `UserResource` rather than the type itself, so
 * `@skating/core` stays free of a Clerk dependency, both clients' `useUser()` values satisfy it
 * unchanged, and the sequence is testable with a fake that never talks to Clerk.
 *
 * ## What the server learns, and when
 *
 * Nothing here talks to Convex. The session token's `email` claim updates on Clerk's own refresh
 * cadence, so `profiles.syncFromClerk` on the *next* app open would pick it up — but the row
 * changes within seconds regardless, because Clerk posts `user.updated` to the webhook route and
 * that patches the mirror directly. A client must not try to shortcut this by sending the new
 * address to the server itself: the trust boundary (D37) is the signed webhook or the signed token,
 * never a string the client claims.
 */

export interface EmailAddressLike {
  id: string;
  emailAddress: string;
  /**
   * Clerk's verification state for the address. `'verified'` once a code has been accepted — or
   * from the start, for an address that arrived through a Google sign-in. Clerk refuses to prepare
   * or attempt a verification on an address that already has one ("already verified"), so the
   * sequence reads this to know whether there is a code step at all.
   */
  verification: { status: string | null } | null;
  prepareVerification(params: { strategy: 'email_code' }): Promise<unknown>;
  attemptVerification(params: { code: string }): Promise<{
    verification: { status: string | null } | null;
  }>;
  destroy(): Promise<unknown>;
}

export interface UserLike {
  primaryEmailAddress: EmailAddressLike | null;
  emailAddresses: EmailAddressLike[];
  createEmailAddress(params: { email: string }): Promise<EmailAddressLike>;
  update(params: { primaryEmailAddressId: string }): Promise<unknown>;
}

/** Trimmed and lower-cased; Clerk does the real validation, this only keeps a retry from creating a second address that differs by case. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Whether `input` is the address already on the account — the one change that is not a change.
 * Compared normalized, so `Me@Example.com` against `me@example.com` is "same" rather than a
 * verification round-trip that ends by setting the primary to itself.
 */
export function isCurrentEmail(
  user: Pick<UserLike, 'primaryEmailAddress'>,
  input: string,
): boolean {
  const current = user.primaryEmailAddress?.emailAddress;
  return current !== undefined && normalizeEmail(current) === normalizeEmail(input);
}

/**
 * Whether the address has already been verified, and so has no code step. The two ways in: a
 * Google-linked address that `completeEmailChange` could not remove and that the person now wants
 * back as primary; and a retry after the code was accepted but the make-primary step failed
 * (network, mostly) — the verification stuck, and Clerk will not run it twice.
 */
export function isVerifiedEmail(address: Pick<EmailAddressLike, 'verification'>): boolean {
  return address.verification?.status === 'verified';
}

/**
 * Step one: put the new address on the account and send it a code. Returns the address the code
 * was sent to, which `completeEmailChange` needs back.
 *
 * A retry — the person mistyped the code, backed out, and started over with the same address — finds
 * the unverified address already on the account and re-sends to it rather than tripping Clerk's
 * "already exists" error. Clerk's own cap on addresses per user is what bounds the list.
 *
 * When the address found is already verified (see `isVerifiedEmail`) no code is sent — Clerk would
 * refuse — and the caller should go straight to `completeEmailChange`, which then skips the code
 * check for the same reason.
 */
export async function beginEmailChange(user: UserLike, input: string): Promise<EmailAddressLike> {
  const email = normalizeEmail(input);
  if (email.length === 0) throw new Error('Enter an email address');
  if (isCurrentEmail(user, email)) throw new Error('That is already your email address');
  const existing = user.emailAddresses.find((a) => normalizeEmail(a.emailAddress) === email);
  const address = existing ?? (await user.createEmailAddress({ email }));
  if (!isVerifiedEmail(address)) await address.prepareVerification({ strategy: 'email_code' });
  return address;
}

export interface EmailChangeResult {
  /** The address now primary. */
  email: string;
  /**
   * Whether the previous primary was removed from the account. `false` when Clerk refused — an
   * address tied to a Google sign-in can't be destroyed while the connection stands — in which case
   * it stays as a secondary and the change is still complete: primary is what the mirror follows.
   */
  removedOld: boolean;
}

/**
 * Step two: verify the code, make the address primary, release the old one. The old address is
 * captured *before* the swap, so a fake or a slow reload can't make "old" read as "new".
 *
 * The code is only consulted for an address that still needs it; one already verified (a retained
 * Google-linked address, or a retry after the make-primary step failed) goes straight to primary,
 * and `code` may be empty.
 */
export async function completeEmailChange(
  user: UserLike,
  pending: EmailAddressLike,
  code: string,
): Promise<EmailChangeResult> {
  const old = user.primaryEmailAddress;
  if (!isVerifiedEmail(pending)) {
    const trimmed = code.trim();
    if (trimmed.length === 0) throw new Error('Enter the code from the email');
    const attempt = await pending.attemptVerification({ code: trimmed });
    if (attempt.verification?.status !== 'verified') {
      throw new Error('That code didn’t verify — check it and try again');
    }
  }
  await user.update({ primaryEmailAddressId: pending.id });
  let removedOld = false;
  if (old && old.id !== pending.id) {
    try {
      await old.destroy();
      removedOld = true;
    } catch {
      // Left as a secondary address; see `EmailChangeResult.removedOld`.
    }
  }
  return { email: pending.emailAddress, removedOld };
}
