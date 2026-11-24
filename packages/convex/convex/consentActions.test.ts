/**
 * The two actions a consent record's write schedules (B03 §9.2 R4 and R8): the IP read from the
 * caller's Clerk session, and the emailed copy of the terms. Both fill their field once and never
 * throw. Clerk and Resend are stubbed; nothing asserts on the wall clock.
 */

import { TERMS, TERMS_SHA256, termsVersionLabel } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { TERMS_COPY_SUBJECT, termsCopyEmail } from './consent';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const SUBJECT = 'user_ada';
const RECORDED_AT = Date.UTC(2026, 10, 24, 15);

type T = ReturnType<typeof convexTest>;

/** A profile and its terms record, as an acceptance leaves them (both actions still owed). */
async function world(email?: string) {
  const t = convexTest(schema, modules);
  const profileId = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: SUBJECT,
      displayName: 'Ada Lovelace',
      username: 'ada',
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
      dateOfBirth: Date.UTC(1990, 0, 1),
      // The retired acknowledgment (D45), as an account from before the terms carries it.
      riskAckVersion: '2026-07-11',
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: RECORDED_AT,
      termsVersion: TERMS.version,
      termsAcceptedAt: RECORDED_AT,
    }),
  );
  const recordId = await t.run((ctx) =>
    ctx.db.insert('consentRecords', {
      kind: 'terms',
      profileId,
      clerkUserId: SUBJECT,
      identity: {
        fullName: 'Ada Lovelace',
        ...(email !== undefined ? { email } : {}),
        dateOfBirth: Date.UTC(1990, 0, 1),
      },
      version: TERMS.version,
      contentHash: TERMS_SHA256,
      context: 'first_run',
      recordedAt: RECORDED_AT,
      surface: { value: 'web', source: 'client_reported' },
      ipStatus: 'pending',
      copyEmail: { status: 'pending' },
    }),
  );
  const record = () => t.run((ctx) => ctx.db.get(recordId));
  return { t, profileId, recordId, record, as: t.withIdentity({ subject: SUBJECT }) };
}

/** A Clerk session as the Backend API answers one. */
function session(id: string, userId: string, lastActiveAt: number, ip?: string) {
  return {
    object: 'session',
    id,
    user_id: userId,
    status: 'active',
    last_active_at: lastActiveAt,
    ...(ip !== undefined ? { latest_activity: { ip_address: ip } } : { latest_activity: null }),
  };
}

type Reply = { status: number; body?: unknown } | 'throw';

/** Each request seen, by URL, with its headers and body. */
const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];

