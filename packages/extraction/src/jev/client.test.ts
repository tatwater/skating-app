import { afterEach, describe, expect, it } from 'vitest';
import { createJevClient, JEV_RETRIES, retryDelayMs } from './client';

const OK = { model: 'jev', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
const reply = (status: number, body: unknown = OK) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createJevClient — retries a busy service, not a bad request (A10-9)', () => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  afterEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
  });

  it('retries 503 / 529 / a dropped connection with backoff, then answers', async () => {
    const script: (() => Response)[] = [
      () => reply(503),
      () => {
        throw new TypeError('fetch failed');
      },
      () => reply(529),
      () => reply(200),
    ];
    const waits: number[] = [];
    const client = createJevClient(
      (async () => (script.shift() as () => Response)()) as unknown as typeof fetch,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(await client.ask('state', {})).toEqual(OK);
    expect(waits).toEqual([retryDelayMs(0), retryDelayMs(1), retryDelayMs(2)]);
  });

  it('gives up after the last retry, and never retries a 400', async () => {
    let calls = 0;
    const busy = createJevClient(
      (async () => {
        calls++;
        return reply(503, { error: 'busy' });
      }) as unknown as typeof fetch,
      async () => {},
    );
    await expect(busy.ask('s', {})).rejects.toThrow(/Jev 503/);
    expect(calls).toBe(JEV_RETRIES + 1);
    calls = 0;
    const bad = createJevClient(
      (async () => {
        calls++;
        return reply(400, { error: 'bad question' });
      }) as unknown as typeof fetch,
      async () => {},
    );
    await expect(bad.ask('s', {})).rejects.toThrow(/Jev 400/);
    expect(calls).toBe(1);
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
  });
});
