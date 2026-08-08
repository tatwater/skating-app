/**
 * Snapshot fetcher (N6b) — pull a source into the permanent `.raw/` archive.
 *
 *   pnpm --filter @skating/bathymetry snapshot [<key>…] [--state=NH] [--refresh] [--delay=250]
 *
 * (The script is `snapshot`, not `fetch`: `pnpm fetch` is a built-in pnpm command that populates the
 * package store, so a script by that name is shadowed and silently runs an install instead.)
 *
 * With no keys it fetches every registry source that has no snapshot yet. **An existing snapshot is
 * never overwritten without `--refresh`**, which is the rule that makes this safe to re-run and safe
 * to leave in a script: the archive's whole value is that it does not change under the transform we
 * are iterating on.
 *
 * Untestable network + file glue, excluded from coverage. The paging arithmetic and the manifest
 * shape — the parts with bugs that produce plausible-looking wrong archives — are in `arcgis.ts` and
 * `manifest.ts`, tested.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  countUrl,
  descriptorUrl,
  pageCount,
  pageFilename,
  pageUrl,
  parseCount,
  parsePage,
  preferredFormat,
} from './arcgis';
import {
  downloadToRaw,
  ensureRawDir,
  getText,
  hasRawPage,
  hasSnapshot,
  rawFileRecord,
  sleep,
  tryReadRawPage,
  writeManifest,
  writeRawFile,
  writeRawPage,
} from './cache';
import { buildManifest, normalizeDescriptor, objectIdField } from './manifest';
import { parseSelection, selectSources } from './select';
import { SOURCES } from './sources';
import type { BathymetrySource, RawFileRecord } from './types';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

async function fetchArcGis(
  source: BathymetrySource,
  delayMs: number,
  refresh: boolean,
): Promise<void> {
  if (source.fetch.type !== 'arcgis') throw new Error('not an arcgis source');
  const { url } = source.fetch;

  const descriptorBody = await getText(descriptorUrl(url));
  const descriptor = normalizeDescriptor(JSON.parse(descriptorBody));
  const oid = objectIdField(descriptor);
  if (!oid) {
    // Without an OID there is no stable ordering, and `resultOffset` paging over an unordered set
    // silently drops and duplicates rows. Refuse rather than archive a plausible-looking wrong set.
    throw new Error(
      `${source.key}: layer declares no OID field, so pages cannot be ordered stably. ` +
        'Fetching would produce an archive with dropped and duplicated rows.',
    );
  }

  const total = parseCount(await getText(countUrl(url)));
  const pageSize = source.fetch.pageSize ?? descriptor.maxRecordCount ?? 1000;
  const format = preferredFormat(descriptor.supportedQueryFormats);
  const pages = pageCount(total, pageSize);
  log(`${source.key}: ${total} records · ${pages} pages of ${pageSize} · f=${format}`);

  ensureRawDir(source.key);
  const files: RawFileRecord[] = [
    writeRawFile(source.key, 'descriptor.json', Buffer.from(descriptorBody, 'utf8')),
  ];

  let captured = 0;
  let resumed = 0;
  const discarded: string[] = [];
  for (let index = 0; index < pages; index += 1) {
    const name = pageFilename(index);

    // **Resume.** A page already on disk is a page we already paid for. MassGIS is 56 pages at ~15
    // seconds each, and losing all of it to one transient 500 is how a person ends up reaching for
    // `--refresh` on a whole state — the exact opposite of what the archive is for.
    //
    // **Every way an existing page can be unusable falls through to re-fetching it**, and none of them
    // throws. Pages are now written atomically, so this run cannot create a truncated one — but a page
    // left by an older run, a partial `mirror-r2.sh pull`, or a bad sector all produce a file that
    // exists and will not decompress. Aborting there would abort every *later* run too, which turns a
    // one-page problem into a permanently unresumable state: the exact failure resume exists to avoid.
    if (!refresh && hasRawPage(source.key, name)) {
      const existing = tryReadRawPage(source.key, name);
      const parsedExisting = existing === undefined ? undefined : parsePage(existing);
      if (parsedExisting && !parsedExisting.error) {
        files.push(rawFileRecord(source.key, name));
        captured += parsedExisting.count;
        resumed += 1;
        continue;
      }
      // Named, not silent — a re-fetched page is a page that was on disk and wrong, which is worth
      // knowing about an archive whose whole promise is that it makes reprocessing free.
      discarded.push(name);
      log(
        `  ⚠ ${source.key}: ${name} is on disk but ${existing === undefined ? 'will not decompress' : 'did not parse'} — re-fetching it`,
      );
    }

    const body = await getText(
      pageUrl(url, { offset: index * pageSize, pageSize, orderByFields: oid, format }),
    );
    const parsed = parsePage(body);
    if (parsed.error) {
      throw new Error(`${source.key}: page ${index} failed: ${parsed.error}`);
    }
    files.push(writeRawPage(source.key, name, body));
    captured += parsed.count;
    if (index % 10 === 0 || index === pages - 1) {
      log(`  ${source.key}: page ${index + 1}/${pages} · ${captured}/${total} records`);
    }
    if (delayMs > 0 && index < pages - 1) await sleep(delayMs);
  }
  if (resumed > 0) log(`  ${source.key}: reused ${resumed} page(s) already in the archive`);
  if (discarded.length > 0) {
    log(`  ${source.key}: replaced ${discarded.length} unusable page(s): ${discarded.join(', ')}`);
  }

  if (captured !== total) {
    // Not fatal — a live layer can genuinely gain rows mid-fetch — but it must be visible, because a
    // short archive that reports success is precisely the silent failure this whole module exists for.
    log(
      `  ⚠ ${source.key}: captured ${captured} of ${total} reported records. ` +
        'Either the layer changed mid-fetch or paging lost rows — check before transforming.',
    );
  }

  writeManifest(
    buildManifest({
      key: source.key,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
      sourceKind: 'arcgis',
      format,
      files,
      recordCount: captured,
      service: descriptor,
    }),
  );
  log(`✓ ${source.key}: ${captured} records in ${files.length - 1} pages`);
}

async function fetchFile(source: BathymetrySource): Promise<void> {
  if (source.fetch.type !== 'file') throw new Error('not a file source');
  const { url, filename } = source.fetch;
  log(`${source.key}: downloading ${filename}`);
  const { file, http } = await downloadToRaw(source.key, url, filename);
  writeManifest(
    buildManifest({
      key: source.key,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
      sourceKind: 'file',
      files: [file],
      http,
    }),
  );
  log(
    `✓ ${source.key}: ${(file.bytes / 1_000_000).toFixed(1)} MB · sha256 ${file.sha256.slice(0, 12)}…`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const delayMs = Number(flag(args, 'delay') ?? 250);
  const campaignId = flag(args, 'campaign');
  const selected = selectSources(SOURCES, parseSelection(args));

  const todo = selected.filter((source) => {
    if (!hasSnapshot(source.key) || refresh) return true;
    log(`skip ${source.key} — already archived (pass --refresh to re-fetch)`);
    return false;
  });

  if (todo.length === 0) {
    log('nothing to fetch. The archive is what makes reprocessing free — this is the good case.');
    return;
  }

  // One run row per source (N6c F2), labelled to match what the archive backfill reconstructs, so a
  // re-fetch lands as the newest entry in that source's own history rather than as a stranger.
  // Per-source rather than per-invocation because that is the unit that succeeds or fails: these are
  // five independent state agencies, and "the snapshot failed" is never true of all of them at once.
  const target = resolveDeployment();
  let failed = 0;
  for (const source of todo) {
    const logger = new RunLogger({
      kind: 'raw_archive',
      label: `${source.key} archive`,
      campaignId,
      target,
      call: convexRun,
      stages: [
        {
          name: 'fetch',
          detail: `${source.fetch.type} source — ${source.agency}`,
          sourceUrl: source.fetch.url,
          output: `.raw/${source.key}/`,
        },
      ],
      notes: refresh ? ['--refresh: an existing snapshot was overwritten.'] : undefined,
    });
    logger.start();

    try {
      if (source.fetch.type === 'arcgis') await fetchArcGis(source, delayMs, refresh);
      else await fetchFile(source);
    } catch (err) {
      failed++;
      logger.fail({
        stage: 'fetch',
        key: source.key,
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.failed(err);
      // One agency's service being down is not a reason to skip the other four — each source is an
      // independent archive, and a partial snapshot run is normal rather than exceptional.
      log(`✗ ${source.key} failed: ${(err as Error).message}`);
      continue;
    }

    // Read the counts back out of the manifest the fetch just wrote, rather than tallying them
    // alongside: the manifest is what the rest of the pipeline reads, so it is the honest witness.
    const manifest = readManifestCounts(source.key);
    logger.stage({
      name: 'fetch',
      detail: `${source.fetch.type} source — ${source.agency}`,
      sourceUrl: source.fetch.url,
      output: `.raw/${source.key}/`,
      bytes: manifest.bytes,
      sha256: manifest.singleSha256,
      counts: [
        { name: 'files', value: manifest.files },
        ...(manifest.records !== undefined ? [{ name: 'records', value: manifest.records }] : []),
      ],
    });
    logger.count('files', manifest.files);
    logger.count('bytes', manifest.bytes);
    if (manifest.records !== undefined) logger.count('records', manifest.records);
    logger.succeed();
  }

  if (failed > 0) {
    log(`${failed}/${todo.length} source(s) failed — see /admin/imports`);
    process.exitCode = 1;
  }
}

/** Read back the manifest the fetch just wrote, for the run row's counts. */
function readManifestCounts(key: string): {
  files: number;
  bytes: number;
  records?: number;
  singleSha256?: string;
} {
  try {
    const raw = readFileSync(new URL(`../.raw/${key}/manifest.json`, import.meta.url), 'utf8');
    const m = JSON.parse(raw) as {
      files?: { name: string; bytes: number; sha256: string }[];
      recordCount?: number;
    };
    const files = m.files ?? [];
    return {
      files: files.length,
      bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
      records: m.recordCount,
      // A multi-page pull has one sha256 per page; only the single-file case has one for the stage.
      singleSha256: files.length === 1 ? files[0]?.sha256 : undefined,
    };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] fetch failed: ${(error as Error).message}\n`);
  process.exit(1);
});
