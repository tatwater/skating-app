/**
 * The Resend transport, shared by the operator alerts (D38) and the data-export email (D33/D62).
 *
 * Extracted when the second caller appeared rather than copied, which is the A02 lesson applied to a
 * much smaller surface: the log-and-skip posture, the never-throw contract and the HTML escaping are
 * the parts that matter, and two copies would eventually disagree about one of them.
 *
 * **All Resend env vars ship unset.** `RESEND_API_KEY` / `RESEND_FROM_EMAIL` are provisioned during the
 * prod cutover, so on dev this logs and returns. That is deliberate rather than a gap to fix later:
 * a build that fails without a mail provider would block every deploy on a founder task.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend's default ceiling is 2 requests/second, answered with a 429 and a `Retry-After`. A
 * notification batch sends one mail per row in sequence, which is faster than that, so a 429 is the
 * *expected* shape of a busy 8pm — not a failure to log and drop. Honoured up to this many times per
 * send, waiting what the header says (bounded, in case it says something silly).
 */
const RATE_LIMIT_RETRIES = 3;
const RETRY_AFTER_DEFAULT_MS = 1000;
const RETRY_AFTER_MAX_MS = 5000;

function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers?.get?.('retry-after') ?? '');
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RETRY_AFTER_DEFAULT_MS;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send one email. Returns whether it actually went out — callers that record a `sentAt` need to tell
 * "delivered" from "skipped because the provider isn't configured", and a boolean is the honest answer
 * where a silent `void` would let an unsent email look sent.
 *
 * Never throws: every caller is scheduled off a mutation that has already committed, so a mail failure
 * must not roll anything back.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Named in the log line when the send is skipped or fails. */
  context: string;
  /**
   * Extra message headers. Skater-facing mail sets `List-Unsubscribe` (+ `-Post`) here so a mail
   * client can offer its own one-click unsubscribe — the same link the footer carries (A08 PR 3).
   */
  headers?: Record<string, string>;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!key || !from || !opts.to) {
    console.warn(
      `${opts.context} email skipped (Resend env not configured): ${opts.subject} — set RESEND_API_KEY / RESEND_FROM_EMAIL to enable.`,
    );
    return false;
  }

  const body = JSON.stringify({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (res.ok) return true;
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res)));
        continue;
      }
      console.warn(`Resend ${opts.context} failed: ${res.status} ${res.statusText}`);
      return false;
    }
  } catch (err) {
    console.warn(`Resend ${opts.context} threw`, err);
    return false;
  }
}
