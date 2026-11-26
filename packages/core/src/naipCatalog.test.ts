import { describe, expect, test, vi } from 'vitest';
import {
  NAIP_SAS_URL,
  NAIP_STAC_URL,
  NaipSasSigner,
  naipItemToCandidate,
  parseNaipItemId,
  walkNaipState,
} from './naipCatalog';

describe('parseNaipItemId', () => {
  test.each([
    [
      'vt_m_4507264_sw_18_030_20250920',
      { prefix: 'VT', key: '4507264sw', utmZone: 18, acquired: '2025-09-20', processed: null },
    ],
    // A second date is the processing day, never the flight's.
    [
      'me_m_4407028_ne_19_030_20231002_20240103',
      {
        prefix: 'ME',
        key: '4407028ne',
        utmZone: 19,
        acquired: '2023-10-02',
        processed: '2024-01-03',
      },
    ],
    // The resolution token varies by year and is not read.
    [
      'ny_m_4307304_ne_18_1_20110501_20111115',
      expect.objectContaining({ key: '4307304ne', acquired: '2011-05-01' }),
    ],
    ['ct_m_4107125_sw_19_.6_20160703_20160913', expect.objectContaining({ key: '4107125sw' })],
    ['vt_m_4307314_ne_18_h_20160727', expect.objectContaining({ key: '4307314ne', utmZone: 18 })],
  ])('%s', (id, read) => {
    expect(parseNaipItemId(id)).toEqual(read);
  });

  test.each([
    '',
    'vt_m_4507264_sw_18_030',
    'vt_m_4507200_sw_18_030_20250920', // quad 0
    'vt_m_4507264_xx_18_030_20250920',
    'VT_m_4507264_sw_18_030_20250920',
    'vt_m_4507264_sw_18_030_20250920_',
  ])('refuses %j', (id) => {
    expect(() => parseNaipItemId(id)).toThrow(/not a NAIP item id/);
  });
});

/** A STAC item as the walk's `fields` ask for it. */
function item(id: string, over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const day = /_(\d{4})(\d{2})(\d{2})(?:_\d{8})?$/.exec(id) as RegExpExecArray;
  return {
    id,
    bbox: [-72.13, 44.99, -72.05, 45.07],
    properties: {
      datetime: `${day[1]}-${day[2]}-${day[3]}T16:00:00.000000Z`,
      gsd: 0.3,
      'naip:year': day[1],
      'naip:state': id.slice(0, 2),
      ...props,
    },
    assets: { thumbnail: { href: `https://blob.example/${id}.200.jpg` } },
    ...over,
  };
}

describe('naipItemToCandidate', () => {
  test('compacts an item', () => {
    expect(naipItemToCandidate(item('vt_m_4507264_sw_18_030_20250920'))).toEqual({
      itemId: 'vt_m_4507264_sw_18_030_20250920',
      key: '4507264sw',
      state: 'VT',
      acquired: '2025-09-20',
      gsd: 0.3,
      year: 2025,
      bbox: [-72.13, 44.99, -72.05, 45.07],
      thumbnail: 'https://blob.example/vt_m_4507264_sw_18_030_20250920.200.jpg',
    });
  });

  test("rounds the catalog's float noise; reads the year as a string or a number", () => {
    const c = naipItemToCandidate(
      item(
        'ct_m_4107125_sw_19_.6_20160703_20160913',
        {},
        { gsd: 0.6000000000000024, 'naip:year': 2016 },
      ),
    );
    expect([c.gsd, c.year]).toEqual([0.6, 2016]);
  });

  test("takes the label from naip:state, the id's prefix only when absent", () => {
    // The mislabeled Maine items carry `me` both ways; the rule's envelope deals with them.
    expect(naipItemToCandidate(item('me_m_4207239_sw_18_060_20250920')).state).toBe('ME');
    const noLabel = item('nh_m_4207001_se_19_030_20230705_20231113');
    delete (noLabel.properties as Record<string, unknown>)['naip:state'];
    expect(naipItemToCandidate(noLabel).state).toBe('NH');
  });

  test('a missing thumbnail is null', () => {
    expect(
      naipItemToCandidate(item('vt_m_4507264_sw_18_030_20250920', { assets: {} })).thumbnail,
    ).toBeNull();
  });

  test.each<[string, unknown, RegExp]>([
    ['no item', null, /not a NAIP item id/],
    [
      'another state',
      item('nj_m_4007401_ne_18_060_20240702'),
      /labeled "nj", not one of the seven/,
    ],
    [
      'no datetime',
      item('vt_m_4507264_sw_18_030_20250920', {}, { datetime: undefined }),
      /no datetime/,
    ],
    [
      "a datetime that isn't the id's day",
      item('vt_m_4507264_sw_18_030_20250920', {}, { datetime: '2025-09-21T00:00:00Z' }),
      /is not the id's acquisition day 2025-09-20/,
    ],
    ['no gsd', item('vt_m_4507264_sw_18_030_20250920', {}, { gsd: 'x' }), /no gsd/],
    ['a zero gsd', item('vt_m_4507264_sw_18_030_20250920', {}, { gsd: 0 }), /no gsd/],
    [
      'no year',
      item('vt_m_4507264_sw_18_030_20250920', {}, { 'naip:year': 'n/a' }),
      /no naip:year/,
    ],
    ['no bbox', item('vt_m_4507264_sw_18_030_20250920', { bbox: [1, 2, 3] }), /no bbox/],
    [
      'a bbox of strings',
      item('vt_m_4507264_sw_18_030_20250920', { bbox: ['1', 2, 3, 4] }),
      /no bbox/,
    ],
    ['no properties', { id: 'vt_m_4507264_sw_18_030_20250920' }, /no datetime/],
  ])('refuses %s', (_, raw, message) => {
    expect(() => naipItemToCandidate(raw)).toThrow(message);
  });
});

