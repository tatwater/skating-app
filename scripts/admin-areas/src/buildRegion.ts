/**
 * The region polygon and the out-of-region mask — the two shapes that make the map stop at our border.
 *
 *   pnpm --filter @skating/admin-areas build-region
 *   pnpm --filter @skating/admin-areas build-region --refresh   # re-download the sources
 *
 * ## Why a map needs a shape of its own
 *
 * The basemap was extracted from a Protomaps planet build with `--bbox`, which is a rectangle, and a
 * rectangle cannot know where Connecticut starts. So the map rendered Ottawa, Toronto and Hartford in
 * full detail while cutting the *world* off in a straight line at 41.2°N — the bbox floor, which runs
 * just above Manhattan. Detail outside the five states, no ocean south of it: both halves wrong, one
 * cause.
 *
 * This script emits three files that fix both halves:
 *
 * 1. **`region.geojson`** — the union of the five TIGER states. Feeds `pmtiles extract --region`, so
 *    the regional archive holds only tiles that touch our states, and feeds the mask below as the
 *    hole. This is the *render* region: all of New York, downstate included (founder, 2026-08-05).
 * 2. **`region-data.geojson`** — the same union minus the New York counties south of I-84. This is
 *    the *data* region, the one the ETL clips the corpus to. The two differ on purpose: Poughkeepsie
 *    should draw on the map, it just should not have skateable water in our corpus.
 * 3. **`regionMask.ts`** — the land around us that is *not* ours, as flat fill. This is what turns
 *    New Jersey into an empty white shape while leaving its border and its name legible.
 *
 * ## Why the mask's hole is cut by choosing polygons, not by subtracting them
 *
 * The obvious construction — take the land, subtract the five states — produces a sliver wherever two
 * sources disagree about the same line, and two sources always disagree. Natural Earth's Maine coast
 * and TIGER's are a kilometre apart in places, so subtracting one from the other leaves a white ribbon
 * of "land" lying over the sea just off the coast we care most about.
 *
 * So the mask avoids subtracting along any line it shares with us. The United States half is simply
 * **the other TIGER states**, which abut ours exactly because they are cut from the same file — the
 * hole is exact and free, with no boolean operation performed along it at all. Canada is the one place
 * a subtraction is unavoidable, since no TIGER file covers it, and there the error is biased on
 * purpose: the hole is punched at near-TIGER precision so the mask can never creep south over Vermont,
 * leaving the opposite error — an unmasked strip a few hundred metres wide on the Québec side, where a
 * little border-town detail may still show through. That is the artefact we chose to keep.
 *
 * The sea is subtracted too, and that one is a genuine two-source cut. See the `cutSea` block below
 * for why a legal boundary is not a coastline, and why this particular disagreement is harmless.
 *
 * ## Why tile-level clipping is not enough on its own
 *
 * `pmtiles extract --region` keeps whole tiles, not whole polygons: a tile that so much as touches New
 * York survives intact, Connecticut and all. At z14 that fringe is 2.4 km; at z6 a single tile is
 * roughly 450 km, which is most of Pennsylvania. The mask is what makes the border crisp at every
 * zoom, and the `--region` extract is then just the thing that keeps the archive small.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import bbox from '@turf/bbox';
import difference from '@turf/difference';
import { featureCollection } from '@turf/helpers';
import intersect from '@turf/intersect';
import simplify from '@turf/simplify';
import union from '@turf/union';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { archive, makeLog, RAW, STATES, TIGER_COUNTIES, TIGER_STATES } from './tiger';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/** Where the two region polygons land — beside the basemap build that consumes them. */
const BASEMAP_SCRATCH = join(REPO, 'scripts', 'basemap', '.scratch');

/**
 * The mask ships **inside both apps** rather than from a shared package.
 *
 * It is build-time data that changes only when the region does, and writing it twice from one
 * generator is the cheaper trade against a workspace package that Metro would have to resolve through
 * subpath exports. `waterMap.ts` is already duplicated web/mobile on the same reasoning.
 *
 * **As a TypeScript module holding one JSON string, not as a `.json` file.** With `resolveJsonModule`
 * on, `tsc` infers a literal type for every coordinate pair in an imported JSON file — ten thousand
 * of them here, which is a type-check cost paid on every build for a value nothing is ever going to
 * narrow. A string literal costs nothing to type and `JSON.parse` is, famously, faster at runtime
 * than the equivalent object literal. It also means neither bundler has to support JSON imports.
 */
