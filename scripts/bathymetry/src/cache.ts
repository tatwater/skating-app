/**
 * The permanent raw snapshot cache (N6b) — file I/O around `.raw/<key>/`.
 *
 * **This directory is not scratch.** Every other ETL in this repo keeps its downloads in a `.scratch/`
 * that a person is expected to `rm -rf`, with the provenance recorded by hand in a README line that
 * says *"record the download date and md5 in your run notes."* That is provenance by human memory, and
 * this phase needs better: the transform is the part we will iterate on (interpolation, density gates,
 * contour intervals, tiling parameters), and if each iteration costs a refetch from five state portals
 * we will iterate less. So the expensive, rate-limited, disappears-if-a-state-reorganises half lives
 * here and is never deleted, and the cheap derived half lives in `.scratch/` and is thrown away freely.
 *
 * The split is a directory boundary rather than a convention because a convention would not survive
 * the first `rm -rf` typed at 1am.
 *
 * Untestable file/network glue — excluded from coverage. The decisions it makes (manifest shape, drift
 * severity, paging arithmetic) live in `manifest.ts` and `arcgis.ts`, which are tested.
 */

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { RawFileRecord, RawManifest } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `scripts/bathymetry/.raw` — resolved from this module so the CWD doesn't decide where data lands. */
export const RAW_ROOT = join(HERE, '..', '.raw');
/** `scripts/bathymetry/.scratch` — derived intermediates, safe to delete. */
export const SCRATCH_ROOT = join(HERE, '..', '.scratch');

export function rawDir(key: string): string {
  return join(RAW_ROOT, key);
}

export function manifestPath(key: string): string {
  return join(rawDir(key), 'manifest.json');
}

