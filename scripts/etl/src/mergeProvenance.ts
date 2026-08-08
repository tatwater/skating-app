/**
 * The merge's **path**: every archived file that decided the corpus, as run stages (N7 provenance).
 *
 * ## Why this file exists
 *
 * `merge.ts` makes every admission decision in the phase and it already reads four families of
 * archive manifests in order to write `merge-manifest.json`. What it did *not* do was hand any of
 * that to its run row, so `/admin/imports` rendered the run that decided 25,050 bodies with an empty
 * Path and the line "the loader was given no provenance sidecars" — technically true, and useless:
 * the sidecars were all on disk, sitting in the same function.
 *
 * ## One file, one stage — and the family is in the name
 *
 * Seventeen archives is seventeen checksums, and rolling them into one `sources` stage would throw
 * away the only field that answers "is this the archive we think": `RunStage` carries exactly one
 * `sha256`, one URL, one date. So each file gets its own stage, named `source · osm/vt` — the
 * `STAGE_SEPARATOR` convention the admin page groups on, so the path still reads as five steps while
 * carrying twenty rows of evidence underneath.
 *
 * ## A missing archive is a stage that says so
 *
 * Never a silent absence. A merge whose GNIS archive is missing still produces a corpus — a
 * noticeably smaller one, because the gazetteer names 1,208 bodies and the area floor then admits
 * them — and the only place that fact can surface is here. So an unreadable manifest becomes a stage
 * with a `detail` saying it was unreadable, not an omission from the list.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  derivedFileStage,
  type ExtractManifest,
  extractStage,
  type GnisStateManifest,
  gnisStage,
  type NhdManifest,
  nhdStage,
  type RunStage,
  stageName,
  type ThreeDhpManifest,
  threeDhpClipStage,
  threeDhpSourceStage,
} from '@skating/run-log';

/** The family every archive stage is filed under. The admin page groups on it. */
export const SOURCE_FAMILY = 'source';
/** The two region masks — derived inputs with no upstream checksum of their own. */
export const MASK_FAMILY = 'mask';

/** Where each family of archives lives, relative to nothing — callers pass absolute paths. */
export interface MergeSourcePaths {
  /** `.raw/` — one `<state>/manifest.json` per Geofabrik extract. */
  osmDir: string;
  /** The OSM state directories, in the order the merge reads them. */
  osmStates: readonly string[];
  /** `.raw-nhd/` — one `<state>/manifest.json` per USGS geodatabase. */
  nhdDir: string;
  /** The NHD archive keys (directory names), in the order the merge reads them. */
  nhdKeys: readonly { key: string; state: string }[];
  /** `.raw-3dhp/` — `source/manifest.json` (the 12 GB download) and `waterbody/manifest.json`. */
  threeDhpDir: string;
  /** `.raw-gnis/manifest.json` — one file listing every state. */
  gnisManifest: string;
  /** The five-state TIGER mask the corpus is clipped to. */
  boundariesPath: string;
  /** New York below I-84 — in the five states, deliberately not in the corpus (D111). */
  downstatePath: string;
}

/**
 * Every archive the merge read, in the order it read them, as stages.
 *
 * Pure enough to test: the only I/O is reading files whose paths the caller supplies.
 */
