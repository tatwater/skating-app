/**
 * The extraction argv, pinned (N7 audit).
 *
 * These are the commands that decide **which features exist at all**, and every one of their failure
 * modes is silent: a narrowed `-select` produces a column of `undefined` that classifies as silence,
 * a missing `-a type,id` makes every feature unkeyable, a wrong `-t_srs` moves a shoreline by enough
 * to matter and not enough to notice. They cannot be covered by running them — that needs a 924 MiB
 * geodatabase — so they are covered by asserting the argv, which is the part that drifts.
 */

import { describe, expect, it } from 'vitest';
import {
  NHD_SELECT,
  nhdExtractArgs,
  ONE_ACRE_SQ_KM,
  OSM_ACCESS_TAGS,
  OSM_WATER_TAGS,
  osmAccessExportArgs,
  osmAccessFilterArgs,
  osmExportArgs,
  osmFilterArgs,
  THREE_DHP_SELECT,
  threeDhpExtractArgs,
} from './extract';

describe('the OSM filter', () => {
  it('keeps every tag the classifier can read', () => {
    // A superset of what we import, deliberately — `classifyOsmTags` makes the final call, so this
    // only has to be wide enough not to lose anything. `water` on its own catches a feature tagged
    // `water=lake` with no `natural` key, which the other four would miss.
    expect([...OSM_WATER_TAGS]).toEqual([
      'natural=water',
      'landuse=reservoir',
      'natural=bay',
      'natural=wetland',
      'water',
    ]);
  });

  it('uses -t (remove-tags), never -R (omit-referenced)', () => {
    // `-R` would drop the nodes the ways are built from, and `osmium export` would then emit fewer
    // features rather than failing — an empty extract that looks like a region with no lakes.
    const args = osmFilterArgs('/in.pbf', '/out.pbf');
    expect(args).toContain('-t');
    expect(args).not.toContain('-R');
  });

  it('exports polygons carrying the stable OSM identifier', () => {
    // `-a type,id` is what produces `@type` / `@id`. Without it every feature parses as `no-id` and
    // the whole extract is refused — and the top-level GeoJSON `id` is osmium's *internal area* id
    // (`osm_id * 2 (+1 for relations)`), which is not the identifier anything else in the world uses.
    const args = osmExportArgs('/f.pbf', '/out.geojsonseq');
    expect(args).toContain('--geometry-types=polygon');
    expect(args.join(' ')).toContain('-a type,id');
    expect(args.join(' ')).toContain('print_record_separator=false');
  });
});

describe('the access extract (N6d B1)', () => {
  it('keeps the four access tag families and nothing from the water pass', () => {
    expect([...OSM_ACCESS_TAGS]).toEqual([
      'leisure=slipway',
      'waterway=slipway',
      'amenity=parking',
      'amenity=toilets',
      'natural=beach',
      'leisure=fishing',
      'man_made=pier',
    ]);
    // The two passes are over the same extract and must not fight over the same features.
    for (const tag of OSM_ACCESS_TAGS) expect(OSM_WATER_TAGS).not.toContain(tag);
  });

  it('carries no trail tags — ORS routes those ways, so a route is the trail evidence', () => {
    // Correction 9. Extracting `highway=path` / `route=hiking` would be a second, larger geometry
    // class parsed to answer a question the routing step already answers — and it is the only thing
    // that would have forced line handling into this pipeline.
    const joined = OSM_ACCESS_TAGS.join(' ');
    expect(joined).not.toContain('highway');
    expect(joined).not.toContain('route=hiking');
    expect(osmAccessExportArgs('/f.pbf', '/o').join(' ')).not.toContain('line');
  });

  it('exports points as well as polygons, which the water pass never needed', () => {
    // The failure this pins is silent: a toilet block is a node and a slipway is a node about as
    // often as it is a way, and `osmium export` emits fewer features rather than failing — so
    // `--geometry-types=polygon` here would report success over an extract missing most of its
    // put-in candidates.
    const args = osmAccessExportArgs('/f.pbf', '/out.geojsonseq');
    expect(args).toContain('--geometry-types=point,polygon');
    expect(args.join(' ')).toContain('-a type,id');
  });

  it('filters with -t, exactly as the water pass does', () => {
    const args = osmAccessFilterArgs('/in.pbf', '/out.pbf');
    expect(args).toContain('-t');
    expect(args).not.toContain('-R');
    expect(args).toContain('--overwrite');
  });
});

describe('the federal extracts', () => {
  it('floors both catalogues at exactly one acre, in km²', () => {
    // Expressed exactly rather than rounded, because it is compared with `>=` against a float the
    // publisher computed. This is a pre-filter whose exclusions nothing downstream can see.
    expect(ONE_ACRE_SQ_KM).toBeCloseTo(4046.8564224 / 1e6, 12);
    expect(nhdExtractArgs('/a.gdb', '/o').join(' ')).toContain(`areasqkm >= ${ONE_ACRE_SQ_KM}`);
    expect(threeDhpExtractArgs('/a.gpkg', '/o').join(' ')).toContain(
      `areasqkm >= ${ONE_ACRE_SQ_KM}`,
    );
  });

  it('selects fcode, without which 43% of reservoirs become plain reservoirs', () => {
    // NHD's Reservoir FTYPE spans 23 FCODEs and roughly 43% of in-region reservoirs above an acre are
    // infrastructure — sewage treatment, settling, cooling. Dropping the column from one caller's
    // `-select` would admit every one of them, with no error anywhere.
    expect([...NHD_SELECT]).toContain('fcode');
    expect(nhdExtractArgs('/a.gdb', '/o').join(' ')).toContain(NHD_SELECT.join(','));
  });

  it('reprojects to WGS84 and flattens the third ordinate', () => {
    // NHD is NAD83 (EPSG:4269) in a compound 3D `NAD83 + NAVD88 height` CRS with 3D multipolygons;
    // 3DHP staged is NAD83(2011)/Conus Albers (EPSG:5070), a metre grid. Both need saying explicitly.
    for (const args of [nhdExtractArgs('/a', '/o'), threeDhpExtractArgs('/a', '/o')]) {
      expect(args.join(' ')).toContain('-t_srs EPSG:4326');
      expect(args.join(' ')).toContain('-dim XY');
    }
  });

  it('reads the 3DHP columns the lane needs, including the bare-integer GNIS id', () => {
    expect([...THREE_DHP_SELECT]).toEqual([
      'id3dhp',
      'gnisid',
      'gnisidlabel',
      'featuretype',
      'areasqkm',
    ]);
  });

  it('names the layer each product actually publishes', () => {
    expect(nhdExtractArgs('/a', '/o')).toContain('NHDWaterbody');
    expect(threeDhpExtractArgs('/a', '/o')).toContain('waterbody');
  });
});
