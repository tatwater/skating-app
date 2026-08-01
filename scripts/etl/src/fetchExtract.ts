/**
 * Archive a Geofabrik extract with its provenance (water ETL).
 *
 *   pnpm --filter @skating/etl archive [<state>…] [--refresh]
 *
 * Downloads each state's `-latest` extract into a permanent `.raw/<state>/`, following the redirect
 * to the **dated** build and recording that URL, Geofabrik's published md5, our own sha256, and the
 * byte count. Then prints the README's run-table rows, already filled in.
 *
 * An existing archive is never overwritten without `--refresh` — the whole point is that it does not
 * change under the corpus built from it.
 *
 * Untestable network + file glue, excluded from coverage. The manifest decisions — what pins a
 * snapshot, and the difference between "unverified" and "mismatched" — are in `./archive`, tested.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  archiveKey,
  buildExtractManifest,
  checksumUrl,
  EXTRACT_SOURCES,
  type ExtractManifest,
  type ExtractSource,
  extractUrl,
  parsePublishedMd5,
  RUN_TABLE_HEADER,
  runTableRow,
} from './archive';

const RAW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.raw');
const USER_AGENT = 'skating-water-etl/0.1 (+https://github.com/tatwater/skating)';

function log(message: string): void {
  process.stderr.write(`[etl] ${message}\n`);
}

function rawDir(source: ExtractSource): string {
  return join(RAW_ROOT, archiveKey(source));
}

async function archiveOne(source: ExtractSource, refresh: boolean): Promise<ExtractManifest> {
  const dir = rawDir(source);
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath) && !refresh) {
    log(`skip ${source.state} — already archived (pass --refresh to re-fetch)`);
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtractManifest;
  }
  mkdirSync(dir, { recursive: true });

  // Geofabrik publishes the checksum against the `-latest` alias, so fetch it first: it describes
  // whichever dated build the redirect is currently pointing at.
  let publishedMd5: string | undefined;
  try {
    const response = await fetch(checksumUrl(source), { headers: { 'User-Agent': USER_AGENT } });
    if (response.ok) publishedMd5 = parsePublishedMd5(await response.text());
  } catch {
    // A missing checksum degrades to "unverified", recorded honestly. It must not fail a download.
  }

  log(`${source.state}: downloading ${extractUrl(source)}`);
  const response = await fetch(extractUrl(source), { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`${source.state}: download failed (${response.status} ${response.statusText})`);
  }

  // `response.url` is the URL after redirects — the dated build. This is the pin the run notes lost.
  const resolvedUrl = response.url;
  const filename = resolvedUrl.split('/').pop() ?? `${source.slug}-latest.osm.pbf`;

  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  const out = createWriteStream(join(dir, filename));
  let lastLogged = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    sha.update(buf);
    md5.update(buf);
    bytes += buf.byteLength;
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
    if (bytes - lastLogged > 50_000_000) {
      lastLogged = bytes;
      log(`  ${source.state}: ${(bytes / 1_000_000).toFixed(0)} MB…`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const manifest = buildExtractManifest({
    source,
    fetchedAt: new Date().toISOString(),
    resolvedUrl,
    filename,
    bytes,
    sha256: sha.digest('hex'),
    publishedMd5,
    actualMd5: md5.digest('hex'),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (manifest.md5Verified === false) {
    // Loud, and non-fatal for the other states: a truncated extract is exactly the failure the
    // README says this discipline exists to catch before ~30k bad bodies load.
    log(`  ✗ ${source.state}: MD5 MISMATCH — do not load this extract.`);
  } else if (manifest.md5Verified) {
    log(
      `  ✓ ${source.state}: ${(bytes / 1_000_000).toFixed(0)} MB · build ${manifest.buildDate ?? '?'} · md5 ok`,
    );
  } else {
    log(`  ! ${source.state}: ${(bytes / 1_000_000).toFixed(0)} MB · md5 unverified`);
  }
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const requested = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

  const selected =
    requested.length > 0
      ? requested.map((state) => {
          const source = EXTRACT_SOURCES.find((s) => s.state === state);
          if (!source) {
            throw new Error(
              `unknown state: ${state}. Known: ${EXTRACT_SOURCES.map((s) => s.state).join(', ')}`,
            );
          }
          return source;
        })
      : EXTRACT_SOURCES;

  const manifests: ExtractManifest[] = [];
  for (const source of selected) manifests.push(await archiveOne(source, refresh));

  process.stdout.write(`\n${RUN_TABLE_HEADER}\n`);
  for (const m of manifests) process.stdout.write(`${runTableRow(m)}\n`);
  process.stdout.write(
    '\nPaste the rows above into the run table in README.md — they are already filled in.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[etl] archive failed: ${(error as Error).message}\n`);
  process.exit(1);
});
