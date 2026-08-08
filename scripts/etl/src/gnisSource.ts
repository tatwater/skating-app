/**
 * The GNIS gazetteer's constants and pure rules — **importable without fetching anything** (N7).
 *
 * ## Why this is a separate file
 *
 * These lived in `gnisArchive.ts`, which runs its `main()` at module scope. So
 * `import { GNIS_WATER_CLASSES } from './gnisArchive'` in `merge.ts` **re-ran the entire five-state
 * download as a side effect of starting a merge** — six `curl` calls and six `unzip`s before a single
 * lake was read, on every run, including a `--no-refresh` one that had no intention of touching the
 * network.
 *
 * `scripts/admin-areas/src/tiger.ts` was split out of `fetchStates.ts` for exactly this reason and
 * says so in its own header: *"That module runs its `main()` on import — importing a constant out of
 * it would have re-run the entire five-state fetch as a side effect."* The same trap, one package
 * over, found by the N7 audit's refactor rather than by anybody noticing the network traffic.
 *
 * The rule the two now share: **a module with a `main()` exports nothing anybody else needs.**
 */

import { join } from 'node:path';

/** Where the archive lands. Permanent and mirrored — see `gnisArchive.ts` for why it is not scratch. */
export const GNIS_DIR = new URL('../.raw-gnis/', import.meta.url).pathname;

/** The five states, by the code the staged filenames use. */
export const GNIS_STATE_CODES = ['ME', 'NH', 'VT', 'MA', 'NY'] as const;

export const gnisUrl = (code: string) =>
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_${code}_Text.zip`;

/** Where the extracted text lands, and what `merge` reads. */
export const gnisTextPath = (code: string) => join(GNIS_DIR, `DomesticNames_${code}.txt`);

/**
 * GNIS classes that describe a **body of water** rather than a line or a point.
 *
 * `Stream` and `Spring` are excluded deliberately: GNIS gives one coordinate per feature, and for a
 * stream that point is somewhere along its length. Letting it name the polygon it happens to fall
 * inside would christen a lake after the brook running through it.
 *
 * **`Harbor`, `Channel` and `Gut` were added by the N7 audit.** The first four map cleanly onto
 * `lakePond`, `reservoir`, `wetland` and `bay` — and then stopped, which left our own `bay` class
 * half-served: GNIS files a great many tidal and semi-enclosed waters under `Harbor` and `Channel`,
 * and `Gut` is the New England term for a narrows. They are the same kind of feature `natural=bay`
 * and NHD's Estuary already reach us as, so excluding them made the gazetteer silent about a class we
 * do import.
 *
 * **`Basin` is deliberately not here**: GNIS uses it for drainage basins, which are regions rather
 * than water — and `NAME_DROP` refuses the word for the same reason.
 */
export const GNIS_WATER_CLASSES: ReadonlySet<string> = new Set([
  'Lake',
  'Reservoir',
  'Swamp',
  'Bay',
  'Harbor',
  'Channel',
  'Gut',
]);

/**
 * GNIS's "no coordinate" — and it is a **location**, not a blank.
 *
 * `0.0, 0.0` is in the Gulf of Guinea. Read as a position it would pile every unplaced feature into
 * one grid cell off the coast of Africa; read as a name source it would silently do nothing, which
 * is worse because nothing would say so. Same shape as NHD's `gnis_id = -1`, which would have
 * collapsed 855 unrelated lakes onto one body.
 */
export function isNullIsland(lat: number, lng: number): boolean {
  return lat === 0 && lng === 0;
}

/** The columns the merge reads out of the pipe-delimited gazetteer. */
export const GNIS_COLUMNS = {
  name: 'feature_name',
  class: 'feature_class',
  lat: 'prim_lat_dec',
  lng: 'prim_long_dec',
  /** D105's other half — the id the gazetteer is the authority for. */
  id: 'feature_id',
} as const;

/**
 * Locate the columns we read in a GNIS header row.
 *
 * Returns `undefined` for `id` rather than throwing, because a missing id costs a bridge where a
 * missing coordinate costs the whole lane — and only the latter is worth refusing to run over.
 */
export function gnisColumnIndexes(header: readonly string[]): {
  name: number;
  class: number;
  lat: number;
  lng: number;
  id: number | undefined;
} | null {
  const ix = (n: string) => header.indexOf(n);
  const found = {
    name: ix(GNIS_COLUMNS.name),
    class: ix(GNIS_COLUMNS.class),
    lat: ix(GNIS_COLUMNS.lat),
    lng: ix(GNIS_COLUMNS.lng),
    id: ix(GNIS_COLUMNS.id),
  };
  if (found.name < 0 || found.class < 0 || found.lat < 0 || found.lng < 0) return null;
  return { ...found, id: found.id < 0 ? undefined : found.id };
}