const MASK_OUTPUTS = [
  join(REPO, 'apps', 'web', 'src', 'assets', 'regionMask.ts'),
  join(REPO, 'apps', 'mobile', 'src', 'assets', 'regionMask.ts'),
];

const log = makeLog('region');

/**
 * Natural Earth, for everywhere TIGER does not reach.
 *
 * Public domain, no key, no rate limit. Not pinned by byte count the way the TIGER files are: Natural
 * Earth versions its releases in the path (`10m`), and a mask being a few hundred metres different
 * next year is not a correctness event the way a moved state line would be.
 */
const NATURAL_EARTH = {
  countries: {
    url: 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip',
    filename: 'ne_10m_countries.zip',
    layer: 'ne_10m_admin_0_countries',
  },
  lakes: {
    url: 'https://naciscdn.org/naturalearth/10m/physical/ne_10m_lakes.zip',
    filename: 'ne_10m_lakes.zip',
    layer: 'ne_10m_lakes',
  },
  ocean: {
    url: 'https://naciscdn.org/naturalearth/10m/physical/ne_10m_ocean.zip',
    filename: 'ne_10m_ocean.zip',
    layer: 'ne_10m_ocean',
  },
} as const;

/**
 * New York south of I-84, by county — the corpus cut (founder, 2026-08-05).
 *
 * **Counties rather than a latitude line**, because a lake that straddles 41.5°N would otherwise be
 * half in the corpus and half out, and because these are boundaries we already hold. The fit is
 * deliberately imperfect at both ends: I-84 runs through the middle of Orange County, which is
 * dropped whole, and clips the southern tip of Dutchess, which is kept whole. The rule a user can be
 * told — "we cover New York north of I-84" — survives both.
 */
export const DOWNSTATE_NY_COUNTIES = [
  // The five boroughs.
  'Bronx',
  'Kings',
  'New York',
  'Queens',
  'Richmond',
  // Long Island.
  'Nassau',
  'Suffolk',
  // The lower Hudson, up to and including the county I-84 crosses.
  'Westchester',
  'Rockland',
  'Putnam',
  'Orange',
] as const;

/**
 * How hard each piece of the mask is simplified, in degrees.
 *
 * The number that matters is `neighbour`: those four states share a line with ours, and every metre
 * of simplification there is a metre of their territory that may go unmasked and leak basemap detail.
 * At 0.0005° that strip is about forty-five metres — four pixels at maximum zoom, nothing below it.
 * Everything else is scenery, and scenery is where the file size lives: Canada's coast costs more
 * vertices than the entire Northeast. Québec at two kilometres of error is still a white shape of
 * very nearly the right outline, seen from a zoom where two kilometres is a pixel.
 *
 * `cut` is different in kind — it is not a tolerance for drawing but for *subtracting*. See
 * `maskFeature`: anything cut against the region inherits the region's own boundary as its inner
 * edge, so this number decides how many TIGER vertices come along for the ride.
 */
const TOLERANCE = {
  neighbour: 0.0005,
  usFar: 0.02,
  canada: 0.02,
  lake: 0.01,
  sea: 0.005,
  cut: 0.0002,
} as const;

/** Connecticut, New Jersey, Pennsylvania, Rhode Island — the states that touch ours. */
const NEIGHBOUR_FIPS = new Set(['09', '34', '42', '44']);

/**
 * How far the mask has to reach, and why it does not have to reach further.
 *
 * The mask exists to cover **tile bleed** — the whole tiles `pmtiles extract --region` keeps because
 * they graze our border, Connecticut and all. Bleed cannot travel further than one tile at the
 * lowest zoom the regional layers draw, which is one z6 tile, about 450 km. Past that the regional
 * archive holds nothing at all, and the world overview is already drawing exactly what we want out
 * there: flat land, a border line, a name.
 *
 * So masking Africa is 875 KB spent to paint white over white. The first build did it anyway and the
 * file was 1.5 MB; scoping to this box is most of the difference. The numbers are the five-state
 * bounds plus roughly one z6 tile on each side.
 */
