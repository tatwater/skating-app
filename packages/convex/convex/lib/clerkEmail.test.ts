import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clerkEmailForSubject } from './clerkEmail';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('clerkEmailForSubject (the mirror’s fallback)', () => {
  test('picks the primary address, not the first one Clerk happens to list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      reply(200, {
        primary_email_address_id: 'e2',
        email_addresses: [
          { id: 'e1', email_address: 'work@example.test' },
          { id: 'e2', email_address: 'home@example.test' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    expect(await clerkEmailForSubject('user_1')).toBe('home@example.test');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/users/user_1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
  });

  test('falls back to the first address when the primary pointer matches nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply(200, {
          primary_email_address_id: 'gone',
          email_addresses: [{ id: 'e1', email_address: 'only@example.test' }],
        }),
      ),
    );
    expect(await clerkEmailForSubject('user_1')).toBe('only@example.test');
  });

  test('a user with no addresses is null, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {})));
    expect(await clerkEmailForSubject('user_1')).toBeNull();
  });

  test('a non-2xx answer and a thrown fetch both log and return null — a mail lookup never aborts a fan-out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(404, {})));
    expect(await clerkEmailForSubject('user_1')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await clerkEmailForSubject('user_1')).toBeNull();
  });

  test('no key or no subject means no request at all', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    expect(await clerkEmailForSubject('')).toBeNull();
    vi.stubEnv('CLERK_SECRET_KEY', '');
    expect(await clerkEmailForSubject('user_1')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
