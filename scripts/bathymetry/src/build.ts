/**
 * Build the contour set for every lane, ready to tile (N6b).
 *
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
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { SCRATCH_ROOT } from './cache';
import { clipDrawnToBody, type Drawn, interpolate, lakeId, publishedContours } from './contour';
import { contourFeature, type StampBody, stampBodyId } from './feature';
import { readJoin } from './join';
import { readAllLakes } from './lakeSources';
import { measure, preferSurveyedLane, splitByBody } from './lakes';
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
  const states = flag(args, 'states')
    ?.split(',')
    .map((s) => s.trim().toUpperCase());
  const limit = Number(flag(args, 'limit') ?? Number.POSITIVE_INFINITY);

  const campaignId = flag(args, 'campaign');
  const joined = readJoin();
  if (Object.keys(joined).length === 0) {
    throw new Error('no join cached — run `pnpm --filter @skating/bathymetry join` first');
  }

  const logger = new RunLogger({
    kind: 'bathymetry_build',
    label: 'bathymetry build — soundings/contours → drawable isobaths',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'draw',
        detail:
          'published contours pass through; soundings are interpolated behind a density gate, because a fit over three points is a drawing, not a survey',
      },
    ],
  });
  logger.start();

  log('reading every archived source…');
  const all = (await readAllLakes()).filter((l) => !states || states.includes(l.state));
  const split = all.flatMap(splitByBody);
  log(`${split.length} lakes (${split.length - all.length} from split keys)`);

  // A border lake is filed by both states, so it joins twice and both lanes would write under one
  // `bodyId` — the agency's isobaths and our fit, drawn over each other and credited as ours. Runs
  // before the loop for the same reason `splitByBody` runs before the join: by the time features are
  // being written, "which lake is this" is already settled.
  const { kept: lakes, superseded } = preferSurveyedLane(split, (lake) => {
    const body = joined[lakeId(lake)];
    return body ? stampBodyId(body) : undefined;
  });
  if (superseded.length > 0) {
    log(`${superseded.length} lakes superseded by a surveyed lane on the same body`);
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const out = createWriteStream(OUT_FILE);
  const dropped: Dropped[] = superseded.map(({ lake, reason }) => ({
    key: lakeId(lake),
    name: lake.lakeName,
    state: lake.state,
    reason,
  }));
  let built = 0;
  let features = 0;
  let done = 0;
  /** Bays that took a share of their lake's contours, and bays that took none. */
  let nestedBuilt = 0;
  let nestedEmpty = 0;

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

    const polygon = body.polygon as Polygon | MultiPolygon;
    const metrics = measure(lake, polygon);
    // The density gate, for the lanes where we fit a surface. Contour lanes are the agency's own
    // survey and there is no fit of ours to gate.
    if (lake.lane === 'soundings' && metrics.density?.verdict !== 'ok') {
      drop(metrics.density?.reason ?? 'density gate');
      continue;
    }

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

    // The registry is the source of the credit, not the ArchivedLake's copy (which is for logs).
    const agency = sourceByKey(lake.sourceKey)?.agency ?? lake.agency;
    const emit = (target: StampBody, lines: Position[][], depths: number[]) => {
      for (const [i, line] of lines.entries()) {
        out.write(
          `${JSON.stringify(
            contourFeature({
              lake,
              body: target,
              agency,
              coordinates: line,
              depthFt: depths[i] ?? 0,
              intervalFt: drawn.interval,
            }),
          )}\n`,
        );
        features += 1;
      }
    };
    emit(body, drawn.lines, drawn.depths);

    // **The bays.** A body nested inside the surveyed lake gets the lake's own contours trimmed to it,
    // stamped under its own id — because D81's filter keys off the open body, and a skater who opens
    // North Bay is standing on Moosehead Lake's basin. Without this the bay renders flat next to a
    // lake that is fully drawn, which reads as "nobody surveyed this" rather than "this is the lake".
    for (const nested of body.alsoCovers ?? []) {
      if (!nested.polygon) continue;
      const trimmed = clipDrawnToBody(
        drawn,
        nested.polygon as Polygon | MultiPolygon,
        `${key.replace(/[^\w.-]+/g, '_')}.${stampBodyId(nested).replace(/[^\w.-]+/g, '_')}`,
      );
      // Not a drop: the lake itself built fine, and a bay that takes no whole contour line is an
      // ordinary outcome of a containment test rather than a failure worth a ledger entry.
      if (!trimmed) {
        nestedEmpty += 1;
        continue;
      }
      emit(nested, trimmed.lines, trimmed.depths);
      nestedBuilt += 1;
    }
    built += 1;
  }

  await new Promise<void>((resolve) => out.end(resolve));
  writeFileSync(DROPPED_FILE, JSON.stringify(dropped, null, 0));

  log(`\n✓ ${built} lakes → ${features.toLocaleString()} contour lines`);
  log(`  ${OUT_FILE}`);
  if (nestedBuilt + nestedEmpty > 0) {
    log(`  ${nestedBuilt} nested body/bodies also drawn (${nestedEmpty} took no whole line)`);
  }

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

  // This is the gap that mattered most and was invisible: the join matched far more lakes than the
  // build can actually draw, and only the drop ledger says which ones and why.
  for (const d of dropped) {
    logger.fail({
      stage: 'draw',
      key: `${d.key} (${d.name ?? '?'}, ${d.state ?? '?'})`,
      reason: d.reason,
    });
  }
  logger.count('joinedLakes', Object.keys(joined).length);
  logger.count('candidates', lakes.length);
  logger.count('built', built);
  logger.count('contourFeatures', features);
  logger.count('dropped', dropped.length);
  logger.count('nestedBodiesDrawn', nestedBuilt);
  logger.count('nestedBodiesWithNoWholeLine', nestedEmpty);
  logger.count('supersededBySurveyedLane', superseded.length);
  logger.coverage({
    unit: 'lakes with a matched body',
    eligible: lakes.length + superseded.length,
    covered: built,
    omissions: Object.entries(kinds)
      .map(([reason, count]) => ({ reason, count }))
      .filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'draw',
    detail:
      'published contours pass through; soundings are interpolated behind a density gate, because a fit over three points is a drawing, not a survey',
    output: OUT_FILE,
    counts: [
      { name: 'built', value: built },
      { name: 'contourFeatures', value: features },
      { name: 'dropped', value: dropped.length },
    ],
  });
  logger.succeed([
    `${built} lakes drew ${features.toLocaleString()} contour lines`,
    'Contour coverage does not reach the map until `tile` and `coverage` run.',
  ]);
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] build failed: ${(error as Error).stack}\n`);
  process.exit(1);
});