// ── The walk, against a fake catalog ───────────────────────────────────────────────────────────

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Answer = { ok: boolean; status: number; statusText: string; json(): Promise<unknown> };

const ok = (json: unknown): Answer => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => json,
});
const fail = (status: number): Answer => ({
  ok: false,
  status,
  statusText: `E${status}`,
  json: async () => ({}),
});

/** A catalog that answers each call in turn; records what was asked. */
function fakeCatalog(answers: (Answer | Error)[]) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : null,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetchFn, calls };
}

const page = (ids: string[], next?: Record<string, unknown>) => ({
  type: 'FeatureCollection',
  features: ids.map((id) => item(id)),
  links: [{ rel: 'self', href: 'x' }, ...(next ? [{ rel: 'next', ...next }] : [])],
});

const A = 'vt_m_4507264_sw_18_030_20250920';
const B = 'vt_m_4507264_se_18_030_20250920';
const C = 'vt_m_4507263_sw_18_030_20250920';
const noSleep = async () => {};

describe('walkNaipState', () => {
  test("follows POST continuations, carrying the search's terms with the token", async () => {
    const { fetchFn, calls } = fakeCatalog([
      ok(
        page([A, B], {
          href: `${NAIP_STAC_URL}/search`,
          method: 'POST',
          body: { token: 'next:1', limit: 2 },
        }),
      ),
      ok(page([C])),
    ]);
    const pages: number[] = [];
    const walk = await walkNaipState(fetchFn, 'VT', { limit: 2, onPage: (p) => pages.push(p) });
    expect(walk.items.map((i) => i.itemId)).toEqual([A, B, C]);
    expect(walk.pages).toBe(2);
    expect(pages).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({
      url: `${NAIP_STAC_URL}/search`,
      method: 'POST',
      body: { collections: ['naip'], query: { 'naip:state': { eq: 'vt' } }, limit: 2 },
    });
    // The field list rides along, so the second page is as small as the first.
    expect(calls[1]?.body).toMatchObject({
      token: 'next:1',
      fields: expect.any(Object),
      query: { 'naip:state': { eq: 'vt' } },
    });
  });

  test('a next link without a body is a GET of its href', async () => {
    const { fetchFn, calls } = fakeCatalog([
      ok(page([A], { href: 'https://stac.example/search?token=abc' })),
      ok(page([B])),
    ]);
    const walk = await walkNaipState(fetchFn, 'vt', { stacUrl: 'https://stac.example' });
    expect(walk.items).toHaveLength(2);
    expect(calls[1]).toEqual({
      url: 'https://stac.example/search?token=abc',
      method: 'GET',
      body: null,
    });
  });

  test('a POST continuation after a GET one carries its own body', async () => {
    const { fetchFn, calls } = fakeCatalog([
      ok(page([A], { href: 'https://stac.example/search?token=abc' })),
      ok(page([B], { href: 'https://stac.example/search', method: 'post', body: { token: 'p2' } })),
      ok(page([C])),
    ]);
    expect((await walkNaipState(fetchFn, 'vt')).items).toHaveLength(3);
    expect(calls[2]).toEqual({
      url: 'https://stac.example/search',
      method: 'POST',
      body: { token: 'p2' },
    });
  });

  test('a POST continuation with no body repeats the search as it was', async () => {
    const { fetchFn, calls } = fakeCatalog([
      ok(page([A], { href: 'https://stac.example/search?page=2', method: 'POST' })),
      ok(page([B])),
    ]);
    expect((await walkNaipState(fetchFn, 'vt')).items).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
  });

  test('an item repeated across a page boundary is held once', async () => {
    const { fetchFn } = fakeCatalog([
      ok(page([A, B], { href: 'h', body: { token: 't' } })),
      ok(page([B, C])),
    ]);
    expect((await walkNaipState(fetchFn, 'vt')).items.map((i) => i.itemId)).toEqual([A, B, C]);
  });

  test('retries a 429, a 5xx and a network error with backoff, then carries on', async () => {
    const { fetchFn } = fakeCatalog([
      fail(503),
      fail(429),
      new Error('socket hang up'),
      ok(page([A])),
    ]);
    const waits: number[] = [];
    const walk = await walkNaipState(fetchFn, 'vt', { sleep: async (ms) => void waits.push(ms) });
    expect(walk.items).toHaveLength(1);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  test('gives up after its attempts, saying why', async () => {
    const { fetchFn } = fakeCatalog([fail(502), fail(502)]);
    await expect(walkNaipState(fetchFn, 'vt', { attempts: 2, sleep: noSleep })).rejects.toThrow(
      /vt page 1 failed: 502 E502/,
    );
    const thrown = fakeCatalog([new Error('ECONNRESET')]);
    await expect(walkNaipState(thrown.fetchFn, 'vt', { attempts: 1 })).rejects.toThrow(
      /ECONNRESET/,
    );
    const odd = fakeCatalog([new Error('x')].map(() => 'plain' as never));
    odd.fetchFn.mockImplementationOnce(async () => {
      throw 'plain';
    });
    await expect(walkNaipState(odd.fetchFn, 'vt', { attempts: 1 })).rejects.toThrow(
      /failed: plain/,
    );
  });

  test('a 4xx other than 429 is not retried', async () => {
    const { fetchFn } = fakeCatalog([fail(400), ok(page([A]))]);
    await expect(walkNaipState(fetchFn, 'vt', { sleep: noSleep })).rejects.toThrow(/400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('refuses a page that is not a feature collection, a next with no href, and a bad item', async () => {
    await expect(walkNaipState(fakeCatalog([ok({ type: 'x' })]).fetchFn, 'vt')).rejects.toThrow(
      /vt page 1 is not a feature collection/,
    );
    await expect(walkNaipState(fakeCatalog([ok([])]).fetchFn, 'vt')).rejects.toThrow(
      /not a feature collection/,
    );
    await expect(
      walkNaipState(fakeCatalog([ok({ features: [], links: [{ rel: 'next' }] })]).fetchFn, 'vt'),
    ).rejects.toThrow(/next link has no href/);
    await expect(
      walkNaipState(fakeCatalog([ok({ features: [{ id: 'junk' }] })]).fetchFn, 'vt'),
    ).rejects.toThrow(/not a NAIP item id/);
  });

  test('a page with no links ends the walk', async () => {
    const { fetchFn } = fakeCatalog([ok({ features: [item(A)] })]);
    expect((await walkNaipState(fetchFn, 'vt')).items).toHaveLength(1);
  });

  test('refuses to follow a next link forever', async () => {
    const loop = ok(page([A], { href: 'h', method: 'POST', body: { token: 'same' } }));
    const { fetchFn } = fakeCatalog([loop, loop, loop]);
    await expect(walkNaipState(fetchFn, 'vt', { maxPages: 2 })).rejects.toThrow(
      /still paging vt after 2 pages/,
    );
  });

  test('a catalog answering short is a failure, never a quiet answer', async () => {
    const { fetchFn } = fakeCatalog([ok(page([A, B]))]);
    await expect(walkNaipState(fetchFn, 'vt', { minItems: 3 })).rejects.toThrow(
      /answered short for vt: 2 items, expected at least 3/,
    );
    const enough = fakeCatalog([ok(page([A, B]))]);
    expect((await walkNaipState(enough.fetchFn, 'vt', { minItems: 2 })).items).toHaveLength(2);
  });

  test('never asks for more than a page of 1,000', async () => {
    const { fetchFn, calls } = fakeCatalog([ok(page([A]))]);
    await walkNaipState(fetchFn, 'vt', { limit: 5000 });
    expect(calls[0]?.body?.limit).toBe(1000);
  });

  test('waits for real between attempts by default', async () => {
    vi.useFakeTimers();
    try {
      const { fetchFn } = fakeCatalog([fail(500), ok(page([A]))]);
      const walking = walkNaipState(fetchFn, 'vt');
      await vi.advanceTimersByTimeAsync(1000);
      expect((await walking).items).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The SAS token ───────────────────────────────────────────────────────────────────────────────

describe('NaipSasSigner', () => {
  const T0 = Date.parse('2026-11-25T12:00:00Z');
  const token = (t: string, expiry: string | undefined) =>
    ok(expiry === undefined ? { token: t } : { token: t, 'msft:expiry': expiry });

  function blobStore(answers: Answer[]) {
    const asked: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      asked.push(url);
      return answers.shift() ?? fail(500);
    });
    return { fetchFn, asked };
  }

  test('fetches a token once and signs every read with it until near its expiry', async () => {
    let now = T0;
    const { fetchFn, asked } = blobStore([
      token('st=1&sig=a', '2026-11-25T13:00:00Z'),
      ok('img1'),
      ok('img2'),
      token('st=2&sig=b', '2026-11-25T14:00:00Z'),
      ok('img3'),
    ]);
    const signer = new NaipSasSigner(fetchFn, () => now);
    await signer.fetch('https://blob.example/a.jpg');
    now = T0 + 54 * 60 * 1000; // six minutes left: still good
    await signer.fetch('https://blob.example/b.jpg?x=1');
    now = T0 + 56 * 60 * 1000; // four left: renew first
    await signer.fetch('https://blob.example/c.jpg');
    expect(asked).toEqual([
      NAIP_SAS_URL,
      'https://blob.example/a.jpg?st=1&sig=a',
      'https://blob.example/b.jpg?x=1&st=1&sig=a',
      NAIP_SAS_URL,
      'https://blob.example/c.jpg?st=2&sig=b',
    ]);
  });

  test('a signed read refused with a 403 renews the token and asks once more', async () => {
    const { fetchFn, asked } = blobStore([
      token('t1', '2026-11-25T13:00:00Z'),
      fail(403),
      token('t2', '2026-11-25T13:00:00Z'),
      ok('img'),
    ]);
    const signer = new NaipSasSigner(fetchFn, () => T0, 'https://sas.example/naip');
    expect((await signer.fetch('https://blob.example/a.jpg')).ok).toBe(true);
    expect(asked).toEqual([
      'https://sas.example/naip',
      'https://blob.example/a.jpg?t1',
      'https://sas.example/naip',
      'https://blob.example/a.jpg?t2',
    ]);
  });

  test('a second refusal is the caller’s to read', async () => {
    const { fetchFn } = blobStore([
      token('t1', undefined),
      fail(403),
      token('t2', undefined),
      fail(403),
    ]);
    const res = await new NaipSasSigner(fetchFn, () => T0).fetch('https://blob.example/a.jpg');
    expect(res.status).toBe(403);
  });

  test('a token with no readable expiry is held for five minutes', async () => {
    let now = T0;
    const { fetchFn, asked } = blobStore([
      token('t1', undefined),
      ok('a'),
      ok('b'),
      token('t2', 'not a date'),
      ok('c'),
    ]);
    const signer = new NaipSasSigner(fetchFn, () => now);
    await signer.fetch('https://blob.example/a.jpg');
    now = T0 + 4 * 60 * 1000;
    await signer.fetch('https://blob.example/b.jpg');
    now = T0 + 5 * 60 * 1000;
    await signer.fetch('https://blob.example/c.jpg');
    expect(asked.filter((u) => u === NAIP_SAS_URL)).toHaveLength(2);
  });

  test.each<[string, Answer, RegExp]>([
    ['refused', fail(503), /SAS token refused: 503/],
    ['tokenless', ok({ 'msft:expiry': '2026-11-25T13:00:00Z' }), /has no token/],
    ['empty', ok({ token: '' }), /has no token/],
    ['not an object', ok('token'), /has no token/],
  ])('a %s token answer throws', async (_, answer, message) => {
    const { fetchFn } = blobStore([answer]);
    await expect(
      new NaipSasSigner(fetchFn, () => T0).fetch('https://blob.example/a.jpg'),
    ).rejects.toThrow(message);
  });

  test('uses the real clock by default', async () => {
    const { fetchFn } = blobStore([token('t', '2999-01-01T00:00:00Z'), ok('a'), ok('b')]);
    const signer = new NaipSasSigner(fetchFn);
    await signer.fetch('https://blob.example/a.jpg');
    await signer.fetch('https://blob.example/b.jpg');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
