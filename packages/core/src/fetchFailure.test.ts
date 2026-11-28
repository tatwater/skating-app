/**
 * Failures by cause (D345, D349). Mutation-checked: each mutation of `fetchFailure.ts` below was run
 * and seen to fail the tests named, then the source restored —
 *
 *  - **F1** 429 checked after the 4xx rule (`refused` first): *a status decides first*;
 *  - **F2** a 2xx read as `refused` (the status rule's `>= 400` as `>= 200`): *a 2xx is no failure
 *    by status*;
 *  - **F3** `empty` checked before the error: *each cause, from what a fetch or a write really
 *    throws* (a timed-out request that also came back empty is a timeout);
 *  - **F4** the `cause` chain not followed (depth 1): *Node's fetch failed, by its cause*;
 *  - **F5** the query-string redaction dropped: *a sample never carries a query, a credential or a
 *    secret*;
 *  - **F6** the first sample replaced by the newest: *the first sample is kept*;
 *  - **F7** an unknown cause kept as its own entry: *at most nine entries, one per cause*.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  CRON_CAUSE_SAMPLE_MAX,
  CRON_FAILURE_CAUSES,
  type CronCauseTally,
  type CronFailureCause,
  causeTally,
  failureSampleText,
  fetchFailureCause,
  mergeCauseTallies,
  redactSample,
} from './fetchFailure';

const withCode = (message: string, code: string, cause?: unknown) =>
  Object.assign(new Error(message), { code, ...(cause !== undefined ? { cause } : {}) });
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

describe('the failure causes', () => {
  test('the nine causes, in the design’s order', () => {
    expect(CRON_FAILURE_CAUSES).toEqual([
      'timeout',
      'rateLimit',
      'serverError',
      'refused',
      'unreachable',
      'badAnswer',
      'emptyAnswer',
      'writeFailed',
      'other',
    ]);
    expect(CRON_CAUSE_SAMPLE_MAX).toBe(300);
  });
});

describe('fetchFailureCause', () => {
  test('each cause, from what a fetch or a write really throws', () => {
    const cases: [Parameters<typeof fetchFailureCause>[0], CronFailureCause][] = [
      [{ error: named('TimeoutError', 'The operation was aborted due to timeout') }, 'timeout'],
      [{ error: named('AbortError', 'This operation was aborted') }, 'timeout'],
      [{ error: new Error('Your request timed out') }, 'timeout'],
      [{ status: 429 }, 'rateLimit'],
      [{ status: 503 }, 'serverError'],
      [{ status: 500, error: new Error('Unexpected end of JSON input') }, 'serverError'],
      [{ status: 404 }, 'refused'],
      [{ status: 400, empty: true }, 'refused'],
      [{ error: new TypeError('fetch failed') }, 'unreachable'],
      [{ error: withCode('getaddrinfo ENOTFOUND api.open-meteo.com', 'ENOTFOUND') }, 'unreachable'],
      [{ status: 200, error: new SyntaxError('Unexpected token < in JSON') }, 'badAnswer'],
      [{ error: new Error('terminated') }, 'badAnswer'],
      [{ status: 200, empty: true }, 'emptyAnswer'],
      [{ status: 200, empty: true, error: named('TimeoutError') }, 'timeout'],
      [{ empty: true }, 'emptyAnswer'],
      [
        {
          error: new Error(
            'Documents read from or written to the "weatherDays" table changed while this mutation was being run',
          ),
        },
        'writeFailed',
      ],
      [
        { error: new Error('Too many documents written in a single function execution') },
        'writeFailed',
      ],
      [{ error: new Error('something else') }, 'other'],
      [{}, 'other'],
      [{ status: 200 }, 'other'],
      [{ status: 302 }, 'other'],
    ];
    for (const [failure, cause] of cases)
      expect(fetchFailureCause(failure), String(failure.error ?? failure.status)).toBe(cause);
  });

  test('Node’s fetch failed, by its cause: a connect timeout is a timeout, a reset unreachable', () => {
    const timeout = new TypeError('fetch failed', {
      cause: withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'),
    });
    expect(fetchFailureCause({ error: timeout })).toBe('timeout');
    const reset = new TypeError('fetch failed', {
      cause: withCode('read ECONNRESET', 'ECONNRESET'),
    });
    expect(fetchFailureCause({ error: reset })).toBe('unreachable');
    const deep = new Error('wrapped', {
      cause: new Error('again', { cause: { status: 429, message: 'slow down' } }),
    });
    expect(fetchFailureCause({ error: deep })).toBe('rateLimit');
  });

  test('a thrown string, a null, a getter that throws: still one cause', () => {
    expect(fetchFailureCause({ error: 'request timed out' })).toBe('timeout');
    expect(fetchFailureCause({ error: null, empty: true })).toBe('emptyAnswer');
    const hostile = {
      get message(): string {
        throw new Error('no');
      },
    };
    expect(fetchFailureCause({ error: hostile })).toBe('other');
    expect(fetchFailureCause(null as never)).toBe('other');
  });

  const anyFailure = fc.record(
    {
      status: fc.oneof(fc.integer({ min: -10, max: 700 }), fc.double(), fc.constant(undefined)),
      error: fc.oneof(
        fc.anything(),
        fc.string().map((m) => new Error(m)),
        fc.constantFrom(
          named('TimeoutError'),
          new TypeError('fetch failed'),
          new SyntaxError('bad'),
          withCode('x', 'ECONNREFUSED'),
        ),
      ),
      empty: fc.oneof(fc.boolean(), fc.constant(undefined)),
    },
    { requiredKeys: [] },
  );

  test('total: any input maps to exactly one of the nine, and never throws', () => {
    fc.assert(
      fc.property(anyFailure, (f) => {
        expect(CRON_FAILURE_CAUSES).toContain(fetchFailureCause(f as never));
        expect(typeof failureSampleText(f as never)).toBe('string');
      }),
    );
  });

  test('a status decides first: 429, 5xx and other 4xx whatever else is said', () => {
    fc.assert(
      fc.property(anyFailure, fc.integer({ min: 400, max: 599 }), (f, status) => {
        const want = status === 429 ? 'rateLimit' : status >= 500 ? 'serverError' : 'refused';
        expect(fetchFailureCause({ ...(f as object), status })).toBe(want);
      }),
    );
  });

  test('a 2xx is no failure by status: the body decides', () => {
    fc.assert(
      fc.property(anyFailure, fc.integer({ min: 200, max: 299 }), (f, status) => {
        const { status: _s, ...rest } = f as { status?: unknown };
        expect(fetchFailureCause({ ...rest, status })).toBe(fetchFailureCause(rest));
      }),
    );
  });

  test('an error says more than empty: empty is the answer only when the error says nothing', () => {
    fc.assert(
      fc.property(fc.string(), (m) => {
        const error = new Error(m);
        const byError = fetchFailureCause({ error });
        expect(fetchFailureCause({ error, empty: true })).toBe(
          byError === 'other' ? 'emptyAnswer' : byError,
        );
      }),
    );
  });
});

describe('samples', () => {
  test('a sample never carries a query, a credential or a secret', () => {
    const text = redactSample(
      'GET https://user:pw@api.example.com/v1/forecast?latitude=44&apikey=SECRET#x failed; token=abc Bearer eyJhbGci.x',
    );
    expect(text).toBe('GET https://api.example.com/v1/forecast failed; token=… Bearer …');
    // An auth scheme is case-insensitive: a lowercase one hides a token just the same.
    expect(redactSample('sent bearer eyJhbGci.x and basic dXNlcjpwdw==')).toBe(
      'sent bearer … and basic …',
    );
    fc.assert(
      fc.property(
        fc.webUrl({
          withQueryParameters: true,
          withFragments: true,
          authoritySettings: { withUserInfo: true },
        }),
        (url) => {
          const out = redactSample(`failed: ${url} then`);
          expect(out).not.toMatch(/[?#]/);
          const authority = out.split('://')[1]?.split('/')[0] ?? '';
          expect(authority).not.toContain('@');
        },
      ),
    );
  });

  test('the sample text: the status, the error and its cause, or empty answer; cut to the max', () => {
    expect(failureSampleText({ status: 503 })).toBe('HTTP 503');
    expect(failureSampleText({ status: 200, empty: true })).toBe('empty answer');
    expect(
      failureSampleText({
        error: new TypeError('fetch failed', { cause: withCode('read ECONNRESET', 'ECONNRESET') }),
      }),
    ).toBe('fetch failed: read ECONNRESET');
    expect(failureSampleText({})).toBe('failed with nothing said');
    expect(failureSampleText({ status: 302 })).toBe('HTTP 302');
    expect(failureSampleText({ error: new Error('x'.repeat(900)) })).toHaveLength(
      CRON_CAUSE_SAMPLE_MAX,
    );
    expect(failureSampleText({ error: new Error(`${'x'.repeat(299)}😀`) })).toHaveLength(299);
  });

  test('causeTally: one failure as a tally of one', () => {
    expect(causeTally({ status: 429 }, 5, 'f:1:2')).toEqual({
      cause: 'rateLimit',
      count: 1,
      sampleKey: 'f:1:2',
      sampleText: 'HTTP 429',
      sampleAt: 5,
    });
    expect(causeTally({ empty: true }, 6)).not.toHaveProperty('sampleKey');
  });
});

describe('mergeCauseTallies', () => {
  const tally = (
    cause: string,
    count: number,
    sampleText = cause,
    sampleAt = 0,
  ): CronCauseTally => ({
    cause: cause as CronFailureCause,
    count,
    sampleText,
    sampleAt,
  });

  test('the first sample is kept; counts summed; the nine in order', () => {
    const merged = mergeCauseTallies(
      [tally('timeout', 2, 'first', 1)],
      [tally('rateLimit', 1), tally('timeout', 3, 'second', 2), tally('bogus', 4, 'what')],
    );
    expect(merged).toEqual([
      tally('timeout', 5, 'first', 1),
      tally('rateLimit', 1),
      { ...tally('other', 4, 'what') },
    ]);
    expect(mergeCauseTallies(undefined, [tally('other', Number.NaN)])).toEqual([tally('other', 0)]);
  });

  const tallies = fc.array(
    fc.record({
      cause: fc.oneof(fc.constantFrom(...CRON_FAILURE_CAUSES), fc.string()),
      count: fc.nat(1_000),
      sampleText: fc.string(),
      sampleAt: fc.nat(),
    }) as fc.Arbitrary<CronCauseTally>,
    { maxLength: 40 },
  );

  test('at most nine entries, one per cause; the total is the sum; folding is order-free in counts', () => {
    fc.assert(
      fc.property(tallies, tallies, (a, b) => {
        const ab = mergeCauseTallies(a, b);
        expect(ab.length).toBeLessThanOrEqual(CRON_FAILURE_CAUSES.length);
        expect(new Set(ab.map((t) => t.cause)).size).toBe(ab.length);
        const total = (xs: CronCauseTally[]) => xs.reduce((n, t) => n + t.count, 0);
        expect(total(ab)).toBe(total(a) + total(b));
        const counts = (xs: CronCauseTally[]) => xs.map((t) => [t.cause, t.count]);
        expect(counts(mergeCauseTallies(b, a))).toEqual(counts(ab));
        expect(counts(mergeCauseTallies(mergeCauseTallies([], a), b))).toEqual(counts(ab));
      }),
    );
  });
});
