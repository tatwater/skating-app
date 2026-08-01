/**
 * Extract provenance for the water ETL — pinning the OSM snapshot a corpus was built from.
 *
 * ## Why this exists
 *
 * This ETL's README has said, since Phase 1, to *"record the md5 + Geofabrik replication timestamp
 * in the run table"* — because Geofabrik rebuilds its `-latest` extracts **daily**, so a download
 * date alone pins nothing. The Phase 2.5 run then recorded, for all five states:
 *
 * > *"md5s not captured this run — record them per state on the next re-run (dated build no longer
 * > retrievable to hash retroactively)."*
 *
 * So the exact OSM snapshot behind our 116,070 bodies is unrecoverable. That is provenance by human
 * memory failing exactly the way it fails, on the corpus the entire product sits on.
 *
 * The fix is the one N6b's bathymetry archive already uses: capture it mechanically at fetch time,
 * into a `.raw/` that is never deleted, with a manifest recording what a filename cannot.
 *
 * **This does not recover the current corpus's provenance** — nothing can. It makes the *next*
 * import reproducible, and it means the question "which OSM snapshot is this body from?" has an
 * answer from then on.
 *
 * ## The pin is the resolved URL, not the requested one
 *
 * `…/vermont-latest.osm.pbf` is a redirect. Following it lands on `…/vermont-260731.osm.pbf`, a
 * dated build that stays retrievable for months. Recording the URL we *asked for* pins nothing;
 * recording the one we *got* pins everything. That distinction is the whole mechanism, and it is
 * exactly what a hand-written run note loses.
 *
 * Pure manifest logic lives here and is tested; the download itself is glue in `fetchExtract.ts`.
 */

/** One state's Geofabrik extract. */
export interface ExtractSource {
  /** Two-letter state code, matching the loader's `--state=` tag. */
  state: string;
  /** Geofabrik's slug under `north-america/us`. */
  slug: string;
  /**
   * A bbox to clip to after download, when the raw extract covers more than our region.
   * New York's does: the corpus deliberately stops well south of every skated lake.
   */
  clipBBox?: [number, number, number, number];
}

export const GEOFABRIK_BASE = 'https://download.geofabrik.de/north-america/us';

/**
 * The five states the corpus covers.
 *
 * NY's clip is inherited from the Phase 2.5 runbook rather than reinvented: 41.3°N sits well south
 * of Lake George (~43.4) and Saranac/Placid (~44.3), and keeping the downstate metro out is what
 * stops a third of the corpus being water nobody skates.
 */
export const EXTRACT_SOURCES: ExtractSource[] = [
  { state: 'VT', slug: 'vermont' },
  { state: 'NH', slug: 'new-hampshire' },
  { state: 'ME', slug: 'maine' },
  { state: 'MA', slug: 'massachusetts' },
  { state: 'NY', slug: 'new-york', clipBBox: [-79.9, 41.3, -71.8, 45.1] },
];

export function extractUrl(source: ExtractSource): string {
  return `${GEOFABRIK_BASE}/${source.slug}-latest.osm.pbf`;
}

export function checksumUrl(source: ExtractSource): string {
  return `${extractUrl(source)}.md5`;
}

/** What a `.raw/<state>/manifest.json` records for one extract. */
export interface ExtractManifest {
  state: string;
  slug: string;
  /** ISO-8601, injected rather than read from the clock so the writer stays pure. */
  fetchedAt: string;
  /** The URL we asked for — always the `-latest` alias. */
  requestedUrl: string;
  /**
   * The URL we were redirected to: a **dated** build. This is the pin. Absent only if the server
   * stopped redirecting, which is itself worth noticing.
   */
  resolvedUrl?: string;
  /** The dated build id parsed out of `resolvedUrl` (e.g. `260731`), when there is one. */
  buildDate?: string;
  filename: string;
  bytes: number;
  /** Our hash of the bytes on disk. */
  sha256: string;
  /** Geofabrik's own published md5, and whether the download matched it. */
  publishedMd5?: string;
  md5Verified?: boolean;
  clipBBox?: [number, number, number, number];
}

/**
 * Parse Geofabrik's `.md5` file: `<hash>  <filename>`.
 *
 * Returns `undefined` rather than throwing on an unexpected shape — a missing checksum should
 * degrade to "unverified", which the manifest records honestly, rather than fail a 500 MB download
 * that already succeeded.
 */
export function parsePublishedMd5(body: string): string | undefined {
  const match = /^([0-9a-f]{32})\s/i.exec(body.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * The dated build id out of a resolved Geofabrik URL (`vermont-260731.osm.pbf` → `260731`).
 *
 * Deliberately refuses to match `latest`: if the redirect ever stops happening we want an absent
 * build date, not the string "latest" sitting in the provenance record looking like a version.
 */
export function parseBuildDate(resolvedUrl: string | undefined): string | undefined {
  if (!resolvedUrl) return undefined;
  const match = /-(\d{6})\.osm\.pbf$/.exec(resolvedUrl);
  return match?.[1];
}

/** A stable, filesystem-safe archive key for a state's extract. */
export function archiveKey(source: ExtractSource): string {
  return source.state.toLowerCase();
}

export interface BuildExtractManifestInput {
  source: ExtractSource;
  fetchedAt: string;
  resolvedUrl?: string;
  filename: string;
  bytes: number;
  sha256: string;
  publishedMd5?: string;
  actualMd5?: string;
}

/** Assemble an extract manifest, deciding the one derived fact: whether the checksum matched. */
export function buildExtractManifest(input: BuildExtractManifestInput): ExtractManifest {
  const manifest: ExtractManifest = {
    state: input.source.state,
    slug: input.source.slug,
    fetchedAt: input.fetchedAt,
    requestedUrl: extractUrl(input.source),
    filename: input.filename,
    bytes: input.bytes,
    sha256: input.sha256,
  };
  if (input.resolvedUrl && input.resolvedUrl !== manifest.requestedUrl) {
    manifest.resolvedUrl = input.resolvedUrl;
  }
  const buildDate = parseBuildDate(input.resolvedUrl);
  if (buildDate) manifest.buildDate = buildDate;
  if (input.publishedMd5) {
    manifest.publishedMd5 = input.publishedMd5;
    // Only claimed when both sides are present. "We didn't check" and "it didn't match" are very
    // different facts, and collapsing them is how a truncated download gets loaded.
    if (input.actualMd5)
      manifest.md5Verified = input.actualMd5.toLowerCase() === input.publishedMd5;
  }
  if (input.source.clipBBox) manifest.clipBBox = input.source.clipBBox;
  return manifest;
}

/**
 * A one-line summary per state, for the README's run table.
 *
 * The run table exists and has been empty since 2026-07-15 because filling it in was a manual step.
 * Generating it is the difference between a discipline and a habit.
 */
export function runTableRow(manifest: ExtractManifest): string {
  const verified =
    manifest.md5Verified === true
      ? '✓'
      : manifest.md5Verified === false
        ? '**MISMATCH**'
        : '— (unverified)';
  return `| ${manifest.state} | \`${manifest.filename}\` | ${manifest.buildDate ?? '—'} | \`${manifest.sha256.slice(0, 16)}…\` | ${verified} | ${manifest.fetchedAt.slice(0, 10)} |`;
}

export const RUN_TABLE_HEADER = [
  '| State | Extract | Geofabrik build | sha256 | md5 | Captured |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');
