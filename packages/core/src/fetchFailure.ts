/**
 * **Why a cron's piece of work failed** (D345, D349, B01-8c): the one vocabulary a weather job sorts
 * its failures by, so a run row carries *3 · timed out* rather than three log lines, and the page's
 * words are the web's.
 *
 * - `timeout` — an attempt's deadline passed, or Convex's fetch timed out.
 * - `rateLimit` — HTTP 429.
 * - `serverError` — any 5xx.
 * - `refused` — any other 4xx.
 * - `unreachable` — the connection failed (DNS, reset, refused socket).
 * - `badAnswer` — the body didn't parse, or was cut off.
 * - `emptyAnswer` — a 200 with no usable hour.
 * - `writeFailed` — a Convex write threw (a write conflict, a limit).
 * - `other` — anything else.
 *
 * Single-sourced here; the Convex package's `lib/enums.ts` re-exports it for the schema.
 */

export const CRON_FAILURE_CAUSES = [
  'timeout',
  'rateLimit',
  'serverError',
  'refused',
  'unreachable',
  'badAnswer',
  'emptyAnswer',
  'writeFailed',
  'other',
] as const;
export type CronFailureCause = (typeof CRON_FAILURE_CAUSES)[number];

/** A sample's text, in characters: the recorder trims to it. */
export const CRON_CAUSE_SAMPLE_MAX = 300;

/**
 * One cause's tally on a run: how many items failed for it, and the first one seen. `sampleKey` is a
 * cell key, a state code or a hazard id — never content.
 */
export interface CronCauseTally {
  cause: CronFailureCause;
  count: number;
  sampleKey?: string;
  sampleText: string;
  sampleAt: number;
}

/** What a failed piece of work looked like: an HTTP status, a thrown value, or a 200 with nothing in it. */
export interface FetchFailure {
  status?: number;
  error?: unknown;
  empty?: boolean;
}

/** A status that is an HTTP status code (an integer 100–599), else `null`. */
function httpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/** A status's cause, or `null` for a 2xx (no failure by status: the body decides) or a 1xx/3xx. */
function statusCause(status: number): CronFailureCause | null {
  if (status === 429) return 'rateLimit';
  if (status >= 500) return 'serverError';
  if (status >= 400) return 'refused';
  return null;
}

/** How deep a thrown value's `cause` chain is followed (Node's `fetch failed` hides its reason there). */
const CAUSE_DEPTH = 4;

/** A thrown value and its causes, each as its name, code, message and any HTTP status it carries. */
function errorLinks(
  error: unknown,
): { name: string; code: string; message: string; status: number | null }[] {
  const out: { name: string; code: string; message: string; status: number | null }[] = [];
  let at: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && at !== undefined && at !== null; depth++) {
    if (typeof at === 'object' || typeof at === 'function') {
      const o = at as Record<string, unknown>;
      const read = (k: string) => {
        try {
          return o[k];
        } catch {
          return undefined;
        }
      };
      const name = read('name');
      const code = read('code');
      const message = read('message');
      out.push({
        name: typeof name === 'string' ? name : '',
        code: typeof code === 'string' ? code : '',
        message: typeof message === 'string' ? message : '',
        status: httpStatus(read('status')) ?? httpStatus(read('statusCode')),
      });
      at = read('cause');
    } else {
      out.push({ name: '', code: '', message: String(at), status: null });
      at = undefined;
    }
  }
  return out;
}

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);
const TIMEOUT_TEXT = /\btime[sd]?[ -]?out\b|\btimeout\b|\bdeadline\b|\baborted\b/i;
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);
const UNREACHABLE_TEXT =
  /fetch failed|failed to fetch|network ?error|socket hang up|getaddrinfo|connection (?:refused|reset|closed)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i;
/** Convex's words when a write threw: a write conflict, or a transaction limit. */
const WRITE_TEXT =
  /OptimisticConcurrencyControlFailure|changed while this mutation was being run|write conflict|Too many (?:reads|writes|documents|bytes|index ranges)|too large|maximum (?:size|length)|exceeds? the maximum|array length is too long/i;
const BAD_ANSWER_TEXT =
  /\bJSON\b|unexpected (?:end|token|character)|\bterminated\b|premature close|invalid response body|cut off|truncated|unterminated/i;

/** A thrown value's cause, or `other` when nothing in it is recognized. */
function errorCause(error: unknown): CronFailureCause {
  const links = errorLinks(error);
  // A status the error carries (an SDK's HTTP error) is the plainest word there is.
  for (const l of links) {
    const byStatus = l.status === null ? null : statusCause(l.status);
    if (byStatus !== null) return byStatus;
  }
  if (links.some((l) => TIMEOUT_NAMES.has(l.name) || TIMEOUT_CODES.has(l.code))) return 'timeout';
  if (links.some((l) => UNREACHABLE_CODES.has(l.code))) return 'unreachable';
  if (links.some((l) => TIMEOUT_TEXT.test(l.message))) return 'timeout';
  if (links.some((l) => UNREACHABLE_TEXT.test(l.message))) return 'unreachable';
  if (links.some((l) => WRITE_TEXT.test(l.message))) return 'writeFailed';
  if (links.some((l) => l.name === 'SyntaxError' || BAD_ANSWER_TEXT.test(l.message))) {
    return 'badAnswer';
  }
  return 'other';
}

