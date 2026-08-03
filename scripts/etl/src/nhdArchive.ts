/**
 * NHD acquisition and provenance — the second canonical-water catalogue (N7).
 *
 * ## Why this sits beside `archive.ts` rather than in its own package
 *
 * The unified corpus is **one pipeline with three source lanes**, not three pipelines. That is the
 * same call `scripts/bathymetry` made for its five state agencies: a registry file, so that adding a
 * catalogue is data rather than a code path. `archive.ts` pins the OSM lane; this pins the NHD one.
 *
 * ## The pin is the freeze date, and that is unusual enough to explain
 *
 * Geofabrik rebuilds daily, so `archive.ts` pins a *dated build* discovered through a redirect. NHD
 * is the opposite problem: **USGS retired it on 2023-10-01**, and every state geodatabase carries
 * `Last-Modified: 2023-12-27`. It will never be rebuilt. So the provenance question is not "which
 * build did we get" but "is this still the same bytes it was" — and the answer is a
 * `Last-Modified` that must not move and a byte count that must not change.
 *
 * **USGS publishes no checksum**: no `.md5`, no `.sha256` beside the payload (all 404, checked
 * 2026-08-03), and S3's `ETag` is a multipart digest (`…-17`) rather than a usable md5. So the
 * strongest integrity check available before download is the **expected byte count**, pinned below
 * from the bucket listing, and after download it is our own sha256 recorded for next time. That is
 * weaker than Geofabrik's published md5 and the manifest says so rather than implying a verification
 * we did not perform.
 *
 * Pure logic here and tested; the download glue is `fetchNhd.ts`.
 */

/** One state's NHD High Resolution geodatabase. */
export interface NhdSource {
  /** Two-letter state code, matching the OSM lane's `--state=` tag. */
  state: string;
  /** The URL segment USGS uses — a full state name with `_` for spaces. */
  slug: string;
  /**
   * Byte count from the staged-products bucket listing, 2026-08-03.
   *
   * This is the integrity check, standing in for the checksum USGS does not publish. A short read
   * is the failure mode that matters — a truncated 400 MB geodatabase opens fine in `ogr2ogr` and
   * simply contains fewer lakes, which is indistinguishable from a real coverage gap.
   */
  expectedBytes: number;
}

export const NHD_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/State/GDB';

/**
 * The date every one of these artifacts carries, and the reason it is a constant rather than a
 * per-source field: NHD was retired, so this is a property of the *dataset*, not of a download.
 *
 * If a fetch ever sees a different `Last-Modified`, something republished a retired dataset under us
 * and that is worth stopping for.
 */
export const NHD_FROZEN_AT = '2023-12-27';

/**
 * The five states, ordered smallest-first on purpose.
 *
 * A first run should discover a broken assumption on New Hampshire's 111 MB, not on New York's 397.
 */
export const NHD_SOURCES: NhdSource[] = [
  { state: 'NH', slug: 'New_Hampshire', expectedBytes: 110_796_389 },
  { state: 'MA', slug: 'Massachusetts', expectedBytes: 131_867_834 },
  { state: 'VT', slug: 'Vermont', expectedBytes: 139_834_230 },
  { state: 'ME', slug: 'Maine', expectedBytes: 189_360_917 },
  { state: 'NY', slug: 'New_York', expectedBytes: 396_742_381 },
];

/**
 * Public domain, and the attribution is courtesy rather than obligation — recorded because every
 * other source in this repo carries a real licence and an unstated one reads as an oversight.
 */
export const NHD_LICENCE = 'Public domain (USGS · US Government work, 17 U.S.C. §105)';
export const NHD_ATTRIBUTION = 'U.S. Geological Survey, National Hydrography Dataset';

export function nhdZipUrl(source: NhdSource): string {
  return `${NHD_BASE}/NHD_H_${source.slug}_State_GDB.zip`;
}

/**
 * The FGDC metadata sitting beside each payload — ~29 KB, and it is the provenance record: process
 * lineage, publication date, the licence statement in the publisher's own words.
 *
 * Taken for the same reason `DepthManifest` archives a data dictionary. It costs nothing and it is
 * the thing nobody can reconstruct once a retired dataset is pulled down.
 */
export function nhdMetadataUrl(source: NhdSource): string {
  return `${NHD_BASE}/NHD_H_${source.slug}_State_GDB.xml`;
}

/** A stable, filesystem-safe archive key. Matches the OSM lane's, so the two trees read alike. */
export function nhdArchiveKey(source: NhdSource): string {
  return source.state.toLowerCase();
}

