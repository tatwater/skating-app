/**
 * Look up a user's email address in Clerk.
 *
 * **Extracted when the second caller appeared rather than copied** — the same rule `lib/resend`
 * records, and for the same reason: the parts worth sharing are the *posture*, not the fetch. Both
 * callers need the primary-address selection (Clerk returns a list and a pointer into it, and taking
 * `[0]` silently mails the wrong address for anyone with two), the log-and-return-null contract, and
 * the missing-key branch.
 *
 * **Since A08 PR 3 this is the fallback, not the design.** The primary address is mirrored onto
 * `profiles.email` from the JWT's `email` claim — written at onboarding (`upsertFromClerk`) and
 * refreshed on every app open (`syncFromClerk`) — so a user-scale send reads the row, not Clerk.
 * This lookup remains for what the mirror can't cover: a profile whose token never carried the claim
 * (the notification sender caches the answer onto the row, once), the data-export mail to a person
 * whose row may already be scrubbed (D62), and the operator alerts (D38), which mail staff by Clerk
 * subject. A digest to every member must never be this function in a loop.
 */

import { isSeedProfile } from './seedPeople';

const CLERK_API_BASE = 'https://api.clerk.com/v1';

/** The slice of Clerk's user JSON the primary-address pick reads — the Backend API and the webhook payload share it. */
export interface ClerkUserEmails {
  primary_email_address_id?: string | null;
  email_addresses?: {
    id: string;
    email_address: string;
    /** Present on both the Backend API and the webhook payload; absent in older fixtures. */
    verification?: { status?: string | null } | null;
  }[];
}

/**
 * The primary-address pick, shared with the webhook (`lib/clerkWebhook.ts`): the primary pointer,
 * else the first **verified** address, else nothing. Lives here rather than beside the verifier so
 * the three action bundles that only ever *look up* an address don't carry the signature library.
 *
 * ⚠ Not `[0]` outright, twice over. A person with a work and a personal address on file would be
 * mailed at whichever Clerk listed first — and, since the change-email flow, the first address can
 * be the *unverified* one it just added: an account with no primary yet that starts a change fires
 * `user.updated` with `[unverified new]`, and mailing that would send private notifications to an
 * inbox nobody has proven they own. An address with no verification field at all (an old fixture)
 * is taken at face value, as before.
 */
export function primaryEmailOf(body: ClerkUserEmails): string | null {
  const addresses = body.email_addresses ?? [];
  const primary = addresses.find((a) => a.id === body.primary_email_address_id);
  const fallback = addresses.find(
    (a) => a.verification === undefined || a.verification?.status === 'verified',
  );
  return (primary ?? fallback)?.email_address ?? null;
}

/**
 * **A Clerk address lookup, three ways** (B01-5f, Greptile on #175): `found`; `none` — Clerk answered
 * and the person has no address (a 404, or no primary or verified address), or there is no person to
 * look up (a seed subject, an empty one); `error` — no answer to trust (no `CLERK_SECRET_KEY`, any
 * other non-2xx, a thrown fetch, an unreadable body), so the person may well have one. A caller that
 * records "no address" where a person reads it asks this, never the `null` of
 * {@link clerkEmailForSubject}, which can't tell the two apart.
 */
export type ClerkEmailLookup =
  | { kind: 'found'; email: string }
  | { kind: 'none' }
  | { kind: 'error' };

export async function clerkEmailLookup(subject: string): Promise<ClerkEmailLookup> {
  // A fake person from the dev seed has no Clerk account, and no address to find (D287).
  if (isSeedProfile(subject) || !subject) return { kind: 'none' };
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    console.warn('CLERK_SECRET_KEY not set — cannot look up an email address');
    return { kind: 'error' };
  }
  try {
    const res = await fetch(`${CLERK_API_BASE}/users/${subject}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 404) return { kind: 'none' };
    if (!res.ok) {
      console.warn(`Clerk user lookup failed: ${res.status} ${res.statusText}`);
      return { kind: 'error' };
    }
    const body = (await res.json()) as ClerkUserEmails;
    // The primary pointer, falling back to the first verified — the same pick the webhook makes.
    const email = primaryEmailOf(body);
    return email ? { kind: 'found', email } : { kind: 'none' };
  } catch (err) {
    console.warn('Clerk user lookup threw', err);
    return { kind: 'error' };
  }
}

/**
 * The primary email for a Clerk subject, or `null` — {@link clerkEmailLookup}'s `found`, the answer
 * every other caller has always read, unchanged.
 *
 * Never throws: every caller is a scheduled action whose work has already committed, and a mail
 * lookup failing must not roll anything back or abort a fan-out partway.
 */
export async function clerkEmailForSubject(subject: string): Promise<string | null> {
  const lookup = await clerkEmailLookup(subject);
  return lookup.kind === 'found' ? lookup.email : null;
}