/**
 * **The cause of one failure** — the one rule every weather job sorts by. Total: every input, of
 * any shape, maps to exactly one cause, and it never throws.
 *
 * 1. An HTTP `status` (an integer 100–599) decides first: 429 `rateLimit`, any 5xx `serverError`,
 *    any other 4xx `refused`. A 2xx is no failure by status, so the body decides (2–4); a 1xx or
 *    3xx is `other` unless the rest says more.
 * 2. A thrown `error`, its `cause` chain followed four deep: a status it carries (as 1); then
 *    `timeout` (an `AbortError` or `TimeoutError`, a timeout code, or words like *timed out*), then
 *    `unreachable` (a connection code, Node's *fetch failed*), then `writeFailed` (Convex's write
 *    conflict or a transaction limit), then `badAnswer` (a `SyntaxError`, a body cut off).
 * 3. `empty`: a 200 with no usable hour, `emptyAnswer`.
 * 4. Anything else: `other`.
 */
export function fetchFailureCause(failure: FetchFailure): CronFailureCause {
  const f = (typeof failure === 'object' && failure !== null ? failure : {}) as FetchFailure;
  const status = httpStatus(f.status);
  const byStatus = status === null ? null : statusCause(status);
  if (byStatus !== null) return byStatus;
  if (f.error !== undefined && f.error !== null) {
    const byError = errorCause(f.error);
    if (byError !== 'other') return byError;
  }
  if (f.empty === true) return 'emptyAnswer';
  return 'other';
}

/**
 * Strip what a sample must never carry: a URL's query string, fragment and credentials (a provider's
 * key rides there), any `key=value` pair whose name says it is a secret, and a `Bearer` or `Basic`
 * credential in any case (an auth scheme's name is case-insensitive, so `bearer abc` is one too).
 */
export function redactSample(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#][^\s]*/gi, '$1')
    .replace(
      /\b((?:api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|sig|signature|auth|key)\s*[=:]\s*)[^\s&,;]+/gi,
      '$1…',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 …');
}

/** `text` cut to `max` characters, never through a surrogate pair. */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * A failure's sample text: `HTTP 503`, the error's message (and its cause's, if it says more), or
 * *empty answer* — redacted ({@link redactSample}) and cut to {@link CRON_CAUSE_SAMPLE_MAX}. Never
 * the body, never a URL's query.
 */
export function failureSampleText(failure: FetchFailure): string {
  const f = (typeof failure === 'object' && failure !== null ? failure : {}) as FetchFailure;
  const parts: string[] = [];
  const status = httpStatus(f.status);
  if (status !== null && statusCause(status) !== null) parts.push(`HTTP ${status}`);
  if (f.error !== undefined && f.error !== null) {
    const seen = new Set<string>();
    for (const l of errorLinks(f.error)) {
      const said = l.message || l.code || l.name;
      if (said.length > 0 && !seen.has(said)) {
        seen.add(said);
        parts.push(said);
      }
    }
  }
  if (parts.length === 0 && f.empty === true) parts.push('empty answer');
  if (parts.length === 0 && status !== null) parts.push(`HTTP ${status}`);
  return trimTo(
    redactSample(parts.join(': ') || 'failed with nothing said'),
    CRON_CAUSE_SAMPLE_MAX,
  );
}

/**
 * One failure as a tally of one: its cause ({@link fetchFailureCause}), its sample text
 * ({@link failureSampleText}) and the item's key (a cell key, a state code, a hazard id). Fold a
 * step's tallies with {@link mergeCauseTallies}.
 */
export function causeTally(failure: FetchFailure, at: number, sampleKey?: string): CronCauseTally {
  return {
    cause: fetchFailureCause(failure),
    count: 1,
    ...(sampleKey !== undefined ? { sampleKey } : {}),
    sampleText: failureSampleText(failure),
    sampleAt: at,
  };
}

/**
 * **How failures by cause fold**: one entry per cause, in {@link CRON_FAILURE_CAUSES}' order, its
 * counts summed and the first sample kept (`into`'s, else the first of `add`'s). So a run holds at
 * most nine entries whatever its batches send, and the counts don't depend on the order they arrive
 * in. An entry whose cause isn't one of the nine counts as `other`; a count that isn't a finite
 * number ≥ 0 counts as 0 (its sample still kept if it is the first).
 */
export function mergeCauseTallies(
  into: readonly CronCauseTally[] | undefined,
  add: readonly CronCauseTally[] | undefined,
): CronCauseTally[] {
  const by = new Map<CronFailureCause, CronCauseTally>();
  for (const t of [...(into ?? []), ...(add ?? [])]) {
    const cause = (CRON_FAILURE_CAUSES as readonly string[]).includes(t.cause) ? t.cause : 'other';
    const count =
      typeof t.count === 'number' && Number.isFinite(t.count) && t.count > 0 ? t.count : 0;
    const had = by.get(cause);
    if (had === undefined) by.set(cause, { ...t, cause, count });
    else had.count += count;
  }
  return CRON_FAILURE_CAUSES.flatMap((c) => {
    const t = by.get(c);
    return t === undefined ? [] : [t];
  });
}
