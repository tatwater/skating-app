import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sendEmail } from './resend';

const mail = { to: 'a@example.test', subject: 's', html: '<p>s</p>', text: 's', context: 'test' };

function reply(status: number, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => (name === 'retry-after' ? (retryAfter ?? null) : null) },
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_FROM_EMAIL', 'Gli <updates@example.test>');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sendEmail (rate limit)', () => {
  test('a 429 is retried after Retry-After, and the send counts once it lands', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(429, '1'))
      .mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetchImpl);
    const pending = sendEmail(mail);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a 429 that never clears gives up after the retry budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(429));
    vi.stubGlobal('fetch', fetchImpl);
    const pending = sendEmail(mail);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('any other failure is not retried', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(500));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await sendEmail(mail)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a Retry-After that is missing or silly is bounded, not obeyed', async () => {
    // No header ⇒ the 1 s default; "3600" ⇒ the 5 s cap. Either way the send lands on the retry.
    for (const header of [undefined, '3600']) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(reply(429, header))
        .mockResolvedValueOnce(reply(200));
      vi.stubGlobal('fetch', fetchImpl);
      const pending = sendEmail(mail);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });
});

describe('sendEmail (never throws, never sends without a provider)', () => {
  test('an unconfigured provider skips with a warning and reports false — a dev without keys still deploys', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    expect(await sendEmail(mail)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an empty recipient is a skip, not a request', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    expect(await sendEmail({ ...mail, to: '' })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a thrown fetch is caught and reported false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await sendEmail(mail)).toBe(false);
  });

  test('headers ride along only when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200));
    vi.stubGlobal('fetch', fetchImpl);
    await sendEmail(mail);
    await sendEmail({ ...mail, headers: { 'List-Unsubscribe': '<https://x>' } });
    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>,
    );
    expect(bodies[0]).not.toHaveProperty('headers');
    expect(bodies[1]?.headers).toEqual({ 'List-Unsubscribe': '<https://x>' });
  });
});
