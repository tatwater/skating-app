/**
 * What the email → code flow knows about a failure: a word from a closed vocabulary, never Clerk's
 * text. Clerk API errors now pass through our code (B03 §4.3), and their messages are Clerk's prose
 * about someone's address. Reading only the machine `code` means an email or a code value has no way
 * to reach the screen, a log line, or an event by accident; `authSentry.test.tsx` proves the wire.
 */

export type AuthFailure =
  | 'invalid_email'
  | 'unknown_email'
  | 'email_taken'
  | 'wrong_code'
  | 'expired_code'
  | 'too_many_tries'
  | 'rate_limited'
  | 'captcha'
  /** Clerk accepted the step but won't finish: a required field, a session task, a second factor. */
  | 'incomplete'
  /** The headless test path's sign-in token didn't work. */
  | 'ticket'
  | 'unreachable';

export type AuthOutcome = { ok: true } | { ok: false; failure: AuthFailure };

export const OK: AuthOutcome = { ok: true };
export const failed = (failure: AuthFailure): AuthOutcome => ({ ok: false, failure });

/** Clerk's error codes, as far as this flow can say something more useful than "try again". */
const CLERK_CODES: Readonly<Record<string, AuthFailure>> = {
  form_identifier_not_found: 'unknown_email',
  form_identifier_exists: 'email_taken',
  form_param_format_invalid: 'invalid_email',
  form_param_nil: 'invalid_email',
  form_code_incorrect: 'wrong_code',
  verification_expired: 'expired_code',
  verification_failed: 'too_many_tries',
  too_many_requests: 'rate_limited',
  captcha_invalid: 'captcha',
  captcha_missing_token: 'captcha',
  captcha_unavailable: 'captcha',
  // A retry after a dead end says "already verified"; the real cause is whatever blocked it.
  verification_already_verified: 'incomplete',
};

/** The code off whatever shape arrived: an API response error's first entry, or the error's own. */
function clerkCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { errors, code } = error as { errors?: unknown; code?: unknown };
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const nested =
    typeof first === 'object' && first !== null ? (first as { code?: unknown }).code : undefined;
  if (typeof nested === 'string') return nested;
  return typeof code === 'string' ? code : undefined;
}

/** Anything unrecognized, a network failure included, is `unreachable`: the honest generic. */
export function classifyClerkError(error: unknown): AuthFailure {
  const code = clerkCode(error);
  return (
    (code !== undefined && Object.hasOwn(CLERK_CODES, code) && CLERK_CODES[code]) || 'unreachable'
  );
}

/** Every failure's words. Constants, so nothing typed or returned can appear in them. */
export const FAILURE_COPY: Readonly<Record<AuthFailure, string>> = {
  invalid_email: 'Enter a full email address, like you@example.com.',
  unknown_email: 'There’s no Gli account for that email. Check the spelling, or create an account.',
  email_taken: 'There’s already a Gli account for that email. Sign in instead.',
  wrong_code: 'That code doesn’t match. Check the newest email from Gli, or send a new code.',
  expired_code: 'That code has expired. Send a new code.',
  too_many_tries: 'Too many tries with that code. Send a new code.',
  rate_limited: 'Too many tries. Wait a minute, then try again.',
  captcha: 'We couldn’t confirm you’re a person. Reload this page and try again.',
  incomplete: 'We couldn’t finish setting up your sign-in. Try again in a little while.',
  ticket: 'That sign-in link didn’t work. Enter your email to get a code.',
  unreachable: 'Couldn’t reach Gli. Check your connection and try again.',
};

const EMAIL_FIELD: ReadonlySet<AuthFailure> = new Set([
  'invalid_email',
  'unknown_email',
  'email_taken',
]);
const CODE_FIELD: ReadonlySet<AuthFailure> = new Set([
  'wrong_code',
  'expired_code',
  'too_many_tries',
]);

/** Where a failure is said: under the field it's about, or on its own line above the action. */
export function failurePlace(failure: AuthFailure): 'email' | 'code' | 'form' {
  if (EMAIL_FIELD.has(failure)) return 'email';
  if (CODE_FIELD.has(failure)) return 'code';
  return 'form';
}

/** Enough to be worth sending; Clerk has the last word. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** How long before another code can be asked for, in seconds. */
export const RESEND_COOLDOWN_S = 30;

/** `24` → `0:24`. */
export function formatCooldown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const TICKET_PARAM = '__clerk_ticket';

/** The headless test path's sign-in token, if this URL carries one (`POST /v1/sign_in_tokens`). */
export function ticketFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(TICKET_PARAM) || null;
}

/** The same URL without the token, which is single-use and shouldn't linger in history. */
export function withoutTicket(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const params = new URLSearchParams(location.search);
  params.delete(TICKET_PARAM);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
}
