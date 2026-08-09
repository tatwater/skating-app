/**
 * The 3DEP elevation archive — **the durable half**, so the four-hour pass happens once (N7-2).
 *
 * ## Why an archive at all, for a field that is one number
 *
 * `HANDOFF-wind-climate-archive.md` was written after the wind pass fetched, parsed and discarded
 * — and adding one derived statistic then cost a **7.7-hour re-fetch** that should have been a
 * two-minute local recompute. Its conclusion, stated as a rule: *"archive whole responses so the
 * next 'could we also derive X?' costs minutes."*
 *
 * This is that rule applied before the mistake rather than after it. The EPQS pass is ~4 hours; the
 * questions already queued against it are a tidal referee, a datum comparison against the 5,693
 * rows Open-Meteo stamped, and D104's *"re-stamp the lakes that came from a coarse raster"*. Each of
 * those is a local read here, and none of them is a second pass over the network.
 *
 * ## Keyed on the COORDINATE, never on a body id
 *
 * That is what makes the archive survive a corpus rebuild. The N7 campaign re-mints `waterBodies`
 * rows every run; a lake whose polygon did not change has the same interior point next campaign, so
 * its entry is reused and no request is spent. Keying on `waterBodyId` would discard the whole
 * archive every time the merge ran — which is the difference between "only new bodies" (D104's
 * stated recurring cost, *"near zero"*) and "everything, annually".
 *
 * It also means the archive is readable by the **merge**, which has no Convex ids at all and needs
 * elevation before a body exists in order to refuse a tidal one.
 *
 * ## Shape on disk
 *
 * ```
 * scripts/lake-depth/.raw-elevation/readings.ndjson   ← one line per coordinate, append-only
 * scripts/lake-depth/.raw-elevation/manifest.json     ← what a filename cannot record
 * ```
 *
 * One file rather than one-per-response, unlike `scripts/bathymetry`'s `page-*.json.gz`: a response
 * here is ~200 bytes against that one's ~270 kB, so 25,000 files would be all inode and no data. The
 * per-response granularity those archives buy — partial-fetch resume — is bought here instead by
 * the file being append-only and keyed, so a re-run reads what is there and asks only for the rest.
 */

import type { EpqsReading } from './epqs';

/** One archived reading: the key, the response, and when we asked. */
export interface ElevationArchiveEntry extends EpqsReading {
  /** `coordinateKey(lat, lng)` — see `epqs.ts` for why five places. */
  key: string;
  lat: number;
  lng: number;
  /** ISO-8601, injected rather than read from a clock so the writer stays pure and testable. */
  fetchedAt: string;
}

/** What `.raw-elevation/manifest.json` records about the archive as a whole. */
export interface ElevationArchiveManifest {
  archive: 'usgs-3dep-epqs';
  /** The service, so the archive names its own provenance without a reader consulting this file. */
  sourceUrl: string;
  /**
   * The licence, recorded because `depthSources.ts` made it a gate and the reasoning carries:
   * an archive with no rights statement is one nobody can safely act on later.
   *
   * 3DEP is a USGS product and US federal government works are **public domain** (17 U.S.C. § 105).
   */
  licence: string;
  fetchedAt: string;
  entries: number;
  /** Distribution of source-raster resolutions, so a coarse-DEM cohort is visible rather than latent. */
  resolutionsM: Record<string, number>;
  /** Points EPQS answered but we refused, by reason. Zero is the expected value for both. */
  refusals: Record<string, number>;
}

/**
 * Fold newly-fetched entries into what the archive already holds.
 *
 * **Last write wins per key, and that is deliberate rather than incidental.** A re-fetch happens
 * for exactly one reason — `--refresh`, when 3DEP has improved under us (D104: *"a lake stamped
 * from a 30 m raster can be re-stamped from 1 m later"*) — so the new reading is the better one by
 * construction. Ordinary incremental runs never re-ask for a key that is present, so this path is
 * not reached at all.
 *
 * Order is preserved for the keys already present, so a diff between two runs shows the additions
 * at the end rather than reshuffling 25,000 lines.
 */
export function mergeArchiveEntries(
  existing: readonly ElevationArchiveEntry[],
  fetched: readonly ElevationArchiveEntry[],
): ElevationArchiveEntry[] {
  const byKey = new Map<string, ElevationArchiveEntry>();
  for (const entry of existing) byKey.set(entry.key, entry);
  for (const entry of fetched) byKey.set(entry.key, entry);
  return [...byKey.values()];
}

/**
 * Which of these points the archive cannot answer — the set a run actually has to fetch.
 *
 * The whole incremental story is this function: hand it the corpus and it returns the difference.
 * A second run over an unchanged corpus returns nothing and costs nothing, which is what D104 means
 * by *"we only have to do this once"*.
 */
export function missingKeys(
  points: readonly { lat: number; lng: number }[],
  archived: ReadonlySet<string>,
  keyOf: (lat: number, lng: number) => string,
): { lat: number; lng: number; key: string }[] {
  const out: { lat: number; lng: number; key: string }[] = [];
  // A corpus legitimately contains two bodies whose interior points round to one key — a pond and
  // the arm beside it. Asking twice would spend a request to learn the same number, so the run's
  // own dedup happens here rather than in the fetch loop.
  const queued = new Set<string>();
  for (const p of points) {
    const key = keyOf(p.lat, p.lng);
    if (archived.has(key) || queued.has(key)) continue;
    queued.add(key);
    out.push({ lat: p.lat, lng: p.lng, key });
  }
  return out;
}

/**
 * Summarise the resolutions present, for the manifest and the run row.
 *
 * **Banded rather than exact**, because 3DEP reports a float and the interesting question is
 * categorical: how much of the corpus came from 1 m LiDAR, and how much from the 10 m or 30 m
 * fallback that D104 says should eventually be re-stamped.
 */
export function resolutionBands(
  entries: readonly Pick<ElevationArchiveEntry, 'resolutionM'>[],
): Record<string, number> {
  const bands: Record<string, number> = {};
  for (const e of entries) {
    const r = e.resolutionM;
    const band =
      r === undefined
        ? 'unreported'
        : r <= 1.5
          ? '1m'
          : r <= 4
            ? '3m'
            : r <= 12
              ? '10m'
              : r <= 35
                ? '30m'
                : 'coarser than 30m';
    bands[band] = (bands[band] ?? 0) + 1;
  }
  return bands;
}

/**
 * Bodies whose stored elevation disagrees with 3DEP by more than `toleranceM`.
 *
 * D101 asked for exactly this before any switch: *"a source swap that silently changes a datum
 * would move every decile in `regionStats` and look like a data-quality improvement."* So the
 * comparison runs first and is reported, rather than being discovered afterwards in a chart.
 *
 * Returns the signed delta `threeDep - stored`, so a systematic bias shows as a one-sided
 * distribution rather than averaging itself away — which is what a datum shift looks like and what
 * an accuracy improvement does not.
 */
export function elevationDeltas<T extends { elevationM: number; lat: number; lng: number }>(
  stored: readonly T[],
  archived: ReadonlyMap<string, ElevationArchiveEntry>,
  keyOf: (lat: number, lng: number) => string,
): { body: T; threeDepM: number; deltaM: number }[] {
  const out: { body: T; threeDepM: number; deltaM: number }[] = [];
  for (const body of stored) {
    const entry = archived.get(keyOf(body.lat, body.lng));
    if (entry === undefined) continue;
    out.push({
      body,
      threeDepM: entry.elevationM,
      deltaM: entry.elevationM - body.elevationM,
    });
  }
  return out;
}
