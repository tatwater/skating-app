/**
 * **The `.raw/` response archive** — the whole reason this package is being rebuilt (N7-3).
 *
 * ## The regret this exists to prevent, stated plainly
 *
 * The 2026-08-02 wind pass requested `attributes: 'winddirection_10m,windspeed_10m'`, read
 * `cells[5]` and never touched `cells[6]`. It fetched wind **speed** on every one of its requests
 * and threw it away. Adding sustained-wind capture should therefore have been a two-minute local
 * recompute; instead it is a **7.7-hour, 5,225-request re-fetch against a shared daily quota**.
 *
 * `scripts/etl`, `scripts/bathymetry` and `scripts/lake-depth` all keep byte-faithful archives with
 * manifests and R2 mirrors. `wind-climate` was the only fetching ETL that fetched, parsed and
 * discarded. That asymmetry is the bug.
 *
 * So: **one gzipped file per response**, exactly as WTK served it, plus a manifest per cell. After
 * the one fetch, changing a threshold, adding a statistic or rebuilding from scratch is
 * `mirror-r2.sh pull` + `derive`.
 *
 * ## Why per-response files rather than five years concatenated per cell
 *
 * Object count is cheap (5,225 objects, ~0.37 GB gzipped against 10 GB of free tier), and
 * per-response granularity buys two things that matter more: a partial fetch resumes by simply
 * asking which files exist, and the archive stays honest about what each individual call returned.
 * A concatenation would have to be rewritten on every resume, which is how a byte-faithful archive
 * stops being byte-faithful.
 */

/** One archived response — one cell, one year. */
export interface ArchivedResponse {
  gridKey: string;
  year: number;
  /** The URL that produced it, **with the API key stripped**. See `redactApiKey`. */
  url: string;
  fetchedAt: string;
  /** sha256 of the *uncompressed* bytes, so it is comparable to what a re-fetch would return. */
  sha256: string;
  /** Bytes on disk, gzipped. */
  gzipBytes: number;
  /** Bytes as served. */
  rawBytes: number;
  /** CSV data rows, excluding WTK's two header lines. A point-year is ~8,760. */
  rows: number;
}

/** What `<gridKey>/manifest.json` records. */
export interface CellManifest {
  gridKey: string;
  /** The grid point the key resolves to — the coordinate actually requested. */
  point: { lat: number; lng: number };
  /** The years asked for, whether or not every one landed. */
  yearsRequested: number[];
  responses: ArchivedResponse[];
  archive: 'nrel-wind-toolkit';
  /** Recorded per cell rather than once, so a partial archive still states its own terms. */
  licence: string;
  attributes: string;
}

/**
 * WTK's terms, as they apply to us — recorded in every manifest rather than in a doc.
 *
 * The WIND Toolkit is a NREL/US DOE product distributed for public use; the API requires a key and
 * an email on each request, which is registration rather than a licence restriction. Stated at the
 * length it deserves and no further: this file records what we were told, and a claim we cannot
 * support is worse than a short one.
 */
export const WTK_LICENCE =
  'NREL WIND Toolkit (US DOE). Public data, free to use; the API requires a registered key and an ' +
  'email on every request. Attribution to NREL is expected where the data is shown.';

/**
 * Strip the API key out of a URL before it is written anywhere.
 *
 * **The manifest is the thing most likely to be shared** — mirrored to R2, pasted into a handoff,
 * read by whoever picks this up next — and the resolved URL is the single most useful field in it.
 * Those two facts collide in exactly one place, and this is it.
 */
export function redactApiKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, '$1REDACTED');
}

/** Archive-relative path for one response. Never absolute — the caller owns `.raw/`'s location. */
export function responsePath(gridKey: string, year: number): string {
  return `${gridKey}/${year}.csv.gz`;
}

export function manifestPath(gridKey: string): string {
  return `${gridKey}/manifest.json`;
}

/**
 * Which cell-years a run still has to fetch.
 *
 * **The whole incremental story is this function.** Hand it the cells and the years and it returns
 * the difference against what is already archived; a second run over an unchanged corpus returns
 * nothing and costs nothing. That is what makes the 7.7 hours a one-time cost rather than a
 * recurring one, and what lets a killed run resume by re-running the same command.
 */
export function missingResponses(
  gridKeys: readonly string[],
  years: readonly number[],
  have: ReadonlySet<string>,
): { gridKey: string; year: number }[] {
  const out: { gridKey: string; year: number }[] = [];
  for (const gridKey of gridKeys) {
    for (const year of years) {
      if (have.has(responsePath(gridKey, year))) continue;
      out.push({ gridKey, year });
    }
  }
  return out;
}

/**
 * Wall-clock estimate for a fetch, **from a measured per-request latency** rather than the pacing
 * delay.
 *
 * ⚠ This function exists because the old loader printed *"~96 min at 1/s"* for a job that takes
 * **7.7 hours**. It counted only the deliberate 1-second pause and ignored response latency, which
 * is 5.3 s — five times larger. An estimate that is wrong by 5× is worse than none, because
 * somebody plans around it.
 *
 * @param latencyMs measured, not assumed. One live WTK request took **5,300 ms** on 2026-08-02.
 */
export function estimateFetchMinutes(requests: number, latencyMs: number, delayMs: number): number {
  return Math.ceil((requests * (latencyMs + delayMs)) / 60_000);
}

/**
 * The measured per-request latency, in ms.
 *
 * **4,030 ms, from the full 2026-08-09 snapshot** — 5,910 responses over 8.55 hours, median
 * inter-request gap 5.13 s minus the fixed 1.10 s of pacing. It replaces 5,300 ms, which came from a
 * *single* request on 2026-08-02 and was 31% pessimistic.
 *
 * That single-sample figure was not wrong to use — it was the honest thing available, and the
 * estimate it produced (10.5 h against an actual 8.55 h) was good enough to plan around, which is
 * the whole point of measuring rather than guessing. It is replaced because a run of 5,910 is simply
 * a better instrument than a run of one, and because leaving it would let a stale number read as
 * authoritative.
 *
 * Kept as a constant so the estimate stays traceable to a measurement, and so replacing it means
 * taking a new one rather than adjusting a feeling.
 */
export const WTK_MEASURED_LATENCY_MS = 4_030;

/** Human-readable size, for the log line that tells somebody whether to worry about disk. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
