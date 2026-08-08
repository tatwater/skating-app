/**
 * Archive the NHD High Resolution state geodatabases with their provenance (N7).
 *
 *   pnpm --filter @skating/etl archive-nhd [<state>…] [--refresh] [--campaign=<id>]
 *
 * Downloads each state's `NHD_H_<State>_State_GDB.zip` into a permanent `.raw-nhd/<state>/`,
 * alongside the FGDC `.xml` metadata, and records byte count, sha256, and the publisher's
 * `Last-Modified` — which for a retired dataset is the pin (see `nhdArchive.ts`).
 *
 * **The whole zip is archived, not an extracted waterbody layer** (founder call, 2026-08-03).
 * `NHDFlowline` and friends are dead weight for us — D72 keeps the access layer on Geofabrik
 * regardless — but 924 MiB across five states is affordable and *"we threw away the layer we later
 * needed"* is the more expensive mistake, especially for a dataset nobody will ever rebuild.
 *
 * One run row per state, like `scripts/bathymetry`'s snapshot: the unit that succeeds or fails is a
 * state, and a partial acquisition is normal rather than exceptional.
 *
 * Untestable network + file glue, excluded from coverage. The manifest decisions live in
 * `./nhdArchive`, tested.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  buildNhdManifest,
  NHD_RUN_TABLE_HEADER,
  NHD_SOURCES,
  type NhdManifest,
  type NhdSource,
  nhdArchiveKey,
  nhdMetadataUrl,
  nhdRunTableRow,
  nhdZipUrl,
} from './nhdArchive';

const RAW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.raw-nhd');
const USER_AGENT = 'skating-water-etl/0.1 (+https://github.com/tatwater/skating)';

function log(message: string): void {
  process.stderr.write(`[nhd] ${message}\n`);
}

function rawDir(source: NhdSource): string {
  return join(RAW_ROOT, nhdArchiveKey(source));
}

/** The `.xml` is provenance, not payload: a failure to get it must not fail the download. */
async function fetchMetadata(
  source: NhdSource,
  dir: string,
): Promise<{ metadataFilename?: string; metadataSha256?: string }> {
  try {
    const response = await fetch(nhdMetadataUrl(source), { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) return {};
    const body = Buffer.from(await response.arrayBuffer());
    const metadataFilename = nhdMetadataUrl(source).split('/').pop();
    if (!metadataFilename) return {};
    writeFileSync(join(dir, metadataFilename), body);
    return { metadataFilename, metadataSha256: createHash('sha256').update(body).digest('hex') };
  } catch {
    return {};
  }
}

async function archiveOne(source: NhdSource, refresh: boolean): Promise<NhdManifest> {
  const dir = rawDir(source);
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath) && !refresh) {
    log(`skip ${source.state} — already archived (pass --refresh to re-fetch)`);
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as NhdManifest;
  }
  mkdirSync(dir, { recursive: true });

  const url = nhdZipUrl(source);
  const expectedMb = (source.expectedBytes / 1_000_000).toFixed(0);
  log(`${source.state}: downloading ${url} (~${expectedMb} MB)`);

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`${source.state}: download failed (${response.status} ${response.statusText})`);
  }
  const lastModified = response.headers.get('last-modified') ?? undefined;
  const filename = url.split('/').pop() ?? `NHD_H_${source.slug}_State_GDB.zip`;

  const sha = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(join(dir, filename));
  let lastLogged = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    sha.update(buf);
    bytes += buf.byteLength;
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
    if (bytes - lastLogged > 50_000_000) {
      lastLogged = bytes;
      log(`  ${source.state}: ${(bytes / 1_000_000).toFixed(0)} / ${expectedMb} MB…`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const metadata = await fetchMetadata(source, dir);
  const manifest = buildNhdManifest({
    source,
    fetchedAt: new Date().toISOString(),
    filename,
    bytes,
    sha256: sha.digest('hex'),
    lastModified,
    ...metadata,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (!manifest.bytesVerified) {
    // Loud, and non-fatal for the other states. A truncated geodatabase opens fine and simply holds
    // fewer lakes — indistinguishable from a real coverage gap once it is in the corpus.
    throw new Error(
      `${source.state}: SHORT READ — got ${bytes} bytes, expected ${source.expectedBytes}. Not usable; re-run with --refresh.`,
    );
  }
  if (manifest.frozenAsExpected === false) {
    log(
      `  ! ${source.state}: Last-Modified is ${manifest.lastModified}, not the retired-dataset freeze date. Something republished NHD — check before building a corpus on it.`,
    );
  }
  log(
    `  ✓ ${source.state}: ${(bytes / 1_000_000).toFixed(0)} MB · bytes ok · ${
      manifest.frozenAsExpected === true ? 'frozen ok' : 'freeze date unverified'
    }${manifest.metadataFilename ? ' · metadata archived' : ' · NO METADATA'}`,
  );
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.split('=')[1];
  const requested = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

  const selected =
    requested.length > 0
      ? requested.map((state) => {
          const source = NHD_SOURCES.find((s) => s.state === state);
          if (!source) {
            throw new Error(
              `unknown state: ${state}. Known: ${NHD_SOURCES.map((s) => s.state).join(', ')}`,
            );
          }
          return source;
        })
      : NHD_SOURCES;

  const target = resolveDeployment();
  const manifests: NhdManifest[] = [];
  let failed = 0;

  for (const source of selected) {
    const logger = new RunLogger({
      kind: 'raw_archive',
      label: `nhd-hr-${source.state.toLowerCase()} archive`,
      campaignId,
      target,
      call: convexRun,
      stages: [
        {
          name: 'fetch',
          detail: `NHD High Resolution state geodatabase — USGS, retired 2023-10-01, frozen 2023-12-27`,
          sourceUrl: nhdZipUrl(source),
          output: `.raw-nhd/${nhdArchiveKey(source)}/`,
        },
      ],
      notes: refresh ? ['--refresh: an existing archive was overwritten.'] : undefined,
    });
    logger.start();

    try {
      const manifest = await archiveOne(source, refresh);
      manifests.push(manifest);
      logger.stage({
        name: 'fetch',
        detail: `NHD High Resolution state geodatabase — USGS, retired 2023-10-01, frozen 2023-12-27`,
        sourceUrl: manifest.url,
        output: `.raw-nhd/${nhdArchiveKey(source)}/`,
        bytes: manifest.bytes,
        sha256: manifest.sha256,
        counts: [{ name: 'files', value: manifest.metadataFilename ? 2 : 1 }],
      });
      logger.count('bytes', manifest.bytes);
      logger.count('files', manifest.metadataFilename ? 2 : 1);
      logger.succeed();
    } catch (err) {
      failed++;
      logger.fail({
        stage: 'fetch',
        key: source.state,
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.failed(err);
      // One state failing is not a reason to skip the other four — each is an independent archive.
      log(`✗ ${source.state} failed: ${(err as Error).message}`);
    }
  }

  if (manifests.length > 0) {
    process.stdout.write(`\n${NHD_RUN_TABLE_HEADER}\n`);
    for (const m of manifests) process.stdout.write(`${nhdRunTableRow(m)}\n`);
    process.stdout.write('\nPaste the rows above into the NHD run table in README.md.\n');
  }
  if (failed > 0) {
    log(`${failed}/${selected.length} state(s) failed — see /admin/imports`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[nhd] archive failed: ${(error as Error).message}\n`);
  process.exit(1);
});
