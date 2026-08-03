/**
 * Archive the 3DHP waterbody clip with its provenance (N7).
 *
 *   pnpm --filter @skating/etl archive-3dhp [--refresh] [--campaign=<id>] [--keep-source]
 *   pnpm --filter @skating/etl archive-3dhp --clip-only     # source already on disk
 *
 * Downloads the CONUS annual staged geodatabase (11.9 GB, FY26), clips the `waterbody` feature class
 * to the Northeast envelope with `ogr2ogr`, and archives **the clip** — see `threeDhpArchive.ts` for
 * why this one source keeps a derivative rather than the bytes.
 *
 * The 11.9 GB lands in `.raw-3dhp/source/` and is **deleted after a successful clip** unless
 * `--keep-source` is passed. Its manifest stays behind with the sha256, which is what makes the clip
 * reproducible without the payload.
 *
 * This is one of the two lanes meant to be re-run **annually** (the other is `archive`, for OSM).
 * NHD is not: it is retired, and its snapshot is terminal. See the README's refresh runbook.
 *
 * Untestable network + subprocess glue, excluded from coverage. The registry, the clip envelope and
 * the manifests live in `./threeDhpArchive`, tested.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  buildThreeDhpClipManifest,
  buildThreeDhpSourceManifest,
  CURRENT_3DHP_RELEASE,
  clipCommand,
  THREE_DHP_WATERBODY_LAYER,
  type ThreeDhpSourceManifest,
} from './threeDhpArchive';

const RAW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.raw-3dhp');
const SOURCE_DIR = join(RAW_ROOT, 'source');
const CLIP_DIR = join(RAW_ROOT, 'waterbody');
const USER_AGENT = 'skating-water-etl/0.1 (+https://github.com/tatwater/skating)';

function log(message: string): void {
  process.stderr.write(`[3dhp] ${message}\n`);
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function download(refresh: boolean): Promise<ThreeDhpSourceManifest> {
  const release = CURRENT_3DHP_RELEASE;
  const manifestPath = join(SOURCE_DIR, 'manifest.json');
  const zipPath = join(SOURCE_DIR, release.filename);
  mkdirSync(SOURCE_DIR, { recursive: true });

  // A source manifest with the payload already gone is the NORMAL post-run state, not an error —
  // `--keep-source` is the exception. Only re-download when the bytes are actually needed.
  if (existsSync(manifestPath) && !refresh) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as ThreeDhpSourceManifest;
    if (existsSync(zipPath)) {
      log(`source already on disk (${release.fiscalYear}); pass --refresh to re-fetch`);
      return existing;
    }
    log(`source manifest present but payload deleted (that is normal) — re-downloading`);
  }

  // **Adopt a payload that is already here.** The inverse of the case above: complete bytes, no
  // manifest. That happens when a run was killed after the download and before the manifest write,
  // or when someone pulled the 11.9 GB by hand. Re-fetching it to compute a hash we can compute from
  // disk would cost ~30 minutes to learn nothing — and the byte-count check is what decides whether
  // the file is trustworthy, not how it arrived. A partial file fails that check and re-downloads.
  if (!refresh && existsSync(zipPath) && statSync(zipPath).size === release.expectedBytes) {
    log(`adopting the ${release.fiscalYear} payload already on disk — hashing it (no re-download)`);
    const manifest = buildThreeDhpSourceManifest({
      release,
      fetchedAt: new Date(statSync(zipPath).mtimeMs).toISOString(),
      bytes: release.expectedBytes,
      sha256: await sha256OfFile(zipPath),
      lastModified: undefined,
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`  ✓ adopted · sha256 ${manifest.sha256.slice(0, 16)}…`);
    return manifest;
  }

  const expectedGb = (release.expectedBytes / 1_000_000_000).toFixed(1);
  log(
    `downloading ${release.fiscalYear} CONUS geodatabase (~${expectedGb} GB) — this is the slow part`,
  );
  const response = await fetch(release.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText})`);
  }

  const sha = createHash('sha256');
  let bytes = 0;
  let lastLogged = 0;
  const out = createWriteStream(zipPath);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    sha.update(buf);
    bytes += buf.byteLength;
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
    if (bytes - lastLogged > 1_000_000_000) {
      lastLogged = bytes;
      log(`  ${(bytes / 1_000_000_000).toFixed(1)} / ${expectedGb} GB…`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const manifest = buildThreeDhpSourceManifest({
    release,
    fetchedAt: new Date().toISOString(),
    bytes,
    sha256: sha.digest('hex'),
    lastModified: response.headers.get('last-modified') ?? undefined,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!manifest.bytesVerified) {
    throw new Error(
      `SHORT READ — got ${bytes} bytes, expected ${release.expectedBytes}. Re-run with --refresh.`,
    );
  }
  log(
    `  ✓ ${(bytes / 1_000_000_000).toFixed(1)} GB · bytes ok · sha256 ${manifest.sha256.slice(0, 16)}…`,
  );
  return manifest;
}

function countFeatures(gpkgPath: string): number {
  const result = spawnSync(
    'ogrinfo',
    ['-q', '-sql', `SELECT COUNT(*) AS n FROM ${THREE_DHP_WATERBODY_LAYER}`, gpkgPath],
    { encoding: 'utf8' },
  );
  const match = /=\s*(\d+)/.exec(result.stdout ?? '');
  return match ? Number(match[1]) : -1;
}

async function clip(source: ThreeDhpSourceManifest, refresh: boolean): Promise<void> {
  mkdirSync(CLIP_DIR, { recursive: true });
  const outName = `3dhp_waterbody_northeast_${CURRENT_3DHP_RELEASE.published}.gpkg`;
  const outPath = join(CLIP_DIR, outName);
  const manifestPath = join(CLIP_DIR, 'manifest.json');
  if (existsSync(manifestPath) && existsSync(outPath) && !refresh) {
    log('clip already archived — pass --refresh to rebuild');
    return;
  }
  if (existsSync(outPath)) rmSync(outPath);

  const zipPath = join(SOURCE_DIR, CURRENT_3DHP_RELEASE.filename);
  if (!existsSync(zipPath)) {
    throw new Error(
      `the CONUS geodatabase is not on disk (${zipPath}). Run without --clip-only to fetch it.`,
    );
  }

  const cmd = clipCommand(zipPath, outPath);
  log(`clipping: ${cmd.line}`);
  const result = spawnSync(cmd.bin, cmd.args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ogr2ogr exited ${result.status}`);

  const bytes = statSync(outPath).size;
  const features = countFeatures(outPath);
  const manifest = buildThreeDhpClipManifest({
    release: CURRENT_3DHP_RELEASE,
    derivedAt: new Date().toISOString(),
    sourceSha256: source.sha256,
    filename: outName,
    bytes,
    sha256: await sha256OfFile(outPath),
    features,
    command: cmd.line,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(
    `  ✓ clip: ${features.toLocaleString()} waterbodies · ${(bytes / 1_000_000).toFixed(0)} MB · ${outName}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const clipOnly = args.includes('--clip-only');
  const keepSource = args.includes('--keep-source');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.split('=')[1];

  const logger = new RunLogger({
    kind: 'raw_archive',
    label: `3dhp-${CURRENT_3DHP_RELEASE.fiscalYear.toLowerCase()} waterbody clip`,
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'fetch',
        detail: `3DHP ${CURRENT_3DHP_RELEASE.fiscalYear} CONUS staged geodatabase — USGS 3D Hydrography Program`,
        sourceUrl: CURRENT_3DHP_RELEASE.url,
        output: '.raw-3dhp/waterbody/',
      },
    ],
    notes: [
      'The 11.9 GB CONUS download is NOT mirrored — only the Northeast waterbody clip is. See threeDhpArchive.ts.',
      ...(refresh ? ['--refresh: an existing archive was overwritten.'] : []),
    ],
  });
  logger.start();

  try {
    const source = clipOnly
      ? (JSON.parse(
          readFileSync(join(SOURCE_DIR, 'manifest.json'), 'utf8'),
        ) as ThreeDhpSourceManifest)
      : await download(refresh);
    await clip(source, refresh);

    const clipManifest = JSON.parse(readFileSync(join(CLIP_DIR, 'manifest.json'), 'utf8'));
    logger.stage({
      name: 'fetch',
      detail: `3DHP ${CURRENT_3DHP_RELEASE.fiscalYear} CONUS staged geodatabase — USGS 3D Hydrography Program`,
      sourceUrl: CURRENT_3DHP_RELEASE.url,
      output: '.raw-3dhp/waterbody/',
      bytes: clipManifest.bytes,
      sha256: clipManifest.sha256,
      counts: [{ name: 'waterbodies', value: clipManifest.features }],
    });
    logger.count('waterbodies', clipManifest.features);
    logger.count('bytes', clipManifest.bytes);
    logger.succeed();

    if (!keepSource && !clipOnly) {
      const zipPath = join(SOURCE_DIR, CURRENT_3DHP_RELEASE.filename);
      if (existsSync(zipPath)) {
        rmSync(zipPath);
        log('deleted the CONUS download; its manifest and sha256 stay (--keep-source to retain)');
      }
    }
  } catch (err) {
    logger.fail({
      stage: 'fetch',
      key: CURRENT_3DHP_RELEASE.fiscalYear,
      reason: err instanceof Error ? err.message : String(err),
    });
    logger.failed(err);
    throw err;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[3dhp] archive failed: ${(error as Error).message}\n`);
  process.exit(1);
});
