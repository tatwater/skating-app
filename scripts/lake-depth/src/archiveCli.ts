/**
 * Archive the depth datasets with their provenance (N6a).
 *
 *   pnpm --filter @skating/lake-depth archive [<key>…] [--refresh]
 *   pnpm --filter @skating/lake-depth archive --adopt=<key> --file=<path> [--file=<path>…] \
 *     --licence="…" [--url=…]
 *   pnpm --filter @skating/lake-depth archive --status
 *
 * Downloads each fetchable source into a permanent `.raw/<key>/` with a `manifest.json` carrying the
 * URL, fetch time, byte count, our sha256 and the publisher's checksum and licence where they exist.
 * Then `./mirror-r2.sh push` puts a second copy in a private bucket, so the archive is not one laptop.
 *
 * **`--adopt` exists because one of the three cannot be fetched by a script.** LAGOS-US DEPTH sits
 * behind an EDI portal login with a Cloudflare Turnstile CAPTCHA, and PASTA's public API refuses the
 * package. A human downloads it; adopting turns that file into the same checksummed, manifested,
 * mirrored archive entry as the other two, so the odd one out is no less reproducible.
 *
 * An existing archive is never overwritten without `--refresh` — the archive's whole value is that
 * it does not change under the corpus built from it.
 *
 * Untestable network + file glue, excluded from coverage; the manifest decisions are in
 * `./depthSources`, tested.
 */

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  checksumState,
  DEPTH_SOURCES,
  type DepthManifest,
  type DepthSource,
  isRunnable,
  shortLicence,
  totalBytes,
} from './depthSources';

const RAW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.raw');
const USER_AGENT = 'skating-lake-depth-etl/0.1 (+https://github.com/tatwater/skating)';

