/**
 * The three depth datasets, their provenance, and the manifest that pins a download (N6a).
 *
 * Written because this ETL's README called its own provenance story *"the weakest part of this
 * runbook"* — three downloads recorded as a date in someone's run notes. `scripts/bathymetry` and
 * `scripts/etl` both solved this properly; this adopts the same shape rather than reinventing it.
 *
 * The pure parts live here so they can be tested; the network and file glue is in `./archiveCli`.
 */

/** How a source can be acquired. The distinction is not cosmetic — see `manual` below. */
export type DepthFetchSpec =
  | {
      kind: 'direct';
      /** A plain HTTPS URL that returns the payload with no auth and no interstitial. */
      url: string;
      filename: string;
    }
  | {
      kind: 'figshare';
      /** Article id — the API gives a download URL, byte count, publisher md5 *and* the licence. */
      articleId: number;
      /** Which file in the article; articles routinely hold several. */
      filename: string;
    }
  | {
      /**
       * **Cannot be fetched by a script.** Not a "we haven't got round to it" — the EDI portal puts
       * `edi.1043.1` behind a login with a Cloudflare Turnstile CAPTCHA, and PASTA's public API
       * refuses `listDataEntities` and the metadata endpoint for this package (both checked
       * 2026-08-02). A human with a browser downloads it; `archive --adopt` then turns that file
       * into a checksummed, manifested archive entry so the provenance is no worse for it.
       */
      kind: 'manual';
      /** Where a human goes to get it. */
      portalUrl: string;
      /** What the downloaded file is expected to be called, for the adopt hint. */
      filename: string;
    };

export interface DepthSource {
  key: string;
  label: string;
  /** Who published it, for attribution and for the run row. */
  publisher: string;
  /**
   * The licence **as we believe it to be before downloading**. Recorded separately from what the
   * archive actually reports, because for LAGOS-US the whole open question is that we do not know:
   * `undefined` here means "read it off the package and write it down", not "no licence".
   */
  expectedLicence?: string;
  fetch: DepthFetchSpec;
  /** What this source contributes to the D68 ladder — mean, max, or both. */
  provides: ('mean' | 'max')[];
  notes?: string;
}

export const DEPTH_SOURCES: DepthSource[] = [
  {
    key: 'hydrolakes',
    label: 'HydroLAKES v1.0 polygons',
    publisher: 'HydroSHEDS / WWF',
    expectedLicence: 'CC-BY 4.0',
    fetch: {
      kind: 'direct',
      url: 'https://data.hydrosheds.org/file/hydrolakes/HydroLAKES_polys_v10.gdb.zip',
      filename: 'HydroLAKES_polys_v10.gdb.zip',
    },
    provides: ['mean'],
    notes:
      'Mean depth is Vol_total / Lake_area, and Vol_src distinguishes reported from modelled. Includes lakes ≥ 10 ha only, which is ~7% of our corpus and ~100% of what draws at regional zoom.',
  },
  {
    key: 'globathy',
    label: 'GLOBathy basic parameters (Dmax)',
    publisher: 'Khazaei et al. / figshare',
    expectedLicence: 'CC0 1.0',
    fetch: { kind: 'figshare', articleId: 13_402_070, filename: 'GLOBathy_basic_parameters.zip' },
    provides: ['max'],
    notes:
      'Keyed to HydroLAKES by Hylak_id — it is an attribute table with no geometry of its own. The bathymetry RASTERS in the same collection are permanently out of scope (D-note in the N6b plan): they are distance-to-shore run through a linear equation.',
  },
  {
    key: 'lagos-us-depth',
    label: 'LAGOS-US DEPTH v1.0',
    publisher: 'Environmental Data Initiative (edi.1043.1)',
    /**
     * **Read off the package page 2026-08-02, closing the phase's oldest open question.** CC BY 4.0
     * — so this is not a free-to-use source: it carries an **attribution obligation** the app has to
     * discharge, same as HydroLAKES. See `DEPTH_SOURCE_TERMS` in `@skating/core`.
     *
     * Recorded here as what we read; `--adopt` still requires `--licence` to be passed explicitly,
     * because the package can be revised and the human doing the download is the one who can see
     * whether the statement has changed under us. The statement itself asks for exactly that: *"data
     * are updated periodically and it is the responsibility of the Data User to check for new
     * versions"*.
     */
    expectedLicence: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
    fetch: {
      kind: 'manual',
      portalUrl: 'https://portal.edirepository.org/nis/mapbrowse?packageid=edi.1043.1',
      filename: 'lagos_depth.csv',
    },
    provides: ['mean', 'max'],
    notes:
      "The only MEASURED source of the three — ~65 compiled surveys, 17,675 max depths and 6,137 means. Licence read 2026-08-02: CC BY 4.0, so it carries an attribution obligation (see DEPTH_SOURCE_TERMS). Column names are confirmed against the package's own data_dictionary_depth, archived alongside; the transform also matches headers case-insensitively and raises a named error listing what it did find, so a mismatch fails loudly rather than importing zero depths silently.",
  },
];