/** Answer Clerk and Resend from a route table: the first key the URL contains wins. */
function stubFetch(routes: Record<string, Reply>) {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const reply = key === undefined ? { status: 599 } : (routes[key] as Reply);
      if (reply === 'throw') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x');
  vi.stubEnv('RESEND_API_KEY', 're_test_x');
  vi.stubEnv('RESEND_FROM_EMAIL', 'Gli <updates@example.test>');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const capture = (t: T, recordId: Id<'consentRecords'>, hints: Record<string, string> = {}) =>
  t.action(internal.consent.captureIp, { recordId, clerkUserId: SUBJECT, ...hints });

describe('captureIp', () => {
  test('no key: unavailable, and Clerk is never asked', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '');
    stubFetch({});
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_1' });
    expect(seen).toEqual([]);
    expect(await record()).toMatchObject({ ipStatus: 'unavailable', ipUnavailable: 'no_key' });
    expect((await record())?.ip).toBeUndefined();
  });

  test("the client's session, verified as the caller's: captured as client_session", async () => {
    stubFetch({
      '/v1/sessions/sess_1': { status: 200, body: session('sess_1', SUBJECT, 5, '203.0.113.7') },
    });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_1' });
    const r = await record();
    expect(r).toMatchObject({
      ipStatus: 'captured',
      ip: { address: '203.0.113.7', source: 'clerk_session_activity', match: 'client_session' },
    });
    expect(typeof r?.ip?.fetchedAt).toBe('number');
    expect(seen.map((s) => s.url)).toEqual(['https://api.clerk.com/v1/sessions/sess_1']);
    expect(seen[0]?.headers.Authorization).toBe('Bearer sk_test_x');
  });

  test("a token's sid is preferred over the client's session", async () => {
    stubFetch({
      '/v1/sessions/sess_tok': {
        status: 200,
        body: session('sess_tok', SUBJECT, 9, '198.51.100.1'),
      },
      '/v1/sessions/sess_cli': {
        status: 200,
        body: session('sess_cli', SUBJECT, 9, '198.51.100.2'),
      },
    });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { tokenSessionId: 'sess_tok', clientSessionId: 'sess_cli' });
    expect((await record())?.ip).toMatchObject({ address: '198.51.100.1', match: 'token_sid' });
  });

  test("someone else's session id falls back to the caller's most recently active session", async () => {
    stubFetch({
      '/v1/sessions/sess_other': {
        status: 200,
        body: session('sess_other', 'user_mallory', 99, '192.0.2.66'),
      },
      '/v1/sessions?': {
        status: 200,
        body: [
          session('sess_a', SUBJECT, 10, '192.0.2.10'),
          session('sess_b', SUBJECT, 30, '192.0.2.30'),
          session('sess_x', 'user_mallory', 50, '192.0.2.50'),
          session('sess_c', SUBJECT, 20, '192.0.2.20'),
        ],
      },
    });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_other' });
    expect((await record())?.ip).toMatchObject({
      address: '192.0.2.30',
      match: 'most_recent_session',
    });
    const list = seen.find((s) => s.url.includes('/v1/sessions?'));
    expect(list?.url).toContain(`user_id=${SUBJECT}`);
    expect(list?.url).toContain('status=active');
  });

  test("a session Clerk doesn't know falls back too, and the list's paginated shape is read", async () => {
    stubFetch({
      '/v1/sessions/sess_gone': { status: 404, body: { errors: [] } },
      '/v1/sessions?': {
        status: 200,
        body: { data: [session('sess_a', SUBJECT, 1, '192.0.2.1')] },
      },
    });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_gone' });
    expect((await record())?.ip).toMatchObject({
      address: '192.0.2.1',
      match: 'most_recent_session',
    });
  });

  test('no session at all: unavailable, no_session', async () => {
    stubFetch({ '/v1/sessions?': { status: 200, body: [] } });
    const { t, recordId, record } = await world();
    await capture(t, recordId);
    expect(await record()).toMatchObject({ ipStatus: 'unavailable', ipUnavailable: 'no_session' });
  });

  test('a session with no activity: unavailable, no_activity', async () => {
    stubFetch({ '/v1/sessions/sess_1': { status: 200, body: session('sess_1', SUBJECT, 5) } });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_1' });
    expect(await record()).toMatchObject({ ipStatus: 'unavailable', ipUnavailable: 'no_activity' });
  });

  test('an error from Clerk is an error, never a guess — and never a throw', async () => {
    const cases: Record<string, Reply>[] = [
      { '/v1/sessions/sess_1': { status: 500 } },
      { '/v1/sessions/sess_1': 'throw' },
      { '/v1/sessions?': { status: 401 } },
    ];
    for (const routes of cases) {
      stubFetch(routes);
      const { t, recordId, record } = await world();
      await expect(
        capture(t, recordId, '/v1/sessions/sess_1' in routes ? { clientSessionId: 'sess_1' } : {}),
      ).resolves.toBeNull();
      expect(await record()).toMatchObject({ ipStatus: 'unavailable', ipUnavailable: 'error' });
    }
  });

  test('a malformed session id is never put in a request path', async () => {
    stubFetch({ '/v1/sessions?': { status: 200, body: [session('s', SUBJECT, 1, '192.0.2.9')] } });
    const { t, recordId } = await world();
    await capture(t, recordId, { clientSessionId: '../users/user_x' });
    expect(seen.map((s) => s.url)).toEqual([
      `https://api.clerk.com/v1/sessions?user_id=${SUBJECT}&status=active`,
    ]);
  });

  test('fill-once: a second capture changes nothing, and a gone record is a no-op', async () => {
    stubFetch({
      '/v1/sessions/sess_1': { status: 200, body: session('sess_1', SUBJECT, 5, '192.0.2.1') },
    });
    const { t, recordId, record } = await world();
    await capture(t, recordId, { clientSessionId: 'sess_1' });
    const first = await record();
    stubFetch({
      '/v1/sessions/sess_1': { status: 200, body: session('sess_1', SUBJECT, 6, '192.0.2.2') },
    });
    await capture(t, recordId, { clientSessionId: 'sess_1' });
    expect((await record())?.ip).toEqual(first?.ip);
    await t.mutation(internal.consent.setIp, { recordId, unavailable: 'error' });
    expect((await record())?.ipStatus).toBe('captured');
    await t.run((ctx) => ctx.db.delete(recordId));
    await expect(capture(t, recordId, { clientSessionId: 'sess_1' })).resolves.toBeNull();
  });

  test('setIp without an address or a reason records an error', async () => {
    const { t, recordId, record } = await world();
    await t.mutation(internal.consent.setIp, { recordId });
    expect(await record()).toMatchObject({ ipStatus: 'unavailable', ipUnavailable: 'error' });
  });
});