export function ensureRawDir(key: string): string {
  const dir = rawDir(key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function hasSnapshot(key: string): boolean {
  return existsSync(manifestPath(key));
}

export function readManifest(key: string): RawManifest | undefined {
  const path = manifestPath(key);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as RawManifest;
}

export function writeManifest(manifest: RawManifest): void {
  ensureRawDir(manifest.key);
  writeFileSync(manifestPath(manifest.key), `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write a file into the snapshot and return its manifest record (bytes + checksum).
 *
 * **Written to a temp name and renamed, so a half-written file never wears the real one.** `rename`
 * is atomic within a filesystem; `writeFileSync` is not, and the difference is the whole of the
 * resume story below — an interrupted run that leaves a truncated `page-007.json.gz` would otherwise
 * hand the next run a file that exists, looks paid-for, and cannot be decompressed.
 */
export function writeRawFile(key: string, name: string, bytes: Buffer): RawFileRecord {
  const dir = ensureRawDir(key);
  const target = join(dir, name);
  const partial = `${target}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, target);
  return { name, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

/**
 * Write a page gzipped, byte-faithful.
 *
 * Gzipped because these are hundreds of MB of highly compressible JSON, and byte-faithful because a
 * pre-merged or reformatted snapshot is already a transform — the thing the archive exists to let us
 * redo. The checksum is taken over the **compressed** bytes, which is what is actually on disk and
 * what the R2 mirror will carry.
 */
export function writeRawPage(key: string, name: string, body: string): RawFileRecord {
  return writeRawFile(key, name, gzipSync(Buffer.from(body, 'utf8')));
}

/**
 * Decompress page bytes, or `undefined` if they are not a whole gzip member.
 *
 * **gzip carries its own CRC over the uncompressed data**, so a successful `gunzipSync` is already an
 * integrity check rather than merely a parse — which is what lets a truncated or corrupted page be
 * detected without a manifest to compare against. That matters because the manifest is written at the
 * *end* of a successful fetch, so the pages an interrupted run left behind have no checksum on record.
 *
 * Pure, so the case that caused this — a page cut off mid-write — is testable without a filesystem.
 */
export function decodeRawPage(bytes: Buffer): string | undefined {
  try {
    return gunzipSync(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Read a gzipped page back as text. The transform's entry point into the archive.
 *
 * Throws, and names the file when it does: a lane reading a damaged archive should stop rather than
 * transform a short set, and `Error: incorrect header check` with no path is a bad half-hour.
 */
export function readRawPage(key: string, name: string): string {
  const path = join(rawDir(key), name);
  const text = decodeRawPage(readFileSync(path));
  if (text === undefined) {
    throw new Error(
      `${path} is not a readable gzip page. Delete it and re-run \`snapshot\` for this source — ` +
        'the remaining pages resume from the archive.',
    );
  }
  return text;
}

/**
 * Read a page only if it is intact; `undefined` means "treat as not archived".
 *
 * **The resume check's read, and it must not throw.** An interrupted write, a partial `mirror-r2.sh
 * pull`, or a bad sector leaves a file that `hasRawPage` says is there and `gunzipSync` refuses — and
 * a throw at that point aborts not just this run but *every* subsequent one, permanently, until
 * somebody deletes the file by hand or reaches for `--refresh` on a whole state. That is the precise
 * outcome the resume exists to prevent, so an unreadable page is simply re-fetched over.
 */
export function tryReadRawPage(key: string, name: string): string | undefined {
  try {
    return decodeRawPage(readFileSync(join(rawDir(key), name)));
  } catch {
    return undefined;
  }
}

/** Is this page already archived? The resume check — an existing page is one we already paid for. */
export function hasRawPage(key: string, name: string): boolean {
  return existsSync(join(rawDir(key), name));
}

/** Re-derive a manifest record for a file already on disk, so a resumed page still gets checksummed. */
export function rawFileRecord(key: string, name: string): RawFileRecord {
  const bytes = readFileSync(join(rawDir(key), name));
  return { name, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

/** Every stored page for a source, in fetch order (the filenames are zero-padded to guarantee it). */
export function listRawPages(key: string): string[] {
  const dir = rawDir(key);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('page-') && f.endsWith('.json.gz'))
    .sort();
}

/**
 * Stream a large download straight to disk.
 *
 * VT's sounding archive is 22 MB compressed and 134 MB expanded; Maine's and NY's are unknown until we
 * look. Buffering an unknown-size third-party download into memory to checksum it is the kind of thing
 * that works on every source until the one it doesn't, so this streams and hashes in one pass.
 */
export async function downloadToRaw(
  key: string,
  url: string,
  filename: string,
): Promise<{
  file: RawFileRecord;
  http: { lastModified?: string; etag?: string; contentLength?: number };
}> {
  const dir = ensureRawDir(key);
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(join(dir, filename));
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    hash.update(buf);
    bytes += buf.byteLength;
    if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const contentLength = Number(response.headers.get('content-length') ?? Number.NaN);
  return {
    file: { name: filename, bytes, sha256: hash.digest('hex') },
    http: {
      lastModified: response.headers.get('last-modified') ?? undefined,
      etag: response.headers.get('etag') ?? undefined,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    },
  };
}

/**
 * Identify ourselves. Several of these portals are small state agencies on modest infrastructure, and
 * a nameless bulk pager is exactly the traffic an operator blocks first. A contactable UA is both the
 * polite thing and the thing that keeps the tap on.
 */
export const USER_AGENT = 'skating-bathymetry-etl/0.1 (+https://github.com/tatwater/skating)';

/** GET a URL as text, with the ETL's user agent and a loud failure. */
export async function getText(url: string): Promise<string> {
  let lastError = '';
  for (let attempt = 0; attempt < GET_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.ok) return await response.text();
      lastError = `${response.status} ${response.statusText}`;
      // A 4xx is our query being wrong and will be wrong again in two seconds. Only server-side and
      // transport failures are worth retrying.
      if (response.status < 500) break;
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  throw new Error(`GET failed (${lastError}) after ${GET_ATTEMPTS} attempt(s): ${url}`);
}

/**
 * How many times to try a page before giving up.
 *
 * Not politeness-theatre: MassGIS returned a 500 partway through a 56-page fetch during the first
 * real run. Without a retry that is fourteen minutes of work lost to one transient, and — worse — the
 * natural response to losing it repeatedly is to reach for `--refresh` on a whole state, which is the
 * opposite of what the archive is for.
 */
const GET_ATTEMPTS = 4;

/**
 * Be a good citizen between pages.
 *
 * NH's layer is five pages and VT Champlain's is fifty-three; neither is load. But `verify` and a
 * refetch across five states in a loop is enough to look like a scrape from the receiving end, and the
 * cost of a courtesy delay is measured in seconds against an archive we keep forever.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
