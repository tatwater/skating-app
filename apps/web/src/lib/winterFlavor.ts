/**
 * The basemap, re-skinned for winter (founder, 2026-11-09).
 *
 * Protomaps' stock flavors describe summer land: a park is green, a wood is a different green, a
 * school, a hospital and an industrial estate each get their own tint. None of that is what a
 * skater is reading. **Under snow, land has no categories** — a field, a forest and a parking lot
 * are one surface — so every landuse class here collapses to the map's own land, and the basemap
 * stops describing the ground and starts describing the two things that matter on it: where the
 * water is, and how you reach it.
 *
 * What survives is the chart: flat land, water in the depth ramp, and a thin ink network of roads
 * for the approach (Getting There is a tab in this app). Everything is one cold hue — the depth
 * ramp's own 245° at a chroma you would not call blue if asked, the color of snow in shade — so the
 * basemap reads as weather rather than as a second palette arguing with the first.
 *
 * Every value is **solved**, not picked: each role is a contrast target against the land, and
 * `solveForContrast` finds the lightness that stands that far off it — darker on light, lighter on
 * dark, from the same numbers. That is why the two modes feel like one map, and why moving the land
 * (`map-earth` is still an open founder call in light) carries the whole basemap with it instead of
 * stranding seventy hexes. The targets are all *below* the shoreline's own floor on purpose: the
 * basemap may never be the loudest thing on a map whose subject is the water.
 */

import { namedFlavor } from '@protomaps/basemaps';
import { nativeThemes } from '@skating/design/native';
import { hexToOklch, type Oklch, solveForContrast, toHex } from '@skating/design/tokens';
import type { MapFlavor } from './waterMap';

/**
 * The map's own land — our token, not the flavor's. Protomaps' `white` earth is `#ffffff`, which is
 * the skater light field exactly, so the map pane had no edge against the sidebar at all; `dark`'s
 * `#1f1f1f` happened to be right. The token sits halfway in lightness between the field and the
 * shallowest water (founder, 2026-11-09), so the pane parts from the page by the same step the water
 * then takes away from the land. Every halo and label shadow on the map is cut in this color, so it
 * is the one place to change the map's ground.
 */
export function mapEarth(flavor: MapFlavor): string {
  return (flavor === 'dark' ? nativeThemes.skater.dark : nativeThemes.skater.light).color[
    'map-earth'
  ];
}

/** The water of a body we have something to say about: the shallowest depth band. */
export function mapListedWater(flavor: MapFlavor): string {
  return (flavor === 'dark' ? nativeThemes.skater.dark : nativeThemes.skater.light).color[
    'depth-0'
  ];
}

/**
 * **Water we have nothing to say about** — a river, an unlisted pond, the sea beyond the region,
 * and a listed body we have taken out of service. Gray, and exactly halfway between the land and
 * the water we *do* know about, so it is always the quieter of the two in either mode.
 *
 * It was the depth band itself until Greptile caught what that cost (#102). The basemap paints its
 * own water under ours, so a listed body drawn in band 0 sat on a basemap polygon of the identical
 * color: `withAccessDim` halves that fill's opacity to say "no public access", and half of a color
 * over the same color is that color — the dim did nothing at all. An inactive body kept its blue
 * under the ink wash that was supposed to make it gray, for the same reason. One water color was a
 * tidy rule and a wrong one; **gray is what the map says when it cannot tell you anything**, and
 * that is true of an unlisted pond and a retired lake alike.
 *
 * Achromatic on purpose (Review 2's rule: gray, not ice), so nothing receded carries the app's
 * hue. `primitives.test.ts` holds the halfway arithmetic, so moving the land or the ramp
 * carries this with them.
 */
export function mapUnknownWater(flavor: MapFlavor): string {
  return (flavor === 'dark' ? nativeThemes.skater.dark : nativeThemes.skater.light).color[
    'map-water-inactive'
  ];
}

/** The depth ramp's hue. The whole basemap sits on it, so nothing on the map is a second blue. */
const WINTER_HUE = 245;

/**
 * How far each role stands off the land, as a contrast ratio. A listed body's shoreline measures
 * 1.83:1 at the region view and 1.99:1 close in, so every one of these sits under it — the basemap
 * is ground. Chroma rises with distance because a near-white or near-black step carries almost none.
 */
const ROLES = {
  /** A building footprint: texture in a town at z15, nothing at all before it. */
  built: { contrast: 1.12, chroma: 0.006 },
  /** A residential street or a service road. */
  minor: { contrast: 1.18, chroma: 0.006 },
  /** A rule, not a road: boundaries, railways, piers, runways. */
  rule: { contrast: 1.26, chroma: 0.01 },
  /** A through road — the one you drive to the lake. */
  major: { contrast: 1.32, chroma: 0.008 },
  /**
   * An interstate: the loudest thing the basemap may draw, and still under the water. A road is how
   * you get to a lake, never a reason to look at one — at 1.55 it measured exactly what dark's water
   * does, and a highway that reads as loud as a river is the map arguing with its own subject.
   */
  highway: { contrast: 1.42, chroma: 0.01 },
  /** A road's own name, and an address. */
  labelQuiet: { contrast: 2.6, chroma: 0.008 },
  /** A state or a country: an enormous label for a thing a skater never looks up. */
  labelFaint: { contrast: 2.0, chroma: 0.008 },
  /** A village or a neighborhood. */
  labelPlace: { contrast: 3.4, chroma: 0.006 },
  /** A town, the one basemap label worth reading. Still under our own place names. */
  labelTown: { contrast: 4.6, chroma: 0.006 },
} as const;

