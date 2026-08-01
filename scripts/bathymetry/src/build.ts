/**
 * Build the contour set for every lane, ready to tile (N6b).
 *
 *   pnpm --filter @skating/bathymetry build [--states=VT,NH] [--limit=50] [--ungated]
 *
 * Runs the chain over every joined lake and writes newline-delimited GeoJSON to
 * `.scratch/build/contours.geojsonl` — the format `tippecanoe` reads fastest, and the one that lets a
 * 2,400-lake run stream rather than build a single enormous array in memory.
 *
 * ## What each feature carries, and why
 *
 * | Property | Why it is on every line |
 * | --- | --- |
 * | `bodyId` | The OSM `externalId`. **This is what D81 filters on** — contours are drawn only for the open lake, so the client needs to select a body's lines without a query. `externalId` rather than the Convex `_id` because `_id` changes if a row is recreated, and re-tiling five states because a re-import churned ids is not a thing we should be one accident away from. |
 * | `depthFt` | Styling, and the label. Native feet throughout — every source in the set is feet (D83's worked example described a unit seam that does not exist). |
 * | `lane` | `surveyed` or `interpolated`. **The provenance claim**, and it must reach the drawer: a state's own isobaths and our fitted surface are different assertions and never render as the same thing. |
 * | `agency` | The credit line, scoped to the body on screen rather than a standing list of all five states. |
 * | `intervalFt` | So the drawer can say *"5 ft contours"* without re-deriving it from the geometry. |
 *
 * ## Everything that is dropped is named
 *
 * The register's no-silent-caps rule, and it matters more here than anywhere else in the phase: a lake
 * that silently fails to build is indistinguishable, in the finished layer, from a lake nobody ever
 * surveyed. The run writes `.scratch/build/dropped.json` with a reason per lake and prints the tally.
 */

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { MultiPolygon, Polygon } from 'geojson';
import { SCRATCH_ROOT } from './cache';
import { type Drawn, interpolate, lakeId, publishedContours, setUngated } from './contour';
import { readJoin } from './join';
import { readAllLakes } from './lakeSources';
import { measure, splitByBody } from './lakes';
import { sourceByKey } from './sources';

const BUILD_DIR = join(SCRATCH_ROOT, 'build');
const OUT_FILE = join(BUILD_DIR, 'contours.geojsonl');
const DROPPED_FILE = join(BUILD_DIR, 'dropped.json');

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

interface Dropped {
  key: string;
  name: string;
  state: string;
  reason: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  setUngated(args.includes('--ungated'));
  const states = flag(args, 'states')
    ?.split(',')
    .map((s) => s.trim().toUpperCase());
  const limit = Number(flag(args, 'limit') ?? Number.POSITIVE_INFINITY);

  const joined = readJoin();
  if (Object.keys(joined).length === 0) {
    throw new Error('no join cached — run `pnpm --filter @skating/bathymetry join` first');
  }

  log('reading every archived source…');
  const all = (await readAllLakes()).filter((l) => !states || states.includes(l.state));
  const lakes = all.flatMap(splitByBody);
  log(`${lakes.length} lakes (${lakes.length - all.length} from split keys)`);

  mkdirSync(BUILD_DIR, { recursive: true });
  const out = createWriteStream(OUT_FILE);
  const dropped: Dropped[] = [];
  let built = 0;
  let features = 0;
  let done = 0;

  for (const lake of lakes) {
    if (built >= limit) break;
    done += 1;
    if (done % 200 === 0)
      log(`  ${done}/${lakes.length} — ${built} built, ${dropped.length} dropped`);

    const key = lakeId(lake);
    const body = joined[key];
    const drop = (reason: string) =>
      dropped.push({ key, name: lake.lakeName, state: lake.state, reason });

    if (!body) {
      drop('no water body in our corpus at this lake');
      continue;
    }
    if (!body.polygon) {
      drop('body matched but carries no polygon');
      continue;
    }

    const metrics = measure(lake);
    // The density gate, for the lanes where we fit a surface. Contour lanes are the agency's own
    // survey and there is no fit of ours to gate.
    if (lake.lane === 'soundings' && metrics.density?.verdict !== 'ok') {
      drop(metrics.density?.reason ?? 'density gate');
      continue;
    }

    const polygon = body.polygon as Polygon | MultiPolygon;
    let drawn: Drawn;
    try {
      drawn =
        lake.lane === 'contours'
          ? publishedContours(lake, polygon)
          : interpolate(lake, polygon, metrics.extentM);
    } catch (error) {
      drop(`chain threw: ${(error as Error).message.slice(0, 160)}`);
      continue;
    }

    if (drawn.lines.length === 0) {
      drop(drawn.note ?? 'chain produced no lines');
      continue;
    }

    const agency = sourceByKey(lake.sourceKey)?.agency ?? lake.agency;
    const lane = lake.lane === 'contours' ? 'surveyed' : 'interpolated';
    for (const [i, line] of drawn.lines.entries()) {
      out.write(
        `${JSON.stringify({
          type: 'Feature',
          properties: {
            bodyId: body.externalId ?? body.waterBodyId,
            depthFt: drawn.depths[i] ?? 0,
            lane,
            agency,
            state: lake.state,
            intervalFt: drawn.interval ?? null,
          },
          geometry: { type: 'LineString', coordinates: line },
        })}\n`,
      );
      features += 1;
    }
    built += 1;
  }

  await new Promise<void>((resolve) => out.end(resolve));
  writeFileSync(DROPPED_FILE, JSON.stringify(dropped, null, 0));

  log(`\n✓ ${built} lakes → ${features.toLocaleString()} contour lines`);
  log(`  ${OUT_FILE}`);

  // Grouped, then every kind named. A build that quietly drops a third of the corpus looks exactly
  // like one that drew all of it, and the finished layer cannot tell you which happened.
  const kinds: Record<string, number> = {};
  for (const d of dropped) {
    const kind = d.reason.replace(/\d[\d,.]*/g, 'N').slice(0, 80);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  log(`\n  ${dropped.length} lakes dropped, by reason:`);
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`    ${String(n).padStart(5)} × ${kind}`);
  }
  log(`  every one named in ${DROPPED_FILE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] build failed: ${(error as Error).stack}\n`);
  process.exit(1);
});
