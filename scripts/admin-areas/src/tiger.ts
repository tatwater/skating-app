/**
 * The TIGER sources and the download-and-verify step, shared by every script in this package.
 *
 * These lived inside `fetchStates.ts` until `buildRegion.ts` needed the same state file for a
 * different purpose. That module runs its `main()` on import — importing a constant out of it would
 * have re-run the entire five-state fetch as a side effect — so the pieces two scripts both need
 * moved here, where importing them costs nothing.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where every archive this package downloads lands. Gitignored — these are large and re-fetchable. */
export const RAW = join(HERE, '..', '.raw');

/**
 * The 2024 vintage, pinned.
 *
 * TIGER publishes annually and a boundary that moves under us is a boundary we cannot reproduce a
 * campaign against. Bump this deliberately, the way `THREE_DHP_RELEASES` is bumped — and keep the
 * predecessor's checksum so "what changed this year" has an answer.
 */
export const TIGER_STATES = {
  vintage: '2024',
  url: 'https://www2.census.gov/geo/tiger/TIGER2024/STATE/tl_2024_us_state.zip',
  filename: 'tl_2024_us_state.zip',
  layer: 'tl_2024_us_state',
  bytes: 9_954_307,
  sha256: 'ad00cbe66c7177091b668cee202e93d4a1ddcee271c28d1c9f9874af59c04b92',
  licence: 'Public domain (U.S. Census Bureau, 17 U.S.C. §105)',
  attribution: 'U.S. Census Bureau, TIGER/Line Shapefiles',
} as const;

/**
 * TIGER's county file — **all 3,144 US counties in one download**, filtered to our five.
 *
 * Not pinned by checksum the way the state file is: at 84 MB it is re-fetched rarely and the vintage
 * in the URL is the pin that matters. The byte count is asserted so a truncated download still fails.
 */
export const TIGER_COUNTIES = {
  vintage: '2024',
  url: 'https://www2.census.gov/geo/tiger/TIGER2024/COUNTY/tl_2024_us_county.zip',
  filename: 'tl_2024_us_county.zip',
  layer: 'tl_2024_us_county',
  bytes: 83_913_260,
} as const;

/**
 * County **subdivisions** — TIGER's name for what we call a town, published per state.
 *
 * In New England a county subdivision *is* the town, which is the granularity `resolvePlace` reads;
 * in New York it covers towns and cities. Five small downloads keyed by FIPS.
 */
export const TIGER_COUSUB_URL = (fips: string) =>
  `https://www2.census.gov/geo/tiger/TIGER2024/COUSUB/tl_2024_${fips}_cousub.zip`;

/**
 * The five states this project covers, with the FIPS codes TIGER keys on.
 *
 * **FIPS, not USPS**, because every TIGER filter and filename below uses it — `STATEFP = '33'`, not
 * `'NH'`. Keeping both here means adding a state is one entry rather than a hunt for the numeric code.
 */
export const STATES = [
  { code: 'ME', fips: '23' },
  { code: 'NH', fips: '33' },
  { code: 'VT', fips: '50' },
  { code: 'MA', fips: '25' },
  { code: 'NY', fips: '36' },
] as const;

/** The five states this project covers, by USPS code. */
export const STATE_CODES = STATES.map((s) => s.code);

/** A stderr logger tagged with the calling script, so interleaved runs stay attributable. */
export function makeLog(tag: string): (message: string) => void {
  return (message: string) => process.stderr.write(`[${tag}] ${message}\n`);
}

/**
 * Download once, verify, never overwrite without `--refresh`.
 *
 * **Both checks where both are available.** A truncated download has the right name and opens fine in
 * `ogr2ogr` — only the byte count and the digest together say it is the file we reasoned about. The
 * digest is optional because only the state file is small enough to be worth pinning by hand; the
 * byte count is not, and it catches the failure that actually happens.
 */
export function archive(
  source: { url: string; filename: string; bytes?: number; sha256?: string },
  refresh: boolean,
  log: (message: string) => void,
  manifestName?: string,
): string {
  mkdirSync(RAW, { recursive: true });
  const zip = join(RAW, source.filename);
  if (!existsSync(zip) || refresh) {
    log(`fetching ${source.url}…`);
    const res = spawnSync('curl', ['-sS', '--fail', '--max-time', '900', '-o', zip, source.url], {
      encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`curl exited ${res.status}: ${res.stderr}`);
  }
  const bytes = readFileSync(zip);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (source.bytes !== undefined && bytes.length !== source.bytes) {
    throw new Error(`${source.filename}: byte count ${bytes.length} != expected ${source.bytes}`);
  }
  if (source.sha256 !== undefined && sha256 !== source.sha256) {
    throw new Error(`${source.filename}: sha256 ${sha256} != expected ${source.sha256}`);
  }
  if (manifestName) {
    writeFileSync(
      join(RAW, manifestName),
      `${JSON.stringify({ ...source, actualSha256: sha256, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  log(`  ${source.filename}: ${bytes.length.toLocaleString()} bytes, ${sha256.slice(0, 12)}…`);
  return zip;
}