const BLEED_BOX = { minLng: -86, minLat: 36, maxLng: -60, maxLat: 52 } as const;

/**
 * Whether a feature's bbox overlaps the bleed neighbourhood at all — the cheap keep/drop test.
 *
 * **Cheap, and therefore wrong for anything that crosses the antimeridian.** Alaska's bbox runs from
 * -180 to 180 because the Aleutians straddle the date line, so this returns true for a state two
 * time zones past Siberia — and the first build duly shipped the whole of it, which is how a mask
 * scoped to the Northeast came out with a bbox spanning the globe. That is what `needsClipping`
 * below is for: the box test admits, the clip disposes.
 */
function nearRegion(feature: Poly): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox(feature);
  return (
    minLng <= BLEED_BOX.maxLng &&
    maxLng >= BLEED_BOX.minLng &&
    minLat <= BLEED_BOX.maxLat &&
    maxLat >= BLEED_BOX.minLat
  );
}

/**
 * Whether a feature spills outside the bleed box and so has to be clipped rather than taken whole.
 *
 * Asked per feature rather than clipping everything, because clipping is a boolean operation and the
 * shared TIGER borders are the one thing in this file worth not running through one. Connecticut sits
 * wholly inside the box and comes through untouched, vertex for vertex; Michigan and Canada do not.
 */
function needsClipping(feature: Poly): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox(feature);
  return (
    minLng < BLEED_BOX.minLng ||
    maxLng > BLEED_BOX.maxLng ||
    minLat < BLEED_BOX.minLat ||
    maxLat > BLEED_BOX.maxLat
  );
}

/** `BLEED_BOX` as a polygon, for the features big enough to be worth clipping rather than dropping. */
const BLEED_POLYGON: Poly = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [BLEED_BOX.minLng, BLEED_BOX.minLat],
        [BLEED_BOX.maxLng, BLEED_BOX.minLat],
        [BLEED_BOX.maxLng, BLEED_BOX.maxLat],
        [BLEED_BOX.minLng, BLEED_BOX.maxLat],
        [BLEED_BOX.minLng, BLEED_BOX.minLat],
      ],
    ],
  },
};

type Poly = Feature<Polygon | MultiPolygon, Record<string, unknown>>;

/**
 * Pull one layer out of a zipped shapefile as GeoJSON features, via `/vsizip/` so nothing is unpacked
 * to disk. `where` is passed to OGR rather than filtered in JS: on the 84 MB county file that is the
 * difference between parsing three thousand polygons and parsing eleven.
 */
