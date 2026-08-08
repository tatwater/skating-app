/**
 * Classify **every feature in all three catalogues** and report the funnel — N7, read-only.
 *
 *   pnpm --filter @skating/etl classify-dry-run              # all three lanes
 *   pnpm --filter @skating/etl classify-dry-run --osm        # one lane at a time
 *   pnpm --filter @skating/etl classify-dry-run --nhd --3dhp
 *   pnpm --filter @skating/etl classify-dry-run --refresh    # re-extract, ignoring the cache
 *
 * ## What it answers, and why each number is separate
 *
 * The question is not "how many bodies do we get" — it is **"where did each answer come from"**,
 * because the five origins fail in five different ways and a single total hides all of them:
 *
 * | origin | what a bad number there would mean |
 * | --- | --- |
 * | kept on the catalogue's own class | our vocabulary map has a hole |
 * | kept on a **name keyword** | we are inferring where the source could have told us |
 * | **dropped** on the catalogue's class | we are refusing a class we should carry |
 * | dropped on a name keyword | a drop-word is deleting real water — the `Higley Flow` failure |
 * | **unresolved** | the honest residue, and the only one worth reading one row at a time |
 *
 * The last group is written out in full (`.scratch/classify/unresolved-<lane>.tsv`) rather than
 * counted, because it is the list that tells us what the tables are still missing. Everything above
 * it is a number; that one is evidence.
 *
 * ## Read-only, and pre-merge
 *
 * Nothing here touches Convex and nothing writes to an archive. It reads the same bytes the campaign
 * will read and applies `classifyWaterBody` exactly as the merge will, so a surprise here is a
 * surprise found before anything is upserted.
 *
 * **The only filter applied is the one-acre hard floor** (D96 rule 1), and that is deliberate: it is
 * the sole admission rule no other source can overturn. Every other rule reads `name` or `type`,
 * both of which the merge can *change* — applying them per-source before merging is precisely the
 * defect that deleted 123 bodies NHD classes as LakePond.
 */

import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type ClassBasis,
  classifyNhd,
  classifyOsmTags,
  classifyThreeDhp,
  classifyWaterBody,
  HARD_MIN_SURFACE_AREA_SQM,
  type OsmTagBag,
  surfaceAreaSqM,
  type WaterBodyClass,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { osmExportArgs, osmFilterArgs } from './extract';
