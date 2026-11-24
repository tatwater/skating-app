/**
 * The Resend transport, shared by the operator alerts (D38) and the data-export email (D33/D62).
 *
 * Extracted when the second caller appeared rather than copied, which is the A02 lesson applied to a
 * much smaller surface: the log-and-skip posture, the never-throw contract and the HTML escaping are
 * the parts that matter, and two copies would eventually disagree about one of them.
 *
 * **Without its keys, a send logs and returns.** `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set on
 * the dev deployment (since 2026-09-11; `05-accounts-and-credentials.md`), so dev sends real mail.
 * They are unset in the tests and on a fresh deployment, where every send is skipped with a log line
 * and reported `rejected` (`unconfigured`). That is deliberate rather than a gap to fix: a build that
 * fails without a mail provider would block every deploy on a founder task.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend's default ceiling is 2 requests/second, answered with a 429 and a `Retry-After`. A
 * notification batch sends one mail per row in sequence, which is faster than that, so a 429 is the
 * *expected* shape of a busy 8pm — not a failure to log and drop. Honored up to this many times per
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
 * **What became of one send, three ways** (B01-5f, Greptile on #175): a caller that records the result
 * where a person reads it must not turn an uncertain answer into a certain one, in either direction.
 *
 * - `accepted`: Resend answered 2xx — it took the email (its body, the email's id, is not needed).
 * - `rejected`: **definitely not sent** — the request never left (no key, no sender, no address), or
 *   Resend answered a 4xx other than 409: a validation, auth, permission or missing-field refusal
 *   (`400`, `401`, `403`, `404`, `405`, `422`), or `429` (rate limit or quota: the request was refused,
 *   not processed) once the retries it allows are spent. `code` is the class, never the body.
 * - `unknown`: the request may have gone and no trustworthy answer came back — the fetch threw (a
 *   dropped connection), it timed out ({@link SEND_TIMEOUT_MS}), Resend answered `5xx` (its docs say
 *   only "an error with Resend servers", never whether the email was queued), or `409` (another
 *   request with the same idempotency key in flight, or one already processed under it with another
 *   body — either way the email may have gone).
 */
export type SendOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; code: 'unconfigured' | 'refused4xx' | 'rateLimited' }
  | { kind: 'unknown'; code: 'threw' | 'timeout' | 'server5xx' | 'conflict409' };

/** How long one request to Resend may take before its answer is treated as lost. */
export const SEND_TIMEOUT_MS = 20_000;

type SendOptions = {
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
  /**
   * The sender, when it isn't the general one (`RESEND_FROM_EMAIL`): a support reply goes out from
   * `SUPPORT_FROM_EMAIL` (B01-5f, D284). A caller that passes it has already refused to send without
   * it, so an empty value here is skipped like a missing key — never quietly sent from the general
   * address.
   */
  from?: string;
  /**
   * Where the person's answer goes, sent as Resend's `reply_to`; absent, the request carries none. Only
   * a support reply passes it, from `SUPPORT_REPLY_TO_EMAIL` (`lib/supportThread.supportReplyTo`), so
   * a skater's answer reaches a mailbox rather than the send-only support sender. Every other email
   * is sent without it ({@link sendEmail} doesn't take it).
   */
  replyTo?: string;
  /**
   * Resend's `Idempotency-Key` (1–256 characters; Resend keeps it 24 hours): a repeat of the same
   * request under it gets the first answer and sends nothing again. A support reply sends one derived
   * from its message's id.
   */
  idempotencyKey?: string;
};

/**
 * Send one email and say what became of it ({@link SendOutcome}). Never throws: every caller is
 * scheduled off a mutation that has already committed, so a mail failure must not roll anything back.
 */
export async function sendEmailOutcome(opts: SendOptions): Promise<SendOutcome> {
  const key = process.env.RESEND_API_KEY;
  const from = opts.from !== undefined ? opts.from : process.env.RESEND_FROM_EMAIL;
  if (!key || !from || !opts.to) {
    console.warn(
      `${opts.context} email skipped (Resend env not configured): ${opts.subject} — set RESEND_API_KEY / ${opts.from !== undefined ? 'the sender' : 'RESEND_FROM_EMAIL'} to enable.`,
    );
    return { kind: 'rejected', code: 'unconfigured' };
  }

  const body = JSON.stringify({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
  });
  try {
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
          },
          body,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return { kind: 'accepted' };
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res)));
        continue;
      }
      console.warn(`Resend ${opts.context} failed: ${res.status} ${res.statusText}`);
      if (res.status >= 500) return { kind: 'unknown', code: 'server5xx' };
      if (res.status === 409) return { kind: 'unknown', code: 'conflict409' };
      if (res.status === 429) return { kind: 'rejected', code: 'rateLimited' };
      return { kind: 'rejected', code: 'refused4xx' };
    }
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    const timedOut = name === 'AbortError' || name === 'TimeoutError';
    console.warn(`Resend ${opts.context} ${timedOut ? 'timed out' : 'threw'}`, err);
    return { kind: 'unknown', code: timedOut ? 'timeout' : 'threw' };
  }
}

/**
 * Send one email; whether Resend accepted it — the boolean every other caller has always read
 * (operator mail, notification email, the data export's mail), unchanged: `true` only for
 * `accepted`. One implementation underneath ({@link sendEmailOutcome}); a caller that records an
 * outcome a person reads asks that instead.
 */
export async function sendEmail(
  opts: Omit<SendOptions, 'idempotencyKey' | 'replyTo'>,
): Promise<boolean> {
  return (await sendEmailOutcome(opts)).kind === 'accepted';
}