type Role = keyof typeof ROLES;

/** Protomaps' landcover classes (dark only, today). Every one of them is snow here. */
const LANDCOVER_CLASSES = [
  'grassland',
  'barren',
  'urban_area',
  'farmland',
  'glacier',
  'scrub',
  'forest',
] as const;

/** Protomaps' POI color classes — a rainbow, flattened to one ink. */
const POI_CLASSES = [
  'blue',
  'green',
  'lapis',
  'pink',
  'red',
  'slategray',
  'tangerine',
  'turquoise',
] as const;

/** The land, as a color to solve against. */
function landOf(flavor: MapFlavor): Oklch {
  return hexToOklch(mapEarth(flavor));
}

/**
 * One step off the land. The direction is the land's own: a light map steps darker, a dark map
 * steps lighter, so a role keeps its distance from the ground in both.
 */
function step(land: Oklch, role: Role): string {
  const { contrast, chroma } = ROLES[role];
  return toHex(
    solveForContrast(
      { l: land.l, c: chroma, h: WINTER_HUE },
      land,
      contrast,
      land.l > 0.5 ? 'darker' : 'lighter',
    ),
  );
}

/**
 * The flavor Protomaps' layer generator paints from. Spread over the stock flavor so a key added by
 * a future version of `@protomaps/basemaps` still has a value; `winterFlavor.test.ts` holds that
 * every key we are handed today is one of ours, and that nothing on the map is green.
 */
export function winterFlavor(flavor: MapFlavor): Record<string, string> {
  const land = landOf(flavor);
  const earth = mapEarth(flavor);
  const water = mapUnknownWater(flavor);
  const s = (role: Role) => step(land, role);
  const built = s('built');
  const minor = s('minor');
  const rule = s('rule');
  const major = s('major');
  const highway = s('highway');

  return {
    ...(namedFlavor(flavor) as unknown as Record<string, string>),

    // The ground. `background` is the viewport fill and `earth` the land polygons; a background
    // layer ignores its source, so the two have to agree or the map has an edge where the tiles do.
    background: earth,
    earth,

    // Under snow, land has no categories. Every one of these is the land.
    park_a: earth,
    park_b: earth,
    wood_a: earth,
    wood_b: earth,
    scrub_a: earth,
    scrub_b: earth,
    glacier: earth,
    sand: earth,
    beach: earth,
    zoo: earth,
    military: earth,
    school: earth,
    hospital: earth,
    industrial: earth,
    pedestrian: earth,
    aerodrome: earth,

    // Unlisted water is gray: it is water we have nothing to say about, drawn exactly as a retired
    // body is. It also has to differ from band 0, or a listed lake's access dim — half opacity on
    // our fill — would be half of a color over the same color, and say nothing (#102).
    water,

    // The approach. Casings are the land, so a road reads as cut into it rather than laid on it.
    minor_service_casing: earth,
    minor_casing: earth,
    link_casing: earth,
    major_casing_early: earth,
    major_casing_late: earth,
    highway_casing_early: earth,
    highway_casing_late: earth,
    other: minor,
    minor_service: minor,
    minor_a: major,
    minor_b: minor,
    link: major,
    major,
    highway,

    // A bridge is its road; a tunnel is its road, under something, so it drops a step.
    bridges_other_casing: earth,
    bridges_minor_casing: earth,
    bridges_link_casing: earth,
    bridges_major_casing: earth,
    bridges_highway_casing: earth,
    bridges_other: minor,
    bridges_minor: minor,
    bridges_link: major,
    bridges_major: major,
    bridges_highway: highway,
    tunnel_other_casing: earth,
    tunnel_minor_casing: earth,
    tunnel_link_casing: earth,
    tunnel_major_casing: earth,
    tunnel_highway_casing: earth,
    tunnel_other: built,
    tunnel_minor: built,
    tunnel_link: built,
    tunnel_major: built,
    tunnel_highway: built,

    // The two nested maps, which is where the green actually was. `landcover` paints the zoomed-out
    // classes — its `forest` is rgba(28, 41, 37) and its grassland, farmland and scrub are each a
    // different green — and `pois` is a full rainbow (`green: #30C573`) that reaches the map because
    // `pois` is one of REGION_LABEL_SOURCE_LAYERS. Landcover is land, like every other class here;
    // every POI is one quiet ink, so a café and a boat ramp look alike, because on this map neither
    // is the subject. Stock `white` has neither key — they are set in both so a future version of
    // the generator that reads them in light finds ours rather than its own.

    landcover: Object.fromEntries(LANDCOVER_CLASSES.map((k) => [k, earth])) as unknown as string,
    pois: Object.fromEntries(POI_CLASSES.map((k) => [k, s('labelQuiet')])) as unknown as string,

    // Rules and structures.
    buildings: built,
    railway: rule,
    pier: rule,
    runway: rule,
    boundaries: rule,

    // Names, every one of them under our own. Halos are cut in the land, as every halo on this map
    // is, so a label lifts off whatever it crosses without introducing a color.
    roads_label_minor: s('labelQuiet'),
    roads_label_minor_halo: earth,
    roads_label_major: s('labelQuiet'),
    roads_label_major_halo: earth,
    address_label: s('labelQuiet'),
    address_label_halo: earth,
    subplace_label: s('labelPlace'),
    subplace_label_halo: earth,
    city_label: s('labelTown'),
    city_label_halo: earth,
    state_label: s('labelFaint'),
    state_label_halo: earth,
    country_label: s('labelFaint'),
    ocean_label: s('labelFaint'),
  };
}