/** A file inside an archived source. */
export interface DepthArchiveFile {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * What `.raw/<key>/manifest.json` holds.
 *
 * Same job as the OSM and bathymetry manifests: make a download reproducible without anyone
 * remembering anything. `licence` is the field this ETL specifically needed — the N6a open question
 * is *"confirm the Intellectual Rights statement at download"*, and a confirmation that lives in a
 * terminal is not a confirmation.
 */
export interface DepthManifest {
  key: string;
  label: string;
  publisher: string;
  fetchedAt: string;
  source: { url: string; kind: DepthFetchSpec['kind'] };
  files: DepthArchiveFile[];
  /** As reported by the publisher at fetch time, or typed in by whoever adopted a manual download. */
  licence?: string;
  /** Publisher-provided checksum, when there is one to compare against. */
  publishedMd5?: string;
  /** Whether that comparison actually ran and passed. Absent ≠ failed — see `checksumState`. */
  md5Verified?: boolean;
  /** True when a human downloaded this by hand (see the `manual` fetch kind). */
  adopted?: boolean;
  notes?: string;
}

/**
 * The three genuinely different checksum outcomes, which a boolean cannot express.
 *
 * `unverified` and `mismatch` look identical in a `md5Verified: false`, and they mean opposite
 * things: one is "the publisher offered nothing to check against", the other is "the bytes are
 * wrong". Conflating them is how a corrupted 763 MB download gets imported.
 */
export type ChecksumState = 'verified' | 'unverified' | 'mismatch';

export function checksumState(manifest: DepthManifest): ChecksumState {
  if (manifest.publishedMd5 === undefined) return 'unverified';
  return manifest.md5Verified ? 'verified' : 'mismatch';
}

/**
 * A licence short enough to sit in a status line.
 *
 * Rights statements are paragraphs — LAGOS-US' is 1,100 characters — and pasting one verbatim into
 * a one-line-per-source summary buries the other four sources under it. The full text stays in the
 * manifest, which is the thing that has to be complete; this is for the reader who wants to know
 * *which* licence at a glance.
 */
export function shortLicence(licence: string | undefined): string {
  if (!licence?.trim()) return 'UNRECORDED';
  const text = licence.trim();
  // The recognisable identifier is what a reader is scanning for, and it is almost always in the
  // first clause. Fall back to a hard truncation rather than inventing a label we cannot verify.
  const known = text.match(
    /CC0[\s-]?1\.0|CC[\s-]?BY[\s-]?(?:-?SA)?[\s-]?4\.0|CC-BY|CC BY|ODbL[\s-]?1\.0|ODbL/i,
  );
  if (known) return known[0].replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Total archived bytes for a source. */
export function totalBytes(manifest: DepthManifest): number {
  return manifest.files.reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * Is this archive complete enough to run the ETL from?
 *
 * A source is only ready when it has at least one file **and** a licence recorded. The licence gate
 * is the point: LAGOS-US' rights statement has been an open question since the phase was scoped, and
 * an archive that imports cleanly while nobody has read it would close that question by forgetting
 * it rather than by answering it.
 */
export function isRunnable(manifest: DepthManifest): { ok: boolean; reason?: string } {
  if (manifest.files.length === 0) return { ok: false, reason: 'no files archived' };
  if (checksumState(manifest) === 'mismatch') {
    return {
      ok: false,
      reason: 'checksum mismatch — the download does not match what was published',
    };
  }
  if (!manifest.licence?.trim()) {
    return {
      ok: false,
      reason:
        "no licence recorded — read the source's rights statement and re-adopt with --licence",
    };
  }
  return { ok: true };
}
