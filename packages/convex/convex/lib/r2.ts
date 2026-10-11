/**
 * The imagery bucket, as the live job reads and writes it (A06i §5).
 *
 * **Reads go through the public archive URL** (`IMAGERY_ARCHIVE_URL`, the same base the clients
 * use): a manifest, the mask sidecar, the search plan. **Listing and writing need the S3 API**, signed
 * with R2 keys — a public custom domain cannot list a prefix, and the index is the one object this
 * job writes. Signing is `aws4fetch`: SigV4 on WebCrypto, which Convex's runtime has.
 */

import { AwsClient } from 'aws4fetch';

/** One read, at most — a hung request must not hold a run's lease to the action limit. */
const TIMEOUT_MS = 30_000;

export interface R2Config {
  client: AwsClient;
  endpoint: string;
  bucket: string;
  /** The public base the apps read from, without a trailing slash. */
  publicBase: string;
}

export function r2ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: R2Config } | { ok: false; missing: string[] } {
  const required = [
    'IMAGERY_ARCHIVE_URL',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
  ] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      client: new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
        service: 's3',
        region: 'auto',
        // aws4fetch retries a 5xx ten times with doubling backoff — ~100 s of an action's ten minutes
        // spent on one dead request. Two is enough to ride out a blip; the next poll retries the rest.
        retries: 2,
      }),
      endpoint: (env.R2_ENDPOINT as string).replace(/\/+$/, ''),
      bucket: env.R2_BUCKET || 'skating-imagery',
      publicBase: (env.IMAGERY_ARCHIVE_URL as string).replace(/\/+$/, ''),
    },
  };
}

/** One page of a ListObjectsV2 response. XML by regex: the shape is fixed and tiny. */
export function parseListObjects(xml: string): {
  keys: string[];
  /** Each object's key and ETag — the ETag changes when the object is overwritten. */
  objects: ListedObject[];
  truncated: boolean;
  next: string | null;
} {
  const decodeXml = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1] as string));
  const blocks = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  const parsedObjects = blocks.flatMap((m) => {
    const block = m[1] as string;
    const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
    if (key === undefined) return [];
    const etag = /<ETag>([^<]*)<\/ETag>/.exec(block)?.[1];
    return [
      {
        key: decodeXml(key),
        ...(etag ? { etag: decodeXml(etag).replace(/^"|"$/g, '') } : {}),
      },
    ];
  });
  // A listing without `<Contents>` wrappers (no real S3 sends one) still yields its keys.
  const objects = blocks.length > 0 ? parsedObjects : keys.map((key) => ({ key }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, objects, truncated, next: next ? decodeXml(next) : null };
}

export interface ListedObject {
  key: string;
  etag?: string;
}

/** The most pages a listing may follow — a season is ~15 pages of 1,000; this is a loop guard. */
const MAX_LIST_PAGES = 100;

/** Every key under `prefix`. */
export async function listKeys(config: R2Config, prefix: string): Promise<string[]> {
  return (await listObjects(config, prefix)).map((o) => o.key);
}

/** Every object under `prefix`, with its ETag. */
export async function listObjects(config: R2Config, prefix: string): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) params.set('continuation-token', token);
    const res = await config.client.fetch(
      `${config.endpoint}/${config.bucket}?${params.toString()}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`R2 list ${prefix}: ${res.status} ${res.statusText}`);
    const parsed = parseListObjects(await res.text());
    objects.push(...parsed.objects);
    if (!parsed.truncated || !parsed.next) return objects;
    token = parsed.next;
  }
  throw new Error(`R2 list ${prefix}: still truncated after ${MAX_LIST_PAGES} pages`);
}

/** Write one JSON object, as `rclone copyto` would — no cache headers of our own. */
export async function putJson(config: R2Config, key: string, body: unknown): Promise<void> {
  const res = await config.client.fetch(`${config.endpoint}/${config.bucket}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // An 8 MB season index is seconds of upload; a minute is a stall, not a slow link.
    signal: AbortSignal.timeout(2 * TIMEOUT_MS),
    body: `${JSON.stringify(body)}\n`,
  });
  if (!res.ok) throw new Error(`R2 put ${key}: ${res.status} ${res.statusText}`);
}

/**
 * Read an object as JSON through the signed endpoint — the bucket itself, past any CDN cache — or
 * `null` on a 404. For what must be current: a recut manifest read through a cache could be the
 * old one, stored against the new ETag, and never read again.
 */
export async function getJson<T>(config: R2Config, key: string): Promise<T | null> {
  // Signed, then sent once: the caller already retries what it cannot read (the index's retry
  // wait), so the client's own 5xx retries would only stretch a dead read.
  const signed = await config.client.sign(`${config.endpoint}/${config.bucket}/${key}`);
  const res = await fetch(signed, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get ${key}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Read a public object as JSON, or `null` on a 404. */
export async function getPublicJson<T>(config: R2Config, key: string): Promise<T | null> {
  const res = await fetch(`${config.publicBase}/${key}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`archive ${key}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Whether a public object exists — a manifest is how a cut proves it landed. */
export async function publicExists(config: R2Config, key: string): Promise<boolean> {
  const res = await fetch(`${config.publicBase}/${key}`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`archive HEAD ${key}: ${res.status} ${res.statusText}`);
  return true;
}
