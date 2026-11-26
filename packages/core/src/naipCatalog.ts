/**
 * **The NAIP catalog**, read (B05 §2.1): Microsoft Planetary Computer's STAC, walked one state at a
 * time by POST paging, each item compacted to the `NaipCandidate` the rule reads — plus the
 * anonymous SAS token its blob reads are signed with.
 *
 * Two callers, as with the rule: the select stage walks it to build a manifest, and the July check
 * (Convex) walks it to see what changed, inside one action's deadline. `fetch` is injected so the
 * CLI, Convex and a test can each hand in their own. Beside `stacSearch.ts` rather than in it: that
 * file is the live winter poll's, and the two catalogs share nothing past "follow `next`".
 *
 * ⚠ **A SAS token is a credential.** Short-lived and anonymous, but a signed URL reads the blob for
 * anyone holding it: never print, log or store one. Only `NaipSasSigner` holds the token.
 */

import { isQuarterQuadKey } from './naipGrid';
import { isNaipState, type NaipCandidate } from './naipSelection';
import type { FetchLike } from './stacSearch';

/** Planetary Computer's STAC API. Reads are anonymous. */
export const NAIP_STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1';

/** The anonymous SAS token endpoint for the `naip` collection's blobs. */
export const NAIP_SAS_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/naip';

/** Items per page: the API's ceiling. Seven states are about 70 pages. */
export const NAIP_PAGE_LIMIT = 1000;

/**
 * A cap on pages per state. New York, the largest, is ~31 pages; the cap exists so a server that
 * hands back the same `next` forever becomes an error, not a loop nobody is watching.
 */
export const NAIP_MAX_PAGES_PER_STATE = 100;

// ── Item ids ──────────────────────────────────────────────────────────────────────────────────────

/** An item id, read: `me_m_4407028_ne_19_030_20231002_20240103`. */
export interface NaipItemId {
  /** The id's state prefix, uppercased (`ME`) — the label, not where the cell lies. */
  prefix: string;
  /** The quarter-quad key, `4407028ne`. */
  key: string;
  /** The UTM zone the frame is projected in (18 or 19 in the region). */
  utmZone: number;
  /** The acquisition day, `YYYY-MM-DD`: the id's **first** date. */
  acquired: string;
  /**
   * A second date, when the id carries one: the day the frame was processed, never when it was
   * flown. A parser that took the last date would misdate every reprocessed frame.
   */
  processed: string | null;
}

const ITEM_ID = /^([a-z]{2})_m_(\d{7})_(ne|nw|se|sw)_(\d{2})_[^_]+_(\d{8})(?:_(\d{8}))?$/;

const toDay = (yyyymmdd: string): string =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * Reads a NAIP item id. The resolution token between zone and date varies by year (`030`, `060`,
 * `1`, `.6`, `h`) and is not read: `gsd` is the item's own property. Throws on anything else.
 */
export function parseNaipItemId(id: string): NaipItemId {
  const match = ITEM_ID.exec(id);
  const key = match ? `${match[2]}${match[3]}` : '';
  if (!match || !isQuarterQuadKey(key))
    throw new Error(`not a NAIP item id: ${JSON.stringify(id)}`);
  return {
    prefix: (match[1] as string).toUpperCase(),
    key,
    utmZone: Number(match[4]),
    acquired: toDay(match[5] as string),
    processed: match[6] === undefined ? null : toDay(match[6]),
  };
}

// ── Items → candidates ────────────────────────────────────────────────────────────────────────────

/** One catalog row as the select stage keeps it: the candidate, and where its thumbnail is. */
export interface NaipCatalogItem extends NaipCandidate {
  /** The 200-px catalog thumbnail's blob URL, unsigned; `null` when the item lists none. */
  thumbnail: string | null;
}

interface StacNaipItem {
  id?: unknown;
  bbox?: unknown;
  properties?: Record<string, unknown>;
  assets?: Record<string, { href?: unknown } | undefined>;
}

/**
 * One STAC item, compacted. The labeled state is `naip:state` (the id's prefix when absent); the
 * acquisition day is `datetime`'s day, checked against the id's first date; `gsd` is rounded to the
 * centimeter (the catalog carries `0.6000000000000024`); `year` is `naip:year`, which the catalog
 * sends as a string or a number. Throws, naming the item, on anything the rule can't read.
 */
