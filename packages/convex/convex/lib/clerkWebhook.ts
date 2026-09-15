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
 * signature is a 400, a missing *or malformed* secret is a 500 (misconfiguration must surface as
 * itself in Clerk's delivery log, not as "signature rejected"), and the timestamp tolerance the
 * library enforces (5 minutes) closes replay of a captured request.
 *
 * Svix retries **any** non-2xx for about three days, 400s included — so the status codes are for
 * the operator reading the endpoint's Messages tab, not for steering retries. What the retries do
 * buy is that an event posted before the secret is set is not lost once it lands.
 */

import { Webhook } from 'standardwebhooks';
import { type ClerkUserEmails, primaryEmailOf } from './clerkEmail';

/** The events this app acts on, reduced to what the profile mirror needs. */
export type ClerkWebhookEvent =
  | {
      type: 'user.created' | 'user.updated';
      clerkUserId: string;
      /** `null` when the account has no address at all; `undefined` never — absent is `null`. */
      email: string | null;
      profileImageUrl: string | null;
      /** Clerk's `updated_at` (ms) — the recency stamp `applyClerkMirrors` orders writes by. */
      updatedAt: number | null;
    }
  | { type: 'user.deleted'; clerkUserId: string | null }
  | { type: 'ignored'; raw: string };

export class ClerkWebhookError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500,
  ) {
    super(message);
    this.name = 'ClerkWebhookError';
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
  // Constructed before the request is read: the constructor base64-decodes the secret, so a value
  // pasted with a stray character fails *here*, as the misconfiguration it is — not inside the
  // signature check below, where it would read as every delivery being forged.
  let webhook: Webhook;
  try {
    webhook = new Webhook(secret);
  } catch (err) {
    throw new ClerkWebhookError(
      `CLERK_WEBHOOK_SIGNING_SECRET is malformed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  const headers = {
    'webhook-id': request.headers.get('svix-id') ?? '',
    'webhook-timestamp': request.headers.get('svix-timestamp') ?? '',
    'webhook-signature': request.headers.get('svix-signature') ?? '',
  };
  const body = await request.text();
  let payload: unknown;
  try {
    payload = webhook.verify(body, headers);
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
    // Authentic but unprocessable: acknowledged, not rejected. A non-2xx would have Svix redeliver
    // an event that can never become valid for days; the log line is the right terminal answer.
    if (!id) {
      console.warn(`clerk-webhook: ${type} without a user id — ignored`);
      return { type: 'ignored', raw: `${type}:no-id` };
    }
    return {
      type,
      clerkUserId: id,
      email: primaryEmailOf(data as ClerkUserEmails),
      profileImageUrl: typeof data.image_url === 'string' ? data.image_url : null,
      updatedAt: typeof data.updated_at === 'number' ? data.updated_at : null,
    };
  }
  if (type === 'user.deleted') return { type, clerkUserId: id };
  return { type: 'ignored', raw: type };
}
