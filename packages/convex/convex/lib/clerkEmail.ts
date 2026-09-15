/**
 * Look up a user's email address in Clerk.
 *
 * **Extracted when the second caller appeared rather than copied** — the same rule `lib/resend`
 * records, and for the same reason: the parts worth sharing are the *posture*, not the fetch. Both
 * callers need the primary-address selection (Clerk returns a list and a pointer into it, and taking
 * `[0]` silently mails the wrong address for anyone with two), the log-and-return-null contract, and
 * the missing-key branch.
 *
 * **Since N8 PR 3 this is the fallback, not the design.** The primary address is mirrored onto
 * `profiles.email` from the JWT's `email` claim — written at onboarding (`upsertFromClerk`) and
 * refreshed on every app open (`syncFromClerk`) — so a user-scale send reads the row, not Clerk.
 * This lookup remains for what the mirror can't cover: a profile whose token never carried the claim
 * (the notification sender caches the answer onto the row, once), the data-export mail to a person
 * whose row may already be scrubbed (D62), and the operator alerts (D38), which mail staff by Clerk
 * subject. A digest to every member must never be this function in a loop.
 */

import { primaryEmailOf } from './clerkWebhook';

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
    const body = (await res.json()) as Parameters<typeof primaryEmailOf>[0];
    // The primary pointer, falling back to the first — the same pick the webhook makes.
    return primaryEmailOf(body);
  } catch (err) {
    console.warn('Clerk user lookup threw', err);
    return null;
  }
}
