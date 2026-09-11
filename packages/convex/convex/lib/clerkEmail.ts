/**
 * Look up a user's email address in Clerk.
 *
 * **Extracted when the second caller appeared rather than copied** — the same rule `lib/resend`
 * records, and for the same reason: the parts worth sharing are the *posture*, not the fetch. Both
 * callers need the primary-address selection (Clerk returns a list and a pointer into it, and taking
 * `[0]` silently mails the wrong address for anyone with two), the log-and-return-null contract, and
 * the missing-key branch.
 *
 * ⚠ **Emails live in Clerk, not in `profiles`.** The corpus deliberately does not store them — the
 * profile row carries `clerkUserId` and nothing else identifying — so any feature that needs to mail
 * a user pays one HTTP call per recipient. That is fine for operator-scale fan-out (a handful of
 * staff) and would not be for a user-scale one; a digest to every member wants a different design,
 * not this function in a loop.
 */

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/**
 * The primary email for a Clerk subject, or `null`.
 *
 * Never throws: every caller is a scheduled action whose work has already committed, and a mail
 * lookup failing must not roll anything back or abort a fan-out partway.
 */
export async function clerkEmailForSubject(subject: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    console.warn('CLERK_SECRET_KEY not set — cannot look up an email address');
    return null;
  }
  if (!subject) return null;

  try {
    const res = await fetch(`${CLERK_API_BASE}/users/${subject}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`Clerk user lookup failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as {
      primary_email_address_id?: string;
      email_addresses?: { id: string; email_address: string }[];
    };
    const addresses = body.email_addresses ?? [];
    // ⚠ The primary pointer, falling back to the first — not `[0]` outright. A user with a work and
    // a personal address on file would otherwise be mailed at whichever Clerk happened to list first.
    const primary = addresses.find((a) => a.id === body.primary_email_address_id) ?? addresses[0];
    return primary?.email_address ?? null;
  } catch (err) {
    console.warn('Clerk user lookup threw', err);
    return null;
  }
}
