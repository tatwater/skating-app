/**
 * Turn an archived extract's manifest into the first stage of a run's path.
 *
 * `scripts/etl/fetchExtract` writes one `manifest.json` beside each `.pbf` it archives under
 * `.raw/<state>/`. That file already records everything a reader needs to reproduce the input —
 * the resolved URL, the publisher's build date, the size, our sha256, and whether the published
 * md5 verified. Until now nothing downstream read it, so provenance stopped at "an OSM extract".
 */

import type { RunStage } from './types';

/** The subset of `fetchExtract`'s manifest this reads. Unknown keys are ignored, not rejected. */
export interface ExtractManifest {
  state?: string;
  slug?: string;
  fetchedAt?: string;
  requestedUrl?: string;
  resolvedUrl?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  buildDate?: string;
  publishedMd5?: string;
  md5Verified?: boolean;
}

/**
 * Geofabrik's `YYMMDD` build stamp → epoch ms, or `undefined` if it isn't one.
 *
 * **Not a general date parser on purpose.** `buildDate` is a fixed six-digit field in a file we
 * write ourselves; accepting anything looser here would let a malformed manifest render as a
 * confident wrong date on the admin page, which is the failure this whole table exists to avoid.
 */
export function parseBuildDate(buildDate: string | undefined): number | undefined {
  if (buildDate === undefined || !/^\d{6}$/.test(buildDate)) return undefined;
  const year = 2000 + Number(buildDate.slice(0, 2));
  const month = Number(buildDate.slice(2, 4));
  const day = Number(buildDate.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const at = Date.UTC(year, month - 1, day);
  // Date.UTC rolls 31 April over into May rather than rejecting it; catch that round-trip.
  const rolled = new Date(at);
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) return undefined;
  return at;
}

/**
 * The `extract` stage for an archived `.pbf`.
 *
 * `checksumVerified` reports **the publisher's md5**, not our sha256 — ours proves the file has not
 * changed since we archived it, which is a different and weaker claim than that we downloaded what
 * Geofabrik published. Only the second one is worth surfacing to an operator asking "is this the
 * real extract", so it is the one the field carries.
 */
export function extractStage(manifest: ExtractManifest, path?: string): RunStage {
  return {
    name: 'extract',
    detail: manifest.slug
      ? `Geofabrik ${manifest.slug} extract, archived ${manifest.fetchedAt ?? 'at an unrecorded time'}`
      : 'archived OSM extract',
    output: path ?? manifest.filename,
    sourceUrl: manifest.resolvedUrl ?? manifest.requestedUrl,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    md5: manifest.publishedMd5,
    checksumVerified: manifest.md5Verified,
    sourceAt: parseBuildDate(manifest.buildDate),
  };
}