import { NHD_SOURCES, nhdArchiveKey, normalizeNhdId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch', 'classify');
const OSM_DIR = join(HERE, '..', '.raw');
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const THREE_DHP_DIR = join(HERE, '..', '.raw-3dhp', 'waterbody');

/** RFC 8142 record separator (U+001E), which a geojsonseq line may be prefixed with. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** The five extracts, by the directory name `fetchExtract` writes. */
const OSM_STATES = ['me', 'nh', 'vt', 'ma', 'ny'] as const;

function log(message: string): void {
  process.stderr.write(`[classify] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The tally
// ─────────────────────────────────────────────────────────────────────────────

interface Unresolved {
  readonly id: string;
  readonly name: string;
  readonly acres: number;
  readonly token: string;
}

class Funnel {
  readonly byClass = new Map<WaterBodyClass, number>();
  readonly byBasis = new Map<ClassBasis, number>();
  readonly dropTokens = new Map<string, number>();
  /** Values a source carried that our tables have never seen — the table's own to-do list. */
  readonly unknownTokens = new Map<string, number>();
  readonly unresolvedNamed: Unresolved[] = [];
  total = 0;
  belowFloor = 0;
  scored = 0;

  constructor(readonly lane: string) {}

  add(id: string, name: string, areaSqM: number, claim: ReturnType<typeof classifyOsmTags>): void {
    this.total++;
    if (areaSqM < HARD_MIN_SURFACE_AREA_SQM) {
      this.belowFloor++;
      return;
    }
    this.scored++;
    // A `?` suffix is `waterClass`'s marker for "the source said something we do not map".
    if (claim.token.endsWith('?')) bump(this.unknownTokens, claim.token);

    const verdict = classifyWaterBody({ name, claim });
    bump(this.byBasis, verdict.basis);
    if (verdict.cls === null) {
      bump(this.dropTokens, verdict.token);
      return;
    }
    bump(this.byClass, verdict.cls);
    if (verdict.basis === 'unresolved-named') {
      this.unresolvedNamed.push({
        id,
        name,
        acres: Math.round(areaSqM / 4046.8564224),
        token: verdict.token,
      });
    }
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// OSM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the water polygons from one state's `.pbf`, cached.
 *
 * The filter is a **superset** of what we import — the same one `README.md` §2 documents — because
 * the classifier makes the call, not the extractor. If this list ever narrows, the dry run stops
 * being able to see what it is refusing.
 */
function osmFeatures(state: string, refresh: boolean): string {
  const out = join(SCRATCH, `osm-${state}.geojsonseq`);
  if (existsSync(out) && !refresh) return out;

  const dir = join(OSM_DIR, state);
  const { filename } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    filename: string;
  };
  const filtered = join(SCRATCH, `osm-${state}.pbf`);
  log(`${state}: filtering water features…`);
  // Shared argv (`./extract`), because the dry run's whole job is to report what the merge will do —
  // and it cannot do that if the two extract different features. The NHD read below is deliberately
  // *not* shared: it wants attributes with no floor, which is a different question.
  const step1 = spawnSync('osmium', osmFilterArgs(join(dir, filename), filtered), {
    encoding: 'utf8',
  });
  if (step1.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${step1.status}`);

  const step2 = spawnSync('osmium', osmExportArgs(filtered, out), { encoding: 'utf8' });
  if (step2.status !== 0) throw new Error(`${state}: osmium export exited ${step2.status}`);
  return out;
}

async function runOsm(refresh: boolean): Promise<Funnel> {
  const funnel = new Funnel('OSM');
  // The five extracts overlap at every border, so a body would otherwise be counted twice — and the
  // duplicate is not harmless, because the two copies can carry different tags.
  const seen = new Set<string>();

  for (const state of OSM_STATES) {
    const file = osmFeatures(state, refresh);
    log(`${state}: classifying…`);
    const reader = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const raw of reader) {
      // RFC 8142 allows a record separator before each line. `osmium` is invoked with
      // `print_record_separator=false`, but a stray one would fail `JSON.parse` and silently skip a
      // whole state, so it is stripped by hand — as a string, because a control character inside a
      // regular expression is exactly as unreadable as the lint rule says it is.
      const trimmed = raw.trim();
      const line = trimmed.startsWith(RECORD_SEPARATOR) ? trimmed.slice(1) : trimmed;
      if (line.length === 0) continue;
      let feature: {
        properties: OsmTagBag & {
          '@type'?: string;
          '@id'?: string | number;
          name?: string;
        };
        geometry: Polygon | MultiPolygon | null;
      };
      try {
        feature = JSON.parse(line);
      } catch {
        continue;
      }
      const props = feature.properties;
      const osmType = props['@type'];
      const osmId = props['@id'];
      if (!osmType || osmId === undefined || !feature.geometry) continue;
      const id = `${osmType}/${osmId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      funnel.add(id, props.name ?? '', surfaceAreaSqM(feature.geometry), classifyOsmTags(props));
    }
  }
  return funnel;
}

// ─────────────────────────────────────────────────────────────────────────────
// NHD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull attributes only — **no geometry**, which is what makes this lane cheap.
 *
 * `areasqkm` is the publisher's own figure, so the floor is applied without reading a single
 * coordinate. Field names are lower-case in the geodatabase and upper-case from the REST service;
 * this reads the archive, so it uses the archive's spelling.
 */
function nhdAttributes(state: string, zipPath: string, refresh: boolean): string {
  const out = join(SCRATCH, `nhd-${state}.csv`);
  if (existsSync(out) && !refresh) return out;
  // `-overwrite` does not replace an existing CSV *file* datasource — ogr2ogr reports "attempt to
  // create csv layer against a non-directory datasource" and exits 1. Remove it ourselves.
  rmSync(out, { force: true });
  log(`${state}: reading NHDWaterbody attributes…`);
  const res = spawnSync(
    'ogr2ogr',
    [
      '-f',
      'CSV',
      out,
      `/vsizip/${zipPath}`,
      'NHDWaterbody',
      '-select',
      'permanent_identifier,ftype,fcode,gnis_name,areasqkm',
      // **No `-where` floor.** Filtering here would make the funnel's "below the floor" line read
      // zero while 456,000 features were silently removed upstream — a report that cannot see its own
      // largest filter. `Funnel.add` applies it, and counts it.
      '-nlt',
      'NONE',
      '-overwrite',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`${state}: ogr2ogr exited ${res.status}`);
  return out;
}

function runNhd(refresh: boolean): Funnel {
  const funnel = new Funnel('NHD');
  // The state geodatabases overlap heavily (9,792 ids appear in more than one, audited as
  // area-identical), so first-writer-wins is lossless and double-counting would not be.
  const seen = new Set<string>();

  for (const source of NHD_SOURCES) {
    const key = nhdArchiveKey(source);
    const { filename } = JSON.parse(readFileSync(join(NHD_DIR, key, 'manifest.json'), 'utf8')) as {
      filename: string;
    };
    const csv = nhdAttributes(key, join(NHD_DIR, key, filename), refresh);
    for (const row of readCsv(csv)) {
      const id = normalizeNhdId(row.permanent_identifier);
      if (!id.ok || seen.has(id.value)) continue;
      seen.add(id.value);
      const ftype = Number(row.ftype);
      const fcode = row.fcode ? Number(row.fcode) : undefined;
      funnel.add(
        id.value,
        row.gnis_name ?? '',
        Number(row.areasqkm ?? 0) * 1e6,
        classifyNhd(ftype, fcode),
      );
    }
  }
  return funnel;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3DHP
// ─────────────────────────────────────────────────────────────────────────────

function runThreeDhp(refresh: boolean): Funnel {
  const funnel = new Funnel('3DHP');
  const { filename } = JSON.parse(readFileSync(join(THREE_DHP_DIR, 'manifest.json'), 'utf8')) as {
    filename: string;
  };
  const out = join(SCRATCH, '3dhp.csv');
  if (!existsSync(out) || refresh) {
    rmSync(out, { force: true }); // see `nhdAttributes`
    log('3DHP: reading waterbody attributes…');
    const res = spawnSync(
      'ogr2ogr',
      [
        '-f',
        'CSV',
        out,
        join(THREE_DHP_DIR, filename),
        'waterbody',
        '-select',
        'id3dhp,featuretype,gnisidlabel,areasqkm',
        '-nlt', // no floor here either — see `nhdAttributes`
        'NONE',
        '-overwrite',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(`3dhp: ogr2ogr exited ${res.status}`);
  }
  for (const row of readCsv(out)) {
    funnel.add(
      row.id3dhp ?? '',
      row.gnisidlabel ?? '',
      Number(row.areasqkm ?? 0) * 1e6,
      classifyThreeDhp(Number(row.featuretype)),
    );
  }
  return funnel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** A CSV reader that handles quoted fields and embedded commas — lake names contain both. */
function* readCsv(path: string): Generator<Record<string, string>> {
  const text = readFileSync(path, 'utf8');
  let header: string[] | undefined;
  for (const line of splitCsvLines(text)) {
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.length === 1 && cells[0] === '') continue;
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    yield row;
  }
}

/** Split on newlines that are not inside a quoted field. */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) {
      lines.push(text.slice(start, i).replace(/\r$/, ''));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const BASIS_LABEL: Record<ClassBasis, string> = {
  'name-reservoir': 'kept · name said "reservoir" (outranks the catalogue)',
  'source-class': 'kept · the catalogue named a class we map',
  'name-keyword': 'kept · catalogue silent, a name keyword decided it',
  'dropped-by-class': 'DROPPED · the catalogue named a class we refuse',
  'dropped-by-name': 'DROPPED · catalogue silent, the name refused it',
  'unresolved-named': 'unclassified · named, but nothing resolved it',
  'unresolved-unnamed': 'unclassified · no name, no class, no evidence',
};

const BASIS_ORDER: ClassBasis[] = [
  'source-class',
  'name-reservoir',
  'name-keyword',
  'dropped-by-class',
  'dropped-by-name',
  'unresolved-named',
  'unresolved-unnamed',
];

function report(funnel: Funnel): void {
  const pct = (n: number) => `${((n / Math.max(1, funnel.scored)) * 100).toFixed(1)}%`;
  const out: string[] = [];
  out.push('');
  out.push(`══ ${funnel.lane} ${'═'.repeat(Math.max(0, 60 - funnel.lane.length))}`);
  out.push(`   features read            ${funnel.total.toLocaleString().padStart(9)}`);
  out.push(
    `   below the 1-acre floor   ${funnel.belowFloor.toLocaleString().padStart(9)}   (D96 rule 1 — the only rule safe to apply pre-merge)`,
  );
  out.push(`   classified               ${funnel.scored.toLocaleString().padStart(9)}`);
  out.push('');
  out.push('   where each answer came from');
  for (const basis of BASIS_ORDER) {
    const n = funnel.byBasis.get(basis) ?? 0;
    if (n === 0) continue;
    out.push(
      `     ${n.toLocaleString().padStart(9)}  ${pct(n).padStart(6)}  ${BASIS_LABEL[basis]}`,
    );
  }
  out.push('');
  out.push('   resulting class');
  const kept = [...funnel.byClass.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of kept) {
    out.push(`     ${n.toLocaleString().padStart(9)}  ${pct(n).padStart(6)}  ${cls}`);
  }
  out.push(
    `     ${kept
      .reduce((s, [, n]) => s + n, 0)
      .toLocaleString()
      .padStart(9)}          — kept in total`,
  );
  out.push('');
  out.push('   top drop reasons');
  for (const [token, n] of [...funnel.dropTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)) {
    out.push(`     ${n.toLocaleString().padStart(9)}          ${token}`);
  }
  if (funnel.unknownTokens.size > 0) {
    out.push('');
    out.push('   ⚠ values this catalogue carries that our tables do not map');
    for (const [token, n] of [...funnel.unknownTokens.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`     ${n.toLocaleString().padStart(9)}          ${token}`);
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);

  const path = join(SCRATCH, `unresolved-${funnel.lane.toLowerCase()}.tsv`);
  const rows = [...funnel.unresolvedNamed].sort((a, b) => b.acres - a.acres);
  writeFileSync(
    path,
    `id\tacres\tname\ttoken\n${rows.map((r) => `${r.id}\t${r.acres}\t${r.name}\t${r.token}`).join('\n')}\n`,
  );
  process.stdout.write(`\n   named-but-unresolved: ${rows.length.toLocaleString()} → ${path}\n`);
  for (const r of rows.slice(0, 25)) {
    process.stdout.write(`     ${String(r.acres).padStart(7)} ac  ${r.name}\n`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const refresh = argv.includes('--refresh');
  const lanes = new Set(argv.filter((a) => !a.startsWith('--refresh')));
  const all = lanes.size === 0;
  mkdirSync(SCRATCH, { recursive: true });

  if (all || lanes.has('--osm')) report(await runOsm(refresh));
  if (all || lanes.has('--nhd')) report(runNhd(refresh));
  if (all || lanes.has('--3dhp')) report(runThreeDhp(refresh));
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