function ogrFeatures(zip: string, layer: string, select: string, where?: string): Poly[] {
  const out = join(RAW, `.${layer}-slice.geojsonl`);
  // `-overwrite` does not replace a single-file datasource; ogr2ogr appends to it. Remove it ourselves.
  rmSync(out, { force: true });
  const res = spawnSync(
    'ogr2ogr',
    [
      '-f',
      'GeoJSONSeq',
      out,
      `/vsizip/${zip}`,
      layer,
      '-select',
      select,
      ...(where ? ['-where', where] : []),
      '-t_srs',
      'EPSG:4326',
      '-dim',
      'XY',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  if (res.status !== 0) throw new Error(`ogr2ogr ${layer} exited ${res.status}: ${res.stderr}`);
  const features = readFileSync(out, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Poly);
  rmSync(out, { force: true });
  return features;
}

/**
 * Turf's union over a whole list, which is how five states become one region.
 *
 * The single-feature case is not an optimisation — turf refuses a collection of one with "Must have
 * at least 2 geometries", and Natural Earth publishes the world's ocean as exactly one feature.
 */
function unionAll(features: Poly[]): Poly {
  if (features.length === 0) throw new Error('nothing to union');
  if (features.length === 1) return features[0] as Poly;
  const merged = union(featureCollection(features as Feature<Polygon | MultiPolygon>[]));
  if (!merged) throw new Error('union produced nothing');
  return merged as Poly;
}

/** `a` minus `b`, or `null` when `b` swallows `a` whole. */
function subtract(a: Poly, b: Poly): Poly | null {
  return difference(featureCollection([a, b] as Feature<Polygon | MultiPolygon>[])) as Poly | null;
}

/**
 * Round every coordinate to four decimals — about eleven metres at this latitude.
 *
 * TIGER emits seven, which is centimetres: a precision no consumer of this file can render and every
 * consumer has to download. Applied after simplification, so it only trims digits rather than moving
 * any vertex a renderer would have kept — and four decimals is finer than the finest tolerance above.
 */
function roundCoords<T>(geometry: T): T {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const walk = (node: unknown): unknown =>
    Array.isArray(node)
      ? typeof node[0] === 'number'
        ? (node as number[]).map(round)
        : node.map(walk)
      : node;
  const g = geometry as { coordinates?: unknown };
  return g.coordinates ? ({ ...g, coordinates: walk(g.coordinates) } as T) : geometry;
}

/**
 * Simplify, optionally cut the region out, round, and strip to the one property the style filters on.
 *
 * **Simplify first, cut second, and the order is the whole trick.** Cutting first and simplifying
 * after would coarsen the inner edge — the border with us, the one edge on the feature that has to be
 * right — while the far side stayed as detailed as it liked. Doing it this way, the shared edge is
 * whatever `cutAgainst` says it is and the far side is as cheap as we can bear, which is the exact
 * opposite trade and the one we want. It is also why `cutAgainst` is a pre-simplified copy of the
 * region: an exact TIGER edge would drag fifty thousand centimetre-precision vertices into a file
 * that ships inside a phone app.
 */
function maskFeature(
  feature: Poly,
  tolerance: number,
  kind: 'land' | 'water',
  options: { cutAgainst?: Poly; clipToBleedBox?: boolean; cutSea?: Poly } = {},
): Poly | null {
  const thinned = simplify(feature, { tolerance, highQuality: false, mutate: false });
  // Clip before cutting: Canada reaches the Arctic and we want none of it, and a smaller polygon is
  // a cheaper subtrahend for the cut that follows.
  const clipped = options.clipToBleedBox
    ? (intersect(
        featureCollection([thinned, BLEED_POLYGON] as Feature<Polygon | MultiPolygon>[]),
      ) as Poly | null)
    : thinned;
  if (!clipped) return null;
  const cut = options.cutAgainst ? subtract(clipped, options.cutAgainst) : clipped;
  if (!cut) return null;
  const dry = options.cutSea ? subtract(cut, options.cutSea) : cut;
  if (!dry) return null;
  return {
    type: 'Feature',
    properties: { kind },
    geometry: roundCoords(dry.geometry),
  } as Poly;
}

/** Bytes of a JSON payload, for the log line that tells you whether the mask got out of hand. */
function sizeOf(value: unknown): string {
  return `${(JSON.stringify(value).length / 1024).toFixed(0)} KB`;
}

function main(): void {
  const refresh = process.argv.includes('--refresh');
  mkdirSync(BASEMAP_SCRATCH, { recursive: true });

  // ── 1. the render region: five states, whole ──────────────────────────────
  const stateZip = archive(TIGER_STATES, refresh, log);
  const fipsList = STATES.map((s) => `'${s.fips}'`).join(',');
  const ours = ogrFeatures(
    stateZip,
    TIGER_STATES.layer,
    'STATEFP,NAME,GEOID',
    `STATEFP IN (${fipsList})`,
  );
  if (ours.length !== STATES.length) {
    throw new Error(`expected ${STATES.length} states from TIGER, got ${ours.length}`);
  }
  const region = unionAll(ours);
  writeFileSync(join(BASEMAP_SCRATCH, 'region.geojson'), JSON.stringify(region));
  log(`region.geojson       ${sizeOf(region)}  (${STATES.map((s) => s.code).join(' ')})`);

  // ── 2. the data region: minus New York below I-84 ─────────────────────────
  const countyZip = archive(TIGER_COUNTIES, refresh, log);
  const nameList = DOWNSTATE_NY_COUNTIES.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const downstate = ogrFeatures(
    countyZip,
    TIGER_COUNTIES.layer,
    'STATEFP,NAME,GEOID',
    `STATEFP = '36' AND NAME IN (${nameList})`,
  );
  if (downstate.length !== DOWNSTATE_NY_COUNTIES.length) {
    throw new Error(
      `expected ${DOWNSTATE_NY_COUNTIES.length} downstate counties, got ${downstate.length} — a TIGER county name has moved`,
    );
  }
  const dataRegion = subtract(region, unionAll(downstate));
  if (!dataRegion) throw new Error('the downstate cut removed the entire region');
  writeFileSync(join(BASEMAP_SCRATCH, 'region-data.geojson'), JSON.stringify(dataRegion));
  log(`region-data.geojson  ${sizeOf(dataRegion)}  (less ${downstate.length} NY counties)`);

  // The same cut as a set of counties rather than one hole, because that is the shape the ETL can
  // use. `merge.ts` tests a body against thousands of small town polygons through a cell grid; one
  // 27,000-vertex region outline would have to be tested vertex by vertex against every candidate.
  // Eleven counties with eleven tight bounding boxes reject almost every body on the bbox alone.
  const downstateFile = join(BASEMAP_SCRATCH, 'downstate-ny.geojson');
  writeFileSync(
    downstateFile,
    JSON.stringify({
      type: 'FeatureCollection',
      features: downstate.map((county) => ({
        type: 'Feature',
        properties: { name: String(county.properties.NAME ?? '') },
        geometry: county.geometry,
      })),
    }),
  );
  log(`downstate-ny.geojson  ${downstate.length} counties, for the ETL's refusal`);

  // And a coarse copy, for the mutation that clears out what was imported before the cut existed.
  // `waterBodies.pruneOutsideCoverage` takes its polygons as an *argument* — a place resolution per
  // body exhausts Convex's read budget — so these have to be small enough to pass over the wire on
  // every paginated call. At 0.001° the county lines are good to about ninety metres, which is far
  // finer than the question being asked of them: is this lake's representative point downstate.
  const coarse = downstate.map((county) => ({
    type: 'Feature' as const,
    properties: { name: String(county.properties.NAME ?? '') },
    geometry: roundCoords(
      simplify(county, { tolerance: 0.001, highQuality: false, mutate: false }).geometry,
    ),
  }));
  const coarseFile = join(BASEMAP_SCRATCH, 'downstate-ny-coarse.geojson');
  writeFileSync(coarseFile, JSON.stringify({ type: 'FeatureCollection', features: coarse }));
  log(`downstate-ny-coarse   ${sizeOf(coarse)}, for waterBodies:pruneOutsideCoverage`);

  // ── 3. the mask: the rest of the world, flat ──────────────────────────────
  const mask: Poly[] = [];
  // Bytes per group, because "the mask got big" is not an actionable log line and "Canada is 40% of
  // it" is. Every tolerance above was chosen against this tally.
  const weight = new Map<string, number>();
  const push = (group: string, feature: Poly | null) => {
    if (!feature) return;
    mask.push(feature);
    weight.set(group, (weight.get(group) ?? 0) + JSON.stringify(feature).length);
  };
  const kb = (group: string) => `${((weight.get(group) ?? 0) / 1024).toFixed(0)} KB`;
  // The subtrahend every foreign feature is cut against. See `maskFeature` for why it is pre-thinned.
  const cutLine = simplify(region, { tolerance: TOLERANCE.cut, highQuality: false, mutate: false });

  // The sea, subtracted from every piece of mask land.
  //
  // **A TIGER state polygon is a legal boundary, not a coastline**, and a coastal state's legal
  // boundary runs out over the water it has jurisdiction over. Take Rhode Island whole and the mask
  // paints Narragansett Bay white; take New Jersey and Delaware whole and Delaware Bay goes with it.
  // Long Island Sound is the same story from the other side — most of it is legally New York, which
  // is why it never masked at all.
  //
  // Cutting the sea out is the only place this file lets two sources disagree about a shared line,
  // and it is deliberate: the disagreement lands on Connecticut's own shoreline, a kilometre of
  // coarseness between white and blue in a place where neither side draws any detail. The lines that
  // had to stay exact — the borders we share — are untouched by it.
  const oceanZip = archive(NATURAL_EARTH.ocean, refresh, log);
  const sea = unionAll(
    ogrFeatures(oceanZip, NATURAL_EARTH.ocean.layer, 'featurecla')
      .map((piece) =>
        maskFeature(piece, TOLERANCE.sea, 'water', { clipToBleedBox: needsClipping(piece) }),
      )
      .filter((piece): piece is Poly => piece !== null),
  );

  // The United States, from the same file our region came from — so the shared borders match to the
  // vertex and no subtraction is needed anywhere along them.
  const others = ogrFeatures(
    stateZip,
    TIGER_STATES.layer,
    'STATEFP,NAME,GEOID',
    `STATEFP NOT IN (${fipsList})`,
  );
  let dropped = 0;
  for (const state of others) {
    if (!nearRegion(state)) {
      dropped++;
      continue;
    }
    const fips = String(state.properties.STATEFP ?? '');
    const near = NEIGHBOUR_FIPS.has(fips);
    const trimmed = maskFeature(state, near ? TOLERANCE.neighbour : TOLERANCE.usFar, 'land', {
      clipToBleedBox: needsClipping(state),
      cutSea: sea,
    });
    if (!trimmed) {
      dropped++;
      continue;
    }
    push(near ? 'neighbours' : 'us', trimmed);
  }
  log(
    `  ${others.length - dropped} US states in range (${dropped} too far to bleed) — neighbours ${kb('neighbours')}, rest ${kb('us')}`,
  );

  // Everywhere else, by country — which within this box means Canada, and Saint Pierre and Miquelon.
  // Canada is the one that has to be cut against our region: it is the only foreign land that touches
  // us, and Natural Earth's idea of the border is not TIGER's.
  const countryZip = archive(NATURAL_EARTH.countries, refresh, log);
  const countries = ogrFeatures(
    countryZip,
    NATURAL_EARTH.countries.layer,
    'ADMIN,ISO_A2',
    "ADMIN <> 'United States of America'",
  );
  const inRange = countries.filter(nearRegion);
  for (const country of inRange) {
    push(
      'foreign',
      maskFeature(country, TOLERANCE.canada, 'land', {
        cutAgainst: cutLine,
        clipToBleedBox: needsClipping(country),
        cutSea: sea,
      }),
    );
  }
  log(
    `  ${inRange.length} foreign countries in range of ${countries.length} (${inRange.map((c) => String(c.properties.ADMIN)).join(', ')}) — ${kb('foreign')}`,
  );

  // The big lakes in range, drawn back over the mask as water. Without them the Great Lakes are white
  // shapes butting against a detailed New York shoreline, which reads as a rendering fault rather
  // than as a boundary. Every one is cut against the region, which matters for the two that touch it:
  // Ontario and Erie must stop at New York's shore rather than lie a coarse kilometre over it.
  const lakeZip = archive(NATURAL_EARTH.lakes, refresh, log);
  const lakes = ogrFeatures(lakeZip, NATURAL_EARTH.lakes.layer, 'name,scalerank', 'scalerank <= 2');
  const lakesInRange = lakes.filter(nearRegion);
  let kept = 0;
  for (const lake of lakesInRange) {
    const trimmed = maskFeature(lake, TOLERANCE.lake, 'water', {
      cutAgainst: cutLine,
      clipToBleedBox: needsClipping(lake),
    });
    if (!trimmed) continue;
    push('lakes', trimmed);
    kept++;
  }
  log(`  ${kept} major lakes in range of ${lakes.length} — ${kb('lakes')}`);

  const collection: FeatureCollection = { type: 'FeatureCollection', features: mask as Feature[] };
  const module = [
    '// GENERATED by `pnpm --filter @skating/admin-areas build-region` — do not edit by hand.',
    '// The out-of-region mask: flat fill for every landmass near us that is not one of the five',
    '// states. Held as a JSON string rather than an object literal; see the generator for why.',
    `export const REGION_MASK_JSON = ${JSON.stringify(JSON.stringify(collection))};`,
    '',
  ].join('\n');
  for (const out of MASK_OUTPUTS) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, module);
  }
  log(
    `regionMask.ts        ${sizeOf(collection)}  (${mask.length} features → ${MASK_OUTPUTS.length} apps)`,
  );
}

try {
  main();
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