export function naipItemToCandidate(raw: unknown): NaipCatalogItem {
  const item = (raw ?? {}) as StacNaipItem;
  const id = typeof item.id === 'string' ? item.id : '';
  const bad = (why: string): never => {
    throw new Error(`NAIP item ${JSON.stringify(id)}: ${why}`);
  };
  const parsed = parseNaipItemId(id);
  const props = item.properties ?? {};
  const label = typeof props['naip:state'] === 'string' ? props['naip:state'] : parsed.prefix;
  const state = label.toUpperCase();
  if (!isNaipState(state)) return bad(`labeled ${JSON.stringify(label)}, not one of the seven`);
  const datetime = props.datetime;
  if (typeof datetime !== 'string') return bad('no datetime');
  const acquired = datetime.slice(0, 10);
  if (acquired !== parsed.acquired) {
    return bad(`datetime ${datetime} is not the id's acquisition day ${parsed.acquired}`);
  }
  const gsd = props.gsd;
  if (typeof gsd !== 'number' || !Number.isFinite(gsd) || gsd <= 0) return bad('no gsd');
  const year = Number(props['naip:year']);
  if (!Number.isInteger(year)) return bad('no naip:year');
  const bbox = item.bbox;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return bad('no bbox');
  }
  const thumb = item.assets?.thumbnail?.href;
  return {
    itemId: id,
    key: parsed.key,
    state,
    acquired,
    gsd: Math.round(gsd * 100) / 100,
    year,
    bbox: bbox as unknown as [number, number, number, number],
    thumbnail: typeof thumb === 'string' ? thumb : null,
  };
}

// ── The walk ──────────────────────────────────────────────────────────────────────────────────────

/** What one state's walk read. */
export interface NaipStateWalk {
  items: NaipCatalogItem[];
  pages: number;
}

