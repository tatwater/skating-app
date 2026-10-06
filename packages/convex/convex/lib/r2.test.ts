import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPublicJson,
  listKeys,
  parseListObjects,
  publicExists,
  putJson,
  r2ConfigFromEnv,
} from './r2';

afterEach(() => vi.unstubAllGlobals());

const env = {
  IMAGERY_ARCHIVE_URL: 'https://imagery.example.com/',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
};

function config() {
  const result = r2ConfigFromEnv(env);
  if (!result.ok) throw new Error('unconfigured');
  return result.config;
}

describe('r2ConfigFromEnv', () => {
  it('names what is missing', () => {
    expect(r2ConfigFromEnv({})).toEqual({
      ok: false,
      missing: ['IMAGERY_ARCHIVE_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'],
    });
  });
  it('trims trailing slashes and defaults the bucket', () => {
    const c = config();
    expect(c.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(c.publicBase).toBe('https://imagery.example.com');
    expect(c.bucket).toBe('skating-imagery');
    const named = r2ConfigFromEnv({ ...env, R2_BUCKET: 'other' });
    expect(named.ok && named.config.bucket).toBe('other');
  });
});

describe('listing', () => {
  it('parses keys, truncation and the continuation token, unescaping entities', () => {
    expect(
      parseListObjects(
        '<ListBucketResult><Contents><Key>frames/a&amp;b.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t&lt;1</NextContinuationToken></ListBucketResult>',
      ),
    ).toEqual({ keys: ['frames/a&b.json'], truncated: true, next: 't<1' });
    expect(parseListObjects('<IsTruncated>false</IsTruncated>')).toEqual({
      keys: [],
      truncated: false,
      next: null,
    });
  });

  it('follows continuation tokens to the end, signed', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string) => {
        const req = input instanceof Request ? input : new Request(input);
        urls.push(req.url);
        expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/);
        return new Response(
          req.url.includes('continuation-token')
            ? '<Key>b.json</Key><IsTruncated>false</IsTruncated>'
            : '<Key>a.json</Key><IsTruncated>true</IsTruncated><NextContinuationToken>n</NextContinuationToken>',
        );
      }),
    );
    expect(await listKeys(config(), 'frames/winter-2026-27/')).toEqual(['a.json', 'b.json']);
    expect(urls[0]).toContain('https://acct.r2.cloudflarestorage.com/skating-imagery?list-type=2');
    expect(urls[0]).toContain('prefix=frames%2Fwinter-2026-27%2F');
  });

  it('refuses a listing that never ends, and reports a failed one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>',
          ),
      ),
    );
    await expect(listKeys(config(), 'p/')).rejects.toThrow(/still truncated/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })),
    );
    await expect(listKeys(config(), 'p/')).rejects.toThrow(/R2 list p\/: 403/);
  });
});

describe('reads and writes', () => {
  it('puts JSON with a trailing newline, signed', async () => {
    const seen: { method?: string; url?: string; body?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        Object.assign(seen, { method: input.method, url: input.url, body: await input.text() });
        return new Response('');
      }),
    );
    await putJson(config(), 'index/latest.json', { season: 'winter-2026-27' });
    expect(seen).toEqual({
      method: 'PUT',
      url: 'https://acct.r2.cloudflarestorage.com/skating-imagery/index/latest.json',
      body: '{"season":"winter-2026-27"}\n',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500, statusText: 'No' })),
    );
    await expect(putJson(config(), 'k', {})).rejects.toThrow(/R2 put k: 500/);
  });

  it('reads public JSON, a 404 as null, and anything else as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/missing')) return new Response('', { status: 404 });
        if (url.endsWith('/broken')) return new Response('', { status: 500, statusText: 'Err' });
        if (init?.method === 'HEAD') return new Response(null, { status: 200 });
        return new Response('{"a":1}');
      }),
    );
    const c = config();
    expect(await getPublicJson(c, 'ok')).toEqual({ a: 1 });
    expect(await getPublicJson(c, 'missing')).toBeNull();
    await expect(getPublicJson(c, 'broken')).rejects.toThrow(/archive broken: 500/);
    expect(await publicExists(c, 'ok')).toBe(true);
    expect(await publicExists(c, 'missing')).toBe(false);
    await expect(publicExists(c, 'broken')).rejects.toThrow(/archive HEAD broken: 500/);
  });
});
