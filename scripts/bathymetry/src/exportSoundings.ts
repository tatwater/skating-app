/**
 * Export the soundings, keyed to the bodies they were joined to — the D92 bake-off's referee (N7).
 *
 *   pnpm --filter @skating/bathymetry export-soundings [--max-points=N]
 *
 * ## Why this is a file and not an import
 *
 * The bake-off compares an OSM outline against an NHD one, so it needs both catalogues' geometry —
 * which lives in `scripts/etl` — and it needs 2.4 million depth measurements, which live here. One
 * of the two has to cross a package boundary, and a **file is the seam every other stage in this
 * campaign already uses**: the archives, the merge's master list, the reconciliation mapping. Making
 * `@skating/etl` depend on this package to reach `readAllLakes()` would couple the corpus builder to
 * the bathymetry ETL permanently, for one measurement taken once.
 *
 * ## What it does not do
 *
 * No depths. The referee asks *where* someone took a measurement, never how deep it was — a polygon
 * is a better description of a lake if it contains the survey and has little area far from it, and
 * neither question reads a depth. Dropping the value halves the file and removes the only field that
 * would have needed a unit (the archive is in **feet** throughout, which has caught people before).
 *
 * The **OSM polygon does** ride along, because the join already matched it and it is one of the two
 * candidates being judged. That makes this file the whole of the OSM side.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readJoin } from './join';
import { readAllLakes } from './lakeSources';
import { shapePoints } from './lakes';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.scratch', 'bakeoff');

/**
 * Points kept per lake.
 *
 * **A cap, not a sample size** — most lakes are far below it. It exists for Vermont's densest, which
 * carries 136,856 soundings, and for Champlain. Both referee metrics are statistics over the cloud
 * (a containment *fraction*, a distance *percentile*), so thinning costs precision rather than
 * correctness, and it is applied identically to both candidate polygons — which is what makes the
 * comparison fair regardless of where the cap lands.
 */
const DEFAULT_MAX_POINTS = 3000;

function log(message: string): void {
  process.stderr.write(`[export-soundings] ${message}\n`);
}

/** Evenly thin, preserving spatial spread — soundings arrive in survey-track order. */
function thin<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

async function main(): Promise<void> {
  const maxPoints = Number(
    process.argv.find((a) => a.startsWith('--max-points='))?.split('=')[1] ?? DEFAULT_MAX_POINTS,
  );
  mkdirSync(OUT_DIR, { recursive: true });

  const join = readJoin();
  const joinedKeys = new Set(Object.keys(join));
  log(`${joinedKeys.size.toLocaleString()} joined lakes in .scratch/join/lakes.json`);

  log('reading the archives (this streams the whole VT BioBase zip)…');
  const lakes = await readAllLakes();
  log(`${lakes.length.toLocaleString()} archived lakes`);

  const lines: string[] = [];
  let exported = 0;
  let noPoints = 0;
  let notJoined = 0;
  let totalPoints = 0;
  let thinned = 0;

  for (const lake of lakes) {
    // `lakeId` in contour.ts and join.ts build this the same way; reproduced rather than imported
    // because both copies are private to their modules.
    const id = `${lake.sourceKey}:${lake.lakeKey}`;
    const joined = join[id];
    if (!joined) {
      notJoined++;
      continue;
    }
    const all = shapePoints(lake);
    if (all.length === 0) {
      noPoints++;
      continue;
    }
    totalPoints += all.length;
    const points = thin(all, maxPoints);
    if (points.length < all.length) thinned++;
    lines.push(
      JSON.stringify({
        lakeKey: id,
        externalId: joined.externalId,
        name: joined.name,
        state: joined.state,
        n: all.length,
        // **The OSM outline travels with the survey.** It is the incumbent candidate, and it is
        // already here — the join matched it. Shipping it makes this file the complete referee input
        // for the OSM side, so the bake-off has to reach into only one foreign package for the NHD
        // half rather than two for both.
        polygon: joined.polygon,
        // Flat [lng, lat, lng, lat, …] at 5 decimals (~1.1 m) — a third the bytes of objects, and
        // the referee's metres are measured on the ground rather than read off the file.
        pts: points.flatMap((p) => [Number(p.lng.toFixed(5)), Number(p.lat.toFixed(5))]),
      }),
    );
    exported++;
  }

  const out = join_(OUT_DIR, 'soundings.ndjson');
  writeFileSync(out, `${lines.join('\n')}\n`);

  log('');
  log(`exported          ${exported.toLocaleString()} lakes`);
  log(
    `  thinned         ${thinned.toLocaleString()} (above the ${maxPoints.toLocaleString()} cap)`,
  );
  log(`  measurements    ${totalPoints.toLocaleString()} before thinning`);
  log(
    `skipped: ${notJoined.toLocaleString()} not joined to a body · ${noPoints.toLocaleString()} with no geometry`,
  );
  log(`→ ${out}`);
  if (!existsSync(out)) throw new Error('write failed');
}

/** Local alias so the `join` variable (the lake join) does not shadow `path.join`. */
function join_(...parts: string[]): string {
  return join(...parts);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