export function buildSourceStages(paths: MergeSourcePaths): RunStage[] {
  const stages: RunStage[] = [];

  for (const state of paths.osmStates) {
    const name = stageName(SOURCE_FAMILY, `osm/${state}`);
    const manifest = readManifest<ExtractManifest>(join(paths.osmDir, state, 'manifest.json'));
    stages.push(
      manifest === undefined
        ? missing(name, join(paths.osmDir, state, 'manifest.json'), 'Geofabrik OSM extract')
        : extractStage(manifest, manifest.filename, name),
    );
  }

  for (const { key, state } of paths.nhdKeys) {
    const name = stageName(SOURCE_FAMILY, `nhd/${state}`);
    const path = join(paths.nhdDir, key, 'manifest.json');
    const manifest = readManifest<NhdManifest>(path);
    stages.push(
      manifest === undefined
        ? missing(name, path, 'USGS NHD geodatabase')
        : nhdStage(manifest, name),
    );
  }

  // Two stages, because they are two files with two checksums and only one of them still exists on
  // disk: the 11.9 GB national download is deleted after the clip is cut, and the clip is what the
  // merge reads. Collapsing them would lose whichever half you did not keep.
  const dhpSourcePath = join(paths.threeDhpDir, 'source', 'manifest.json');
  const dhpSource = readManifest<ThreeDhpManifest>(dhpSourcePath);
  stages.push(
    dhpSource === undefined
      ? missing(stageName(SOURCE_FAMILY, '3dhp/download'), dhpSourcePath, '3DHP national release')
      : threeDhpSourceStage(dhpSource, stageName(SOURCE_FAMILY, '3dhp/download')),
  );
  const dhpClipPath = join(paths.threeDhpDir, 'waterbody', 'manifest.json');
  const dhpClip = readManifest<ThreeDhpManifest>(dhpClipPath);
  stages.push(
    dhpClip === undefined
      ? missing(stageName(SOURCE_FAMILY, '3dhp/clip'), dhpClipPath, '3DHP Northeast waterbody clip')
      : threeDhpClipStage(dhpClip, stageName(SOURCE_FAMILY, '3dhp/clip')),
  );

  // GNIS is one manifest listing every state, so a missing file costs the whole gazetteer at once —
  // and one stage saying that is clearer than five identical "missing" rows.
  const gnis = readManifest<{ states?: GnisStateManifest[] }>(paths.gnisManifest);
  if (gnis === undefined) {
    stages.push(
      missing(
        stageName(SOURCE_FAMILY, 'gnis'),
        paths.gnisManifest,
        'GNIS Domestic Names gazetteer',
      ),
    );
  } else {
    for (const state of gnis.states ?? []) {
      stages.push(gnisStage(state, stageName(SOURCE_FAMILY, `gnis/${state.code ?? '??'}`)));
    }
  }

  stages.push(
    maskStage({
      name: stageName(MASK_FAMILY, 'five-state'),
      detail:
        'TIGER states + counties at full fidelity — the outline the merged corpus is clipped to. ' +
        'Read from disk rather than from Convex on purpose: the Convex copy is simplified to fit ' +
        'the 8,192-element array cap, and clipping against a coarsened boundary moves bodies.',
      path: paths.boundariesPath,
    }),
    maskStage({
      name: stageName(MASK_FAMILY, 'downstate-ny'),
      detail:
        'New York south of I-84 (D111) — in the five states, deliberately not in the corpus. Cut ' +
        'from the same TIGER counties as the basemap mask so the line on the map and the line in ' +
        'the corpus cannot drift apart.',
      path: paths.downstatePath,
    }),
  );

  return stages;
}

/** A derived mask, fingerprinted — or a stage that says the merge could not find it. */
function maskStage(input: { name: string; detail: string; path: string }): RunStage {
  if (!existsSync(input.path)) return missing(input.name, input.path, 'region mask');
  const bytes = readFileSync(input.path);
  return derivedFileStage({
    name: input.name,
    detail: input.detail,
    path: input.path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    producer: 'pnpm --filter @skating/admin-areas build-region',
  });
}

/**
 * The stage for an archive that was not there.
 *
 * Deliberately not an omission: a corpus built without one of its four catalogues is a *different
 * corpus*, and the run row is the only place that can be noticed after the fact.
 */
function missing(name: string, path: string, what: string): RunStage {
  return { name, detail: `MISSING — no readable manifest for this ${what} at ${path}` };
}

/** A JSON manifest, or `undefined` if it is absent or unparseable. Never throws. */
function readManifest<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** What `merge.ts` writes to `.scratch/merge/merge-manifest.json` for its consumers to replay. */
export interface MergeManifestFile {
  producedAt?: string;
  campaignId?: string;
  stages?: RunStage[];
  outputs?: Record<string, number>;
}

/** The name of the file, stated once — both loaders discover it by convention, not by flag. */
export const MERGE_MANIFEST_FILENAME = 'merge-manifest.json';

/**
 * The merge manifest that produced this input file, if there is one.
 *
 * **Discovery rather than a flag, because a flag is exactly what gets forgotten.**
 * `run-canonical.sh` exists because the interesting arguments are the easy-to-drop ones — and the
 * N7 path had no wrapper at all, so the pass that loaded the entire corpus was invoked with
 * `--campaign=` and nothing else, producing a run row labelled "unscoped canonical water" with an
 * empty Path. The complete record has to be what happens when nobody types anything.
 *
 * `override` covers the one case discovery cannot: an NDJSON copied away from the manifest that
 * produced it. Unreadable is treated as absent — a hole in the provenance never fails a load.
 */
export function loadMergeProvenance(
  inputPath: string,
  override?: string,
): { path: string; manifest: MergeManifestFile } | undefined {
  const path = override ?? join(dirname(inputPath), MERGE_MANIFEST_FILENAME);
  const manifest = readManifest<MergeManifestFile>(path);
  return manifest === undefined ? undefined : { path, manifest };
}
