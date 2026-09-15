/**
 * Clerk's webhook, verified (N8 post-merge / D174 amendment).
 *
 * Clerk posts a signed event to `POST /clerk-webhook` (`http.ts`) whenever a user record changes.
 * This module is the trust boundary for it: the signature is checked against
 * `CLERK_WEBHOOK_SIGNING_SECRET` before a byte of the body is believed, and what comes out is a
 * narrow, typed event — not Clerk's whole `UserJSON`.
 *
 * ## Why `standardwebhooks` and not `@clerk/backend/webhooks`
 *
 * Clerk's own `verifyWebhook` is a thin wrapper over the Standard Webhooks library plus an env
 * lookup from `@clerk/shared` — and `@clerk/shared` is the package this monorepo carries in two
 * majors (web on v4, mobile on v3; see the root README). Pulling `@clerk/backend` into the Convex
 * bundle would resolve whichever copy is hoisted. `standardwebhooks` is the verifier itself, pure
 * JS (SHA-256 in `fast-sha256`, no Node crypto), so it bundles into the Convex runtime as-is.
 *
 * ## What verification buys
 *
 * A forged `user.updated` could point a person's notification mail at an attacker's address — the
 * one write in the app that redirects private information without a sign-in. So a bad or missing
 * signature is a 400, a missing secret is a 500 (misconfiguration must surface, and Svix retries a
 * 5xx so the event is not lost), and the timestamp tolerance the library enforces (5 minutes)
 * closes replay of a captured request.
 */

import { Webhook } from 'standardwebhooks';

/** The primary-address pick, shared with `clerkEmail.ts`: the primary pointer, else the first. */
export function primaryEmailOf(body: {
  primary_email_address_id?: string | null;
  email_addresses?: { id: string; email_address: string }[];
}): string | null {
  const addresses = body.email_addresses ?? [];
  // ⚠ Not `[0]` outright: a person with a work and a personal address on file would otherwise be
  // mailed at whichever Clerk happened to list first.
  const primary = addresses.find((a) => a.id === body.primary_email_address_id) ?? addresses[0];
  return primary?.email_address ?? null;
}

/** The events this app acts on, reduced to what the profile mirror needs. */
export type ClerkWebhookEvent =
  | {
      type: 'user.created' | 'user.updated';
      clerkUserId: string;
      /** `null` when the account has no address at all; `undefined` never — absent is `null`. */
      email: string | null;
      profileImageUrl: string | null;
    }
  | { type: 'user.deleted'; clerkUserId: string | null }
  | { type: 'ignored'; raw: string };

export class ClerkWebhookError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500,
  ) {
    super(message);
  }
}

/**
 * Verify a request from Clerk and reduce it to a {@link ClerkWebhookEvent}. Throws
 * {@link ClerkWebhookError} with the HTTP status the route should answer with.
 */
export async function verifyClerkWebhook(
  request: Request,
  secret: string | undefined = process.env.CLERK_WEBHOOK_SIGNING_SECRET,
): Promise<ClerkWebhookEvent> {
  if (!secret) {
    throw new ClerkWebhookError('CLERK_WEBHOOK_SIGNING_SECRET is not set', 500);
  }
  const headers = {
    'webhook-id': request.headers.get('svix-id') ?? '',
    'webhook-timestamp': request.headers.get('svix-timestamp') ?? '',
    'webhook-signature': request.headers.get('svix-signature') ?? '',
  };
  const body = await request.text();
  let payload: unknown;
  try {
    payload = new Webhook(secret).verify(body, headers);
  } catch (err) {
    throw new ClerkWebhookError(
      `signature rejected: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
  return reduceEvent(payload);
}

/** The reduction on its own, so a test can drive the shape without signing. */
export function reduceEvent(payload: unknown): ClerkWebhookEvent {
  const event = payload as { type?: unknown; data?: unknown } | null;
  const type = typeof event?.type === 'string' ? event.type : '';
  const data = (event?.data ?? {}) as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : null;
  if (type === 'user.created' || type === 'user.updated') {
    if (!id) throw new ClerkWebhookError(`${type} without a user id`, 400);
    return {
      type,
      clerkUserId: id,
      email: primaryEmailOf(data as Parameters<typeof primaryEmailOf>[0]),
      profileImageUrl: typeof data.image_url === 'string' ? data.image_url : null,
    };
  }
  if (type === 'user.deleted') return { type, clerkUserId: id };
  return { type: 'ignored', raw: type };
}
