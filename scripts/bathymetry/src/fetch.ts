/**
 * Snapshot fetcher (N6b) — pull a source into the permanent `.raw/` archive.
 *
 *   pnpm --filter @skating/bathymetry snapshot [<key>…] [--refresh] [--delay=250]
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

import process from 'node:process';
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
  readRawPage,
  sleep,
  writeManifest,
  writeRawFile,
  writeRawPage,
} from './cache';
import { buildManifest, normalizeDescriptor, objectIdField } from './manifest';
import { SOURCES, sourceByKey } from './sources';
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
  for (let index = 0; index < pages; index += 1) {
    const name = pageFilename(index);

    // **Resume.** A page already on disk is a page we already paid for. MassGIS is 56 pages at ~15
    // seconds each, and losing all of it to one transient 500 is how a person ends up reaching for
    // `--refresh` on a whole state — the exact opposite of what the archive is for. Pages are written
    // whole (a synchronous gzip write), so an existing file is a complete one.
    if (!refresh && hasRawPage(source.key, name)) {
      const parsedExisting = parsePage(readRawPage(source.key, name));
      if (!parsedExisting.error) {
        files.push(rawFileRecord(source.key, name));
        captured += parsedExisting.count;
        resumed += 1;
        continue;
      }
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
  const requested = args.filter((a) => !a.startsWith('--'));

  const selected =
    requested.length > 0
      ? requested.map((key) => {
          const source = sourceByKey(key);
          if (!source) throw new Error(`unknown source key: ${key}`);
          return source;
        })
      : SOURCES;

  const todo = selected.filter((source) => {
    if (!hasSnapshot(source.key) || refresh) return true;
    log(`skip ${source.key} — already archived (pass --refresh to re-fetch)`);
    return false;
  });

  if (todo.length === 0) {
    log('nothing to fetch. The archive is what makes reprocessing free — this is the good case.');
    return;
  }

  for (const source of todo) {
    if (source.fetch.type === 'arcgis') await fetchArcGis(source, delayMs, refresh);
    else await fetchFile(source);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] fetch failed: ${(error as Error).message}\n`);
  process.exit(1);
});