describe('sendTermsCopy', () => {
  const send = (t: T, recordId: Id<'consentRecords'>) =>
    t.action(internal.consent.sendTermsCopy, { recordId, clerkUserId: SUBJECT });

  test('accepted: sent to the record’s address under the record id, and the receipt reads sent', async () => {
    stubFetch({ 'api.resend.com': { status: 200, body: { id: 'em_1' } } });
    const { t, recordId, record, as } = await world('ada@example.test');
    await send(t, recordId);
    const r = await record();
    expect(r?.copyEmail?.status).toBe('accepted');
    expect(typeof r?.copyEmail?.at).toBe('number');
    const request = seen.find((s) => s.url.includes('api.resend.com'));
    expect(request?.headers['Idempotency-Key']).toBe(recordId);
    const body = JSON.parse(request?.body ?? '{}') as Record<string, string>;
    expect(body).toMatchObject({ to: 'ada@example.test', subject: TERMS_COPY_SUBJECT });
    expect(body.text).toContain(termsVersionLabel(TERMS));
    expect(body.text).toContain('1. Gli is not a safety authority');
    expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
      email: 'ada@example.test',
      copy: 'sent',
    });
  });

  test('a definite refusal is rejected (not_sent); a lost answer is unknown (sent: it may have gone)', async () => {
    for (const [status, outcome, copy] of [
      [422, 'rejected', 'not_sent'],
      [500, 'unknown', 'sent'],
    ] as const) {
      stubFetch({ 'api.resend.com': { status } });
      const { t, recordId, record, as } = await world('ada@example.test');
      await send(t, recordId);
      expect((await record())?.copyEmail?.status).toBe(outcome);
      expect((await as.query(api.consent.latestTermsReceipt, {}))?.copy).toBe(copy);
    }
  });

  test('no Resend key: rejected, nothing sent', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    stubFetch({});
    const { t, recordId, record } = await world('ada@example.test');
    await send(t, recordId);
    expect(seen).toEqual([]);
    expect((await record())?.copyEmail?.status).toBe('rejected');
  });

  test('no address on the record: Clerk’s is used, and filled onto the record once', async () => {
    stubFetch({
      '/v1/users/': {
        status: 200,
        body: {
          primary_email_address_id: 'e1',
          email_addresses: [{ id: 'e1', email_address: 'ada@clerk.test' }],
        },
      },
      'api.resend.com': { status: 200 },
    });
    const { t, recordId, record, as } = await world();
    await send(t, recordId);
    expect(await record()).toMatchObject({
      identity: { fullName: 'Ada Lovelace', email: 'ada@clerk.test' },
      copyEmail: { status: 'accepted' },
    });
    expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
      email: 'ada@clerk.test',
      copy: 'sent',
    });
  });

  test('no address anywhere — Clerk has none, or can’t be asked — is rejected, with nothing sent', async () => {
    for (const reply of [{ status: 404 }, { status: 500 }, 'throw' as const]) {
      stubFetch({ '/v1/users/': reply, 'api.resend.com': { status: 200 } });
      const { t, recordId, record, as } = await world();
      await send(t, recordId);
      expect(seen.some((s) => s.url.includes('api.resend.com'))).toBe(false);
      expect((await record())?.copyEmail?.status).toBe('rejected');
      expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
        email: null,
        copy: 'not_sent',
      });
    }
  });

  test('fill-once: a settled copy is never sent again, and a gone record is a no-op', async () => {
    stubFetch({ 'api.resend.com': { status: 200 } });
    const { t, recordId, record } = await world('ada@example.test');
    await send(t, recordId);
    const settled = await record();
    seen.length = 0;
    await send(t, recordId);
    expect(seen).toEqual([]);
    await t.mutation(internal.consent.setCopyOutcome, { recordId, status: 'rejected' });
    expect((await record())?.copyEmail).toEqual(settled?.copyEmail);
    await t.run((ctx) => ctx.db.delete(recordId));
    await expect(send(t, recordId)).resolves.toBeNull();
  });

  test('a pending outcome is never written, and an address is filled only where none was', async () => {
    const { t, recordId, record } = await world('ada@example.test');
    await t.mutation(internal.consent.setCopyOutcome, { recordId, status: 'pending' });
    expect((await record())?.copyEmail).toEqual({ status: 'pending' });
    await t.mutation(internal.consent.setCopyOutcome, {
      recordId,
      status: 'accepted',
      email: 'other@example.test',
    });
    expect((await record())?.identity.email).toBe('ada@example.test');
  });

  test('the copy is the terms with their version line and no times', () => {
    const { subject, html, text } = termsCopyEmail();
    expect(subject).toBe(TERMS_COPY_SUBJECT);
    expect(text.split('\n\n')[1]).toBe(termsVersionLabel(TERMS));
    expect(html).toContain(
      '<strong>It does not tell you whether ice is safe, and it never will.</strong>',
    );
    // No clock: nothing in the copy looks like a time of day.
    expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });
});
