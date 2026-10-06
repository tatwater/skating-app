/**
 * The imagery bucket, as the live job reads and writes it (A06i §5).
 *
 * **Reads go through the public archive URL** (`IMAGERY_ARCHIVE_URL`, the same base the clients
 * use): a manifest, the mask sidecar, the search plan. **Listing and writing need the S3 API**, signed
 * with R2 keys — a public custom domain cannot list a prefix, and the index is the one object this
 * job writes. Signing is `aws4fetch`: SigV4 on WebCrypto, which Convex's runtime has.
 */

import { AwsClient } from 'aws4fetch';

/** One public read, at most — a hung request must not hold the pump's beat. */
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
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, truncated, next: next ? decodeXml(next) : null };
}

/** The most pages a listing may follow — a season is ~15 pages of 1,000; this is a loop guard. */
const MAX_LIST_PAGES = 100;

/** Every key under `prefix`. */
export async function listKeys(config: R2Config, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) params.set('continuation-token', token);
    const res = await config.client.fetch(
      `${config.endpoint}/${config.bucket}?${params.toString()}`,
    );
    if (!res.ok) throw new Error(`R2 list ${prefix}: ${res.status} ${res.statusText}`);
    const parsed = parseListObjects(await res.text());
    keys.push(...parsed.keys);
    if (!parsed.truncated || !parsed.next) return keys;
    token = parsed.next;
  }
  throw new Error(`R2 list ${prefix}: still truncated after ${MAX_LIST_PAGES} pages`);
}

/** Write one JSON object, as `rclone copyto` would — no cache headers of our own. */
export async function putJson(config: R2Config, key: string, body: unknown): Promise<void> {
  const res = await config.client.fetch(`${config.endpoint}/${config.bucket}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: `${JSON.stringify(body)}\n`,
  });
  if (!res.ok) throw new Error(`R2 put ${key}: ${res.status} ${res.statusText}`);
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