/**
 * NHD's `Permanent_Identifier`, in the one form we ever store it in.
 *
 * High-resolution NHD ships it as a **brace-wrapped, upper-case GUID** —
 * `{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}` — and different access paths disagree about the braces.
 * Two spellings of one key is how a join silently matches nothing, so the normalization lives here
 * and every producer of an `nhdId` calls it.
 *
 * **Refuses anything that is not a GUID** rather than passing it through. A join key that accepts
 * garbage rots quietly; one that returns `undefined` gets counted in a drop ledger.
 */
export function normalizeNhdId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stripped)
    ? stripped
    : undefined;
}

/** What a `.raw-nhd/<state>/manifest.json` records. */
export interface NhdManifest {
  state: string;
  slug: string;
  /** ISO-8601, injected rather than read from the clock so the writer stays pure. */
  fetchedAt: string;
  url: string;
  filename: string;
  bytes: number;
  sha256: string;
  /** What the registry said to expect, and whether the download matched it. */
  expectedBytes: number;
  bytesVerified: boolean;
  /**
   * The publisher's `Last-Modified`, verbatim. Absent if the server did not send one, which is
   * itself worth noticing on a dataset whose whole provenance story is that it does not change.
   */
  lastModified?: string;
  /** False when `lastModified` is present and is *not* the frozen date. See `NHD_FROZEN_AT`. */
  frozenAsExpected?: boolean;
  /** The FGDC metadata archived alongside, when it came down. */
  metadataFilename?: string;
  metadataSha256?: string;
  licence: string;
  attribution: string;
}

export interface BuildNhdManifestInput {
  source: NhdSource;
  fetchedAt: string;
  filename: string;
  bytes: number;
  sha256: string;
  lastModified?: string;
  metadataFilename?: string;
  metadataSha256?: string;
}

/**
 * Assemble a manifest, deciding the two derived facts: did we get all the bytes, and is the dataset
 * still frozen where we left it.
 *
 * `frozenAsExpected` is deliberately absent rather than `true` when no `Last-Modified` came back.
 * "We didn't check" and "it checked out" are different claims, and the OSM lane learned that lesson
 * the expensive way (`md5Verified`, `archive.ts`).
 */
export function buildNhdManifest(input: BuildNhdManifestInput): NhdManifest {
  const manifest: NhdManifest = {
    state: input.source.state,
    slug: input.source.slug,
    fetchedAt: input.fetchedAt,
    url: nhdZipUrl(input.source),
    filename: input.filename,
    bytes: input.bytes,
    sha256: input.sha256,
    expectedBytes: input.source.expectedBytes,
    bytesVerified: input.bytes === input.source.expectedBytes,
    licence: NHD_LICENCE,
    attribution: NHD_ATTRIBUTION,
  };
  if (input.lastModified) {
    manifest.lastModified = input.lastModified;
    manifest.frozenAsExpected = toIsoDate(input.lastModified) === NHD_FROZEN_AT;
  }
  if (input.metadataFilename) manifest.metadataFilename = input.metadataFilename;
  if (input.metadataSha256) manifest.metadataSha256 = input.metadataSha256;
  return manifest;
}

/**
 * An HTTP date (`Wed, 27 Dec 2023 00:48:48 GMT`) down to `YYYY-MM-DD`, in UTC.
 *
 * Returns `undefined` on anything unparseable so a weird header degrades to "unverified" rather
 * than to a confident mismatch.
 */
export function toIsoDate(httpDate: string): string | undefined {
  const ms = Date.parse(httpDate);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10);
}

/** A one-line summary per state, for the README's run table. */
export function nhdRunTableRow(manifest: NhdManifest): string {
  const bytes = manifest.bytesVerified
    ? '✓'
    : `**SHORT ${manifest.bytes} of ${manifest.expectedBytes}**`;
  const frozen =
    manifest.frozenAsExpected === true
      ? '✓'
      : manifest.frozenAsExpected === false
        ? `**MOVED → ${manifest.lastModified}**`
        : '— (unverified)';
  return `| ${manifest.state} | \`${manifest.filename}\` | ${bytes} | ${frozen} | \`${manifest.sha256.slice(0, 16)}…\` | ${manifest.fetchedAt.slice(0, 10)} |`;
}

export const NHD_RUN_TABLE_HEADER = [
  '| State | Geodatabase | Bytes | Frozen 2023-12-27 | sha256 | Captured |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');
