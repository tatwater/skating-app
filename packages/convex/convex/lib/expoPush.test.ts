import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  chunk,
  getExpoPushReceipts,
  isDeviceNotRegistered,
  isExpoPushToken,
  PUSH_SEND_CHUNK,
  sendExpoPush,
} from './expoPush';

afterEach(() => {
  vi.unstubAllEnvs();
});

const msg = (i: number) => ({ to: `ExponentPushToken[${i}]`, title: `t${i}` });

describe('expoPush', () => {
  test('recognizes both token spellings and nothing else', () => {
    expect(isExpoPushToken('ExponentPushToken[abc]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken('fcm:abc')).toBe(false);
  });

  test('chunks to Expo’s limit and sends one request per chunk, tickets in order', async () => {
    const messages = Array.from({ length: PUSH_SEND_CHUNK + 1 }, (_, i) => msg(i));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(init?.body as string) as unknown[];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: batch.map((_, i) => ({ status: 'ok', id: `id-${i}` })) }),
      } as Response;
    });
    const tickets = await sendExpoPush(messages, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(tickets).toHaveLength(PUSH_SEND_CHUNK + 1);
    expect(tickets.every((t) => t.status === 'ok')).toBe(true);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 2)).toEqual([]);
  });

  test('a failed or thrown request yields error tickets for its chunk rather than throwing', async () => {
    const failing = vi.fn(
      async () =>
        ({ ok: false, status: 500, statusText: 'nope', json: async () => ({}) }) as Response,
    );
    const tickets = await sendExpoPush([msg(1), msg(2)], failing as unknown as typeof fetch);
    expect(tickets.map((t) => t.status)).toEqual(['error', 'error']);

    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    const thrown = await sendExpoPush([msg(1)], throwing as unknown as typeof fetch);
    expect(thrown[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('offline'),
    });

    // A short reply is padded with error tickets so the caller's index alignment holds.
    const short = vi.fn(
      async () =>
        ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) }) as Response,
    );
    const padded = await sendExpoPush([msg(1)], short as unknown as typeof fetch);
    expect(padded[0]).toMatchObject({ status: 'error', message: 'No ticket returned' });
  });

  test('sends the access token as a bearer when configured', async () => {
    vi.stubEnv('EXPO_ACCESS_TOKEN', 'secret');
    let seen: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ status: 'ok', id: 'x' }] }),
      } as Response;
    });
    await sendExpoPush([msg(1)], fetchImpl as unknown as typeof fetch);
    expect((seen?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer secret',
    );
    // The receipts call carries it too — both endpoints enforce the token once enhanced security
    // is on for the project, and a send that authenticates while the receipt check doesn't would
    // leave every dead token undetected.
    let seenReceipts: RequestInit | undefined;
    const receiptsImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenReceipts = init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: {} }),
      } as Response;
    });
    await getExpoPushReceipts(['x'], receiptsImpl as unknown as typeof fetch);
    expect((seenReceipts?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer secret',
    );
  });

  test('receipts merge across chunks and tolerate a failed or thrown request', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ data: { a: { status: 'ok' } } }),
        }) as Response,
    );
    expect(await getExpoPushReceipts(['a'], fetchImpl as unknown as typeof fetch)).toEqual({
      a: { status: 'ok' },
    });
    const failing = vi.fn(
      async () =>
        ({ ok: false, status: 500, statusText: 'nope', json: async () => ({}) }) as Response,
    );
    expect(await getExpoPushReceipts(['a'], failing as unknown as typeof fetch)).toEqual({});
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await getExpoPushReceipts(['a'], throwing as unknown as typeof fetch)).toEqual({});
    expect(await getExpoPushReceipts([], fetchImpl as unknown as typeof fetch)).toEqual({});
  });

  test('isDeviceNotRegistered reads the one error that matters', () => {
    expect(
      isDeviceNotRegistered({
        status: 'error',
        message: 'x',
        details: { error: 'DeviceNotRegistered' },
      }),
    ).toBe(true);
    expect(
      isDeviceNotRegistered({ status: 'error', message: 'x', details: { error: 'MessageTooBig' } }),
    ).toBe(false);
    expect(isDeviceNotRegistered({ status: 'ok', id: 'x' })).toBe(false);
    expect(isDeviceNotRegistered(undefined)).toBe(false);
  });
});
