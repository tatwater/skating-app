/**
 * Turn an archived source's manifest into a stage of a run's path.
 *
 * Every fetcher under `scripts/etl` writes a `manifest.json` beside the bytes it archives, and each
 * one already records what a reader needs to reproduce the input — the resolved URL, the
 * publisher's build date, the size, our sha256, and whatever verification the publisher made
 * possible. Until N7's provenance pass, only the OSM one was ever read back, so a run row could say
 * "an OSM extract" and nothing at all about the three other catalogues that decide the corpus.
 *
 * **The manifest shapes are re-declared here, not imported**, for the same reason `types.ts` gives:
 * `scripts/etl` is a separate tsconfig project, and a shared logger should not take a dependency on
 * the package that happens to produce its inputs. Every field is optional and unknown keys are
 * ignored, so a manifest written by an older fetcher degrades to a stage with holes rather than a
 * throw — a hole in the path is a worse record, a crash is no record at all.
 */

import type { RunStage } from './types';

/**
 * How a multi-file family names its stages: `family · key`.
 *
 * The five OSM extracts are one step of the path conceptually and five files in fact, and both
 * readings have to survive. A separator the UI can split on lets the page group them under one
 * heading without the loader having to invent a nesting level the schema does not have.
 */
export const STAGE_SEPARATOR = ' · ';

/** `source · osm/vt`. Keep the family stable — it is the key the admin page groups on. */
export function stageName(family: string, key?: string): string {
  return key === undefined ? family : `${family}${STAGE_SEPARATOR}${key}`;
}

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
export function extractStage(manifest: ExtractManifest, path?: string, name = 'extract'): RunStage {
  return {
    name,
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

/** The subset of `fetchNhd`'s `.raw-nhd/<state>/manifest.json` this reads. */
export interface NhdManifest {
  state?: string;
  slug?: string;
  fetchedAt?: string;
  url?: string;
  filename?: string;
  bytes?: number;
  expectedBytes?: number;
  bytesVerified?: boolean;
  sha256?: string;
  lastModified?: string;
  frozenAsExpected?: boolean;
}

/**
 * The stage for one archived NHD state geodatabase.
 *
 * **`checksumVerified` reports the byte count, because USGS publishes no checksum** — no `.md5`, no
 * `.sha256` beside the payload. The strongest claim available is that we received the number of
 * bytes the bucket listing advertised, and that is the one the field carries; our own sha256 is
 * recorded beside it as evidence the archive has not changed since, which is a different claim.
 *
 * `frozenAsExpected` — NHD stopped publishing in December 2023, so a moved `Last-Modified` means
 * the dataset was re-cut under us — rides in `detail` rather than the checksum field, because a
 * re-published source is a provenance surprise and not a corrupt download.
 */
export function nhdStage(manifest: NhdManifest, name: string): RunStage {
  const frozen =
    manifest.frozenAsExpected === true
      ? 'frozen as expected (2023-12-27)'
      : manifest.frozenAsExpected === false
        ? `RE-PUBLISHED — Last-Modified is now ${manifest.lastModified ?? 'unknown'}`
        : 'freeze date not recorded';
  return {
    name,
    detail: `USGS NHD ${manifest.slug ?? manifest.state ?? 'state'} geodatabase — ${frozen}`,
    output: manifest.filename,
    sourceUrl: manifest.url,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    checksumVerified: manifest.bytesVerified,
    sourceAt: parseHttpDate(manifest.lastModified),
  };
}

/** The subset of `fetch3dhp`'s two manifests this reads (the 12 GB download and its clip). */
export interface ThreeDhpManifest {
  fiscalYear?: string;
  fetchedAt?: string;
  derivedAt?: string;
  url?: string;
  sourceUrl?: string;
  filename?: string;
  layer?: string;
  command?: string;
  bytes?: number;
  bytesVerified?: boolean;
  sha256?: string;
  sourceSha256?: string;
  features?: number;
}

/**
 * The national 3DHP download — the one archive we deliberately do not keep.
 *
 * 11.9 GB of CONUS flowlines and catchments, of which we read one clipped layer. The manifest is
 * the whole record: it is what makes "re-fetch and re-clip" a reproduction rather than a hope, so
 * the stage exists even though the file it describes may well have been deleted locally.
 */
export function threeDhpSourceStage(manifest: ThreeDhpManifest, name: string): RunStage {
  return {
    name,
    detail:
      `USGS 3DHP ${manifest.fiscalYear ?? 'annual'} national release — not mirrored; the sha256 ` +
      'is what proves a re-fetch got the same bytes',
    output: manifest.filename,
    sourceUrl: manifest.url,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    checksumVerified: manifest.bytesVerified,
  };
}

/** The Northeast clip cut out of that download — the file the merge actually reads. */
export function threeDhpClipStage(manifest: ThreeDhpManifest, name: string): RunStage {
  return {
    name,
    detail: `3DHP ${manifest.layer ?? 'waterbody'} layer, clipped to the Northeast bbox`,
    command: manifest.command,
    input: manifest.sourceSha256 ? `sha256:${manifest.sourceSha256}` : undefined,
    output: manifest.filename,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    counts:
      manifest.features === undefined
        ? undefined
        : [{ name: 'features', value: manifest.features }],
  };
}

/** One state's row out of `gnisArchive`'s single `.raw-gnis/manifest.json`. */
export interface GnisStateManifest {
  code?: string;
  url?: string;
  bytes?: number;
  sha256?: string;
  fetchedAt?: string;
  rows?: number;
  waterRows?: number;
}

/**
 * One state's GNIS gazetteer file.
 *
 * `rows`/`waterRows` are counted at archive time rather than derived from the file later, and they
 * belong on the stage because a gazetteer that silently shrinks is invisible downstream: the names
 * it would have supplied simply never appear, and the bodies they would have admitted are dropped
 * by the area floor as unnamed. That failure has no other symptom.
 */
export function gnisStage(state: GnisStateManifest, name: string): RunStage {
  return {
    name,
    detail:
      `GNIS Domestic Names ${state.code ?? ''} — the staged URL carries no vintage and is ` +
      `overwritten in place, so this archive IS the version record (fetched ${state.fetchedAt ?? 'at an unrecorded time'})`,
    sourceUrl: state.url,
    bytes: state.bytes,
    sha256: state.sha256,
    counts: [
      ...(state.rows === undefined ? [] : [{ name: 'rows', value: state.rows }]),
      ...(state.waterRows === undefined ? [] : [{ name: 'waterRows', value: state.waterRows }]),
    ],
  };
}

/**
 * A stage for a **derived** input that has no manifest of its own — the two region masks.
 *
 * There is nothing upstream to verify against, so `checksumVerified` is deliberately absent rather
 * than `false`: "we could not check" and "the check failed" are different, and the badge only claims
 * the second one. Recording size and digest still makes "was this the same mask?" answerable, which
 * is the question a surprising out-of-region count raises.
 */
export function derivedFileStage(input: {
  name: string;
  detail?: string;
  path: string;
  bytes?: number;
  sha256?: string;
  producer?: string;
}): RunStage {
  return {
    name: input.name,
    detail: input.detail,
    command: input.producer,
    output: input.path,
    bytes: input.bytes,
    sha256: input.sha256,
  };
}

/**
 * An HTTP `Last-Modified` header → epoch ms, or `undefined`.
 *
 * Looser than {@link parseBuildDate} on purpose: this one is a header a server wrote in a
 * standardised format, not a six-digit field we invented, so `Date.parse` is the right reader —
 * but an unparseable header still has to become "no date" rather than `NaN` on the page.
 */
export function parseHttpDate(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}