export interface NaipWalkOptions {
  stacUrl?: string;
  /** Items per page (default and ceiling `NAIP_PAGE_LIMIT`). */
  limit?: number;
  maxPages?: number;
  /**
   * The fewest items this walk may return before it's a failure, not a quiet answer: a catalog
   * answering short (fewer than the last snapshot held) must never read as "nothing changed".
   */
  minItems?: number;
  /** Attempts per page on a 429, a 5xx or a network error (default 4). */
  attempts?: number;
  /** Waits between attempts; injectable so a test doesn't sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each page (the select stage's heartbeat). */
  onPage?: (page: number, itemsSoFar: number) => void;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks only for what the candidate reads: a page of 1,000 is ~350 KB instead of ~2.5 MB. */
const FIELDS = {
  include: [
    'id',
    'bbox',
    'properties.datetime',
    'properties.gsd',
    'properties.naip:year',
    'properties.naip:state',
    'assets.thumbnail.href',
  ],
  exclude: ['geometry', 'links'],
};

/**
 * Every item the catalog labels with `state`, as candidates, by POST paging: each page's `next`
 * link carries the continuation in its `body`, and is followed as the link says (a `next` without a
 * body is a GET of its `href`). A page that fails with a 429, a 5xx or a network error is retried
 * with backoff; any other failure, a malformed item, too many pages, or fewer than `minItems` items
 * throws — a walk that quietly returns less would read as a catalog that shrank.
 */
export async function walkNaipState(
  fetchFn: FetchLike,
  state: string,
  options: NaipWalkOptions = {},
): Promise<NaipStateWalk> {
  const stacUrl = options.stacUrl ?? NAIP_STAC_URL;
  const limit = Math.min(options.limit ?? NAIP_PAGE_LIMIT, NAIP_PAGE_LIMIT);
  const maxPages = options.maxPages ?? NAIP_MAX_PAGES_PER_STATE;
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? sleepFor;
  const label = state.toLowerCase();

  const items: NaipCatalogItem[] = [];
  const seen = new Set<string>();
  let request: { url: string; method: string; body: Record<string, unknown> | null } | null = {
    url: `${stacUrl}/search`,
    method: 'POST',
    body: {
      collections: ['naip'],
      query: { 'naip:state': { eq: label } },
      limit,
      fields: FIELDS,
    },
  };
  let pages = 0;
  while (request) {
    if (pages >= maxPages) {
      throw new Error(
        `NAIP catalog still paging ${label} after ${pages} pages; refusing to follow`,
      );
    }
    const page = await fetchPage(fetchFn, request, attempts, sleep, `${label} page ${pages + 1}`);
    pages++;
    for (const feature of page.features) {
      const item = naipItemToCandidate(feature);
      // A page boundary can repeat an item; the catalog holds it once.
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }
    options.onPage?.(pages, items.length);
    const next = page.links.find((l) => l.rel === 'next');
    if (!next) break;
    if (typeof next.href !== 'string')
      throw new Error(`NAIP catalog: ${label} next link has no href`);
    const body = isRecord(next.body) ? next.body : null;
    const method =
      typeof next.method === 'string' ? next.method.toUpperCase() : body ? 'POST' : 'GET';
    // pgstac's continuation body is the token alone; the search's own terms ride with it.
    request = {
      url: next.href,
      method,
      body: method === 'POST' ? { ...(request.body ?? {}), ...(body ?? {}) } : null,
    };
  }
  if (options.minItems !== undefined && items.length < options.minItems) {
    throw new Error(
      `NAIP catalog answered short for ${label}: ${items.length} items, expected at least ${options.minItems}`,
    );
  }
  return { items, pages };
}

interface StacPage {
  features: unknown[];
  links: { rel?: unknown; href?: unknown; method?: unknown; body?: unknown }[];
}

/** Is this status worth asking again? A rate limit or a server's bad moment; nothing else. */
const retryable = (status: number) => status === 429 || status >= 500;

async function fetchPage(
  fetchFn: FetchLike,
  request: { url: string; method: string; body: Record<string, unknown> | null },
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  what: string,
): Promise<StacPage> {
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(1000 * 2 ** (attempt - 2));
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response =
        request.method === 'POST'
          ? await fetchFn(request.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request.body),
            })
          : await fetchFn(request.url);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!response.ok) {
      lastError = `${response.status} ${response.statusText}`;
      if (retryable(response.status)) continue;
      break;
    }
    const json = await response.json();
    if (!isRecord(json) || !Array.isArray(json.features)) {
      throw new Error(`NAIP catalog: ${what} is not a feature collection`);
    }
    return {
      features: json.features,
      links: Array.isArray(json.links) ? (json.links as StacPage['links']) : [],
    };
  }
  throw new Error(`NAIP catalog: ${what} failed: ${lastError}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── The SAS token ─────────────────────────────────────────────────────────────────────────────────

/** Renew a token this long before Planetary Computer says it expires. */
const SAS_RENEW_BEFORE_MS = 5 * 60 * 1000;

/** A token whose expiry can't be read is assumed to last this long (so held for five minutes). */
const SAS_ASSUMED_LIFETIME_MS = 10 * 60 * 1000;

/** What the signer needs of a response: the token endpoint's JSON and a status. */
export interface NaipBlobAnswer {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

/**
 * Signs NAIP blob URLs with the anonymous SAS token, fetching one when it has none, renewing it
 * before it expires, and — when a signed read is refused anyway (a 403: the token expired or was
 * revoked early) — renewing it once and asking again. The token never leaves this object: `fetch`
 * is the only way to use it, so no caller can print a signed URL by accident.
 *
 * Generic in the response so a caller that reads bytes (the thumbnails) gets its own type back.
 */
export class NaipSasSigner<R extends NaipBlobAnswer = NaipBlobAnswer> {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly fetchFn: (url: string) => Promise<R>,
    private readonly now: () => number = Date.now,
    private readonly sasUrl: string = NAIP_SAS_URL,
  ) {}

  /** GET a blob, signed. Returns the response; a refusal after one renewal is the caller's. */
  async fetch(url: string): Promise<R> {
    const first = await this.fetchFn(await this.sign(url));
    if (first.status !== 403) return first;
    await this.renew();
    return this.fetchFn(await this.sign(url));
  }

  private async sign(url: string): Promise<string> {
    if (this.token === null || this.now() >= this.expiresAt - SAS_RENEW_BEFORE_MS) {
      await this.renew();
    }
    return `${url}${url.includes('?') ? '&' : '?'}${this.token}`;
  }

  private async renew(): Promise<void> {
    const response = await this.fetchFn(this.sasUrl);
    if (!response.ok) {
      throw new Error(`NAIP SAS token refused: ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    const token = isRecord(json) ? json.token : undefined;
    const expiry = isRecord(json) ? json['msft:expiry'] : undefined;
    if (typeof token !== 'string' || token === '') throw new Error('NAIP SAS answer has no token');
    const at = typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN;
    this.token = token;
    this.expiresAt = Number.isFinite(at) ? at : this.now() + SAS_ASSUMED_LIFETIME_MS;
  }
}