function log(message: string): void {
  process.stderr.write(`[lake-depth] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Every occurrence of a repeatable flag, in the order given. */
function flagAll(args: string[], name: string): string[] {
  return args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
}

function rawDir(key: string): string {
  return join(RAW_ROOT, key);
}

function manifestPath(key: string): string {
  return join(rawDir(key), 'manifest.json');
}

function readManifest(key: string): DepthManifest | undefined {
  try {
    return JSON.parse(readFileSync(manifestPath(key), 'utf8')) as DepthManifest;
  } catch {
    return undefined;
  }
}

/** Stream a URL to disk, hashing as it goes so a 763 MB file is never held in memory. */
async function download(
  url: string,
  dest: string,
  expectedMd5?: string,
): Promise<{ bytes: number; sha256: string; md5: string }> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  let lastLogged = 0;
  const out = createWriteStream(dest);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    sha.update(chunk);
    md5.update(chunk);
    bytes += chunk.byteLength;
    out.write(chunk);
    if (bytes - lastLogged > 50_000_000) {
      lastLogged = bytes;
      const pct = total > 0 ? ` (${((bytes / total) * 100).toFixed(0)}%)` : '';
      log(`  ${(bytes / 1_000_000).toFixed(0)} MB${pct}`);
    }
  }
  await new Promise<void>((resolve) => out.end(resolve));

  const digest = md5.digest('hex');
  if (expectedMd5 && digest !== expectedMd5) {
    // Fail rather than archive it. A corrupted archive is worse than no archive: everything
    // downstream is built to trust `.raw/` precisely because it was checked once, here.
    throw new Error(`md5 mismatch: published ${expectedMd5}, got ${digest}`);
  }
  return { bytes, sha256: sha.digest('hex'), md5: digest };
}

/** figshare's API hands over the download URL, the size, the publisher md5 *and* the licence. */
async function figshareFile(
  articleId: number,
  filename: string,
): Promise<{ url: string; md5?: string; licence?: string }> {
  const response = await fetch(`https://api.figshare.com/v2/articles/${articleId}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`figshare ${articleId}: ${response.status}`);
  const article = (await response.json()) as {
    license?: { name?: string; url?: string };
    files?: { name: string; download_url: string; computed_md5?: string }[];
  };
  const file = article.files?.find((f) => f.name === filename) ?? article.files?.[0];
  if (!file) throw new Error(`figshare ${articleId}: no file named ${filename}`);
  return {
    url: file.download_url,
    md5: file.computed_md5,
    licence: article.license?.name
      ? `${article.license.name}${article.license.url ? ` (${article.license.url})` : ''}`
      : undefined,
  };
}

async function archiveOne(source: DepthSource, refresh: boolean): Promise<DepthManifest> {
  if (source.fetch.kind === 'manual') {
    throw new Error(
      `${source.key} cannot be fetched by a script — it is behind ${source.fetch.portalUrl}\n` +
        `  Download it in a browser, then:\n` +
        `  pnpm --filter @skating/lake-depth archive --adopt=${source.key} --file=<path> --licence="<the package's rights statement>"`,
    );
  }

  const dir = rawDir(source.key);
  const existing = readManifest(source.key);
  if (existing && !refresh) {
    log(`skip ${source.key} — already archived (pass --refresh to re-fetch)`);
    return existing;
  }
  mkdirSync(dir, { recursive: true });

  let url: string;
  let filename: string;
  let publishedMd5: string | undefined;
  let licence: string | undefined = source.expectedLicence;

  if (source.fetch.kind === 'figshare') {
    const resolved = await figshareFile(source.fetch.articleId, source.fetch.filename);
    url = resolved.url;
    filename = source.fetch.filename;
    publishedMd5 = resolved.md5;
    // The publisher's own statement beats our expectation — the point of recording it at fetch time.
    licence = resolved.licence ?? licence;
  } else {
    url = source.fetch.url;
    filename = source.fetch.filename;
  }

  log(`${source.key}: downloading ${url}`);
  const { bytes, sha256, md5 } = await download(url, join(dir, filename), publishedMd5);

  const manifest: DepthManifest = {
    key: source.key,
    label: source.label,
    publisher: source.publisher,
    fetchedAt: new Date().toISOString(),
    source: { url, kind: source.fetch.kind },
    files: [{ name: filename, bytes, sha256 }],
    licence,
    publishedMd5,
    // Omitted entirely when there is nothing to compare against, rather than written as `false`.
    // HydroLAKES publishes no checksum, and a stored `md5Verified: false` reads as "the check
    // failed" — the precise conflation `checksumState` exists to prevent, reintroduced one layer
    // down where nobody would look for it.
    ...(publishedMd5 === undefined ? {} : { md5Verified: publishedMd5 === md5 }),
    notes: source.notes,
  };
  writeFileSync(manifestPath(source.key), `${JSON.stringify(manifest, null, 2)}\n`);
  log(
    `✓ ${source.key}: ${(bytes / 1_000_000).toFixed(1)} MB · sha256 ${sha256.slice(0, 12)}… · ${checksumState(manifest)}`,
  );
  return manifest;
}

/**
 * Turn files a human downloaded into a proper archive entry.
 *
 * **Takes several files, not one.** A repository package is rarely a single CSV: LAGOS-US DEPTH ships
 * the data beside a data dictionary, an EML metadata record and a methods guide, and those companions
 * are what make the data legible — the dictionary carries the column definitions and units this ETL
 * had listed as an open question, and the EML carries the citation CC BY obligates us to render. The
 * first cut of this took one path, which would have archived the numbers and thrown away the only
 * documents that say what they mean.
 */
function adopt(
  key: string,
  filePaths: string[],
  licence: string | undefined,
  url: string | undefined,
): DepthManifest {
  const source = DEPTH_SOURCES.find((s) => s.key === key);
  if (!source) throw new Error(`unknown source key: ${key}`);
  const missing = filePaths.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new Error(`no such file(s): ${missing.join(', ')}`);
  if (filePaths.length === 0) throw new Error('--adopt needs at least one --file=<path>');

  const dir = rawDir(key);
  mkdirSync(dir, { recursive: true });

  const files = filePaths.map((filePath) => {
    const filename = basename(filePath);
    const bytes = statSync(filePath).size;
    const sha256 = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const dest = join(dir, filename);
    if (dest !== filePath) writeFileSync(dest, readFileSync(filePath));
    log(`  + ${filename} (${(bytes / 1_000_000).toFixed(2)} MB · sha256 ${sha256.slice(0, 12)}…)`);
    return { name: filename, bytes, sha256 };
  });

  // The oldest mtime across the set: they were downloaded together, and the earliest is the closest
  // thing to when the package was actually pulled.
  const fetchedAt = new Date(
    Math.min(...filePaths.map((p) => statSync(p).mtime.getTime())),
  ).toISOString();

  const manifest: DepthManifest = {
    key,
    label: source.label,
    publisher: source.publisher,
    fetchedAt,
    source: {
      url: url ?? (source.fetch.kind === 'manual' ? source.fetch.portalUrl : ''),
      kind: 'manual',
    },
    files,
    licence,
    adopted: true,
    notes: source.notes,
  };
  writeFileSync(manifestPath(key), `${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  log(`✓ adopted ${key}: ${files.length} file(s), ${(bytes / 1_000_000).toFixed(1)} MB`);
  if (!licence?.trim()) {
    log(
      `⚠ no --licence recorded for ${key}. The ETL will refuse to run from it — that is the point:\n` +
        "  this source's rights statement has been an open question since the phase was scoped.",
    );
  }
  return manifest;
}

/** What is archived, what is missing, and what is not yet fit to run from. */
function status(): void {
  for (const source of DEPTH_SOURCES) {
    const manifest = readManifest(source.key);
    if (!manifest) {
      const how =
        source.fetch.kind === 'manual'
          ? `manual download — ${source.fetch.portalUrl}`
          : 'run `archive` to fetch';
      log(`✗ ${source.key.padEnd(16)} not archived (${how})`);
      continue;
    }
    const runnable = isRunnable(manifest);
    log(
      `${runnable.ok ? '✓' : '⚠'} ${source.key.padEnd(16)} ${(totalBytes(manifest) / 1_000_000).toFixed(1)} MB · ` +
        `${checksumState(manifest)} · licence: ${shortLicence(manifest.licence)}` +
        `${runnable.ok ? '' : ` — NOT RUNNABLE: ${runnable.reason}`}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--status')) return status();

  const adoptKey = flag(args, 'adopt');
  if (adoptKey) {
    const files = flagAll(args, 'file');
    if (files.length === 0) {
      throw new Error('--adopt needs at least one --file=<path> (repeat it for companion files)');
    }
    const manifest = adopt(adoptKey, files, flag(args, 'licence'), flag(args, 'url'));
    recordRun(adoptKey, manifest);
    return;
  }

  const refresh = args.includes('--refresh');
  const keys = args.filter((a) => !a.startsWith('--'));
  const selected =
    keys.length > 0 ? DEPTH_SOURCES.filter((s) => keys.includes(s.key)) : DEPTH_SOURCES;
  if (selected.length === 0) throw new Error(`no source matches: ${keys.join(', ')}`);

  let failed = 0;
  for (const source of selected) {
    if (source.fetch.kind === 'manual' && keys.length === 0) {
      // Skip rather than fail when sweeping everything: a manual source is not an error, it is a
      // standing instruction, and failing the sweep on it would hide the two that did work.
      log(`— ${source.key}: manual download, see --status`);
      continue;
    }
    try {
      const manifest = await archiveOne(source, refresh);
      recordRun(source.key, manifest);
    } catch (err) {
      failed++;
      log(`✗ ${source.key}: ${(err as Error).message}`);
      recordRun(source.key, undefined, (err as Error).message);
    }
  }

  status();
  if (failed > 0) process.exitCode = 1;
}

/**
 * One `raw_archive` run row per source, matching what the other two archives record (N6c F2).
 *
 * The outcome is derived from whether a manifest exists rather than passed in: a manifest is written
 * only after the bytes are on disk and any published checksum has matched, so it *is* the success
 * condition. A separate flag could disagree with it, and then the row would be wrong about the one
 * thing it exists to record.
 */
function recordRun(key: string, manifest: DepthManifest | undefined, error?: string): void {
  const source = DEPTH_SOURCES.find((s) => s.key === key);
  const logger = new RunLogger({
    kind: 'raw_archive',
    label: `${key} archive`,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'fetch',
        detail: `${source?.label ?? key} — ${source?.publisher ?? 'unknown publisher'}`,
        sourceUrl: manifest?.source.url,
        output: `.raw/${key}/`,
        bytes: manifest ? totalBytes(manifest) : undefined,
        sha256: manifest?.files[0]?.sha256,
        md5: manifest?.publishedMd5,
        checksumVerified: manifest?.publishedMd5 === undefined ? undefined : manifest.md5Verified,
      },
    ],
  });
  logger.start();
  if (manifest) {
    logger.count('files', manifest.files.length);
    logger.count('bytes', totalBytes(manifest));
    const runnable = isRunnable(manifest);
    logger.succeed([
      `licence: ${manifest.licence ?? 'UNRECORDED — the ETL will refuse to run from this archive'}`,
      `checksum: ${checksumState(manifest)}`,
      ...(manifest.adopted
        ? ['Adopted from a manual download — this source cannot be fetched by a script.']
        : []),
      ...(runnable.ok ? [] : [`NOT RUNNABLE: ${runnable.reason}`]),
    ]);
  } else {
    logger.fail({ stage: 'fetch', key, reason: error ?? 'unknown' });
    logger.failed(new Error(error ?? 'unknown'));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[lake-depth] archive failed: ${(error as Error).message}\n`);
  process.exit(1);
});
