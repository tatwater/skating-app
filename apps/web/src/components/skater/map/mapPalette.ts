/**
 * The skater map's colors, resolved from the design tokens for the GL layers that can't read a CSS
 * variable (D232). The DOM marks and labels use the token classes directly; this is the same values
 * for MapLibre's paint properties, so the two halves of the map can't drift apart.
 *
 * The map speaks the app's three hues and nothing else: **ice** is water, geography, a path and a
 * suggested crossing; **amber** is the walk in from the car (hike-in, a need); **red** is a hazard.
 * Everything that isn't one of those is ink or ground — the selection is the lit ink, an inactive
 * body is gray, the names and the bay edges are body ink. Review 2's rule holds: color on a body
 * means selection or depth, nothing else. The water is one ice wash for every listed body, its shore
 * the same ice at rest, lit to full ice under the pointer and to white when chosen; depth is the
 * founder's seven-band ramp and reads as bathymetry, never as a quality of the ice (D3, D82).
 *
 * The **map's ground** was the one color that wasn't a token — the halos and the label shadow were
 * cut in the Protomaps flavor's own field color (Review 2). It is `map-earth` now, and the basemap
 * follows *it* (`mapEarth`, `buildMapStyle`): the flavor's `white` earth is `#ffffff`, the skater
 * light field exactly, so the map pane had no edge against the sidebar at all (founder, 2026-11-09).
 * Nothing on this map is a hex of its own any more, and `mapPalette.test.ts` holds that.
 */

import { DEPTH_BAND_EDGES_FT, type HazardPalette } from '@skating/core';
import { nativeThemes } from '@skating/design/native';
import type { CSSProperties } from 'react';
import { type MapFlavor, mapEarth } from '@/lib/waterMap';

/** Every contour on a multiple of this is an index line: a touch heavier, a touch brighter. */
export const DEPTH_INDEX_INTERVAL_FT = 25;

export interface DepthRamp {
  fills: readonly string[];
  lines: readonly string[];
  indexes: readonly string[];
}

export interface MapPalette {
  flavor: MapFlavor;
  /** The map's land: the halo and label-shadow color. */
  ground: string;
  /** Every listed body's water and its shore at rest: the shallowest depth band and its contour. */
  water: { fill: string; shore: string };
  /** An inactive body: gray, not ice (Review 2) — an ink lift and an ink hairline. */
  inactive: { fill: string; shore: string };
  /** The lit ice: a hovered shore, a skated path, a photo pin, the imagery reveal's loading wash. */
  accent: string;
  /** The chosen lake's shore (and a framed bay's): the lit ink. */
  selected: string;
  /** A hovered lake's shore: a step up the same band — band 0's index line. */
  hovered: string;
  depth: DepthRamp;
  hazard: HazardPalette;
  /** Bay names and edges in body ink; landmarks a step quieter (a landmark is a reference, D202). */
  places: { label: string; landmark: string; halo: string; outline: string };
  track: string;
  scrim: string;
}

type ColorMap = Readonly<Record<keyof (typeof nativeThemes)['skater']['dark']['color'], string>>;

function themeColors(flavor: MapFlavor): ColorMap {
  return flavor === 'dark' ? nativeThemes.skater.dark.color : nativeThemes.skater.light.color;
}

export function mapPalette(flavor: MapFlavor): MapPalette {
  const c = themeColors(flavor);
  const band = (suffix: '' | '-line' | '-index') =>
    DEPTH_BAND_EDGES_FT.map((_, i) => c[`depth-${i}${suffix}` as keyof ColorMap] as string);
  return {
    flavor,
    ground: mapEarth(flavor),
    // A body is drawn in the depth language whether or not its depth is open: band 0 is the water
    // and band 0's index line is its shore, so opening a lake reveals the deeper bands that were
    // always under it rather than changing the color of the water it was already showing. The
    // index line, not the contour: a 1 px contour measures 1.58:1 on the new land in light, under
    // the floor this file holds, and the index line is the step the ramp means you to read anyway.
    water: { fill: c['depth-0'], shore: c['depth-0-index'] },
    inactive: { fill: c['map-water-inactive'], shore: c['map-shore-inactive'] },
    accent: c.acc,
    selected: c.fg,
    // One step further along the water's own ramp, never a jump to another hue.
    hovered: c['map-shore-hover'],
    depth: { fills: band(''), lines: band('-line'), indexes: band('-index') },
    // Danger and healing in the skater tokens; the passage marker in ice — it is a suggestion
    // somebody made about a crossing, and green would read as a verdict on it (D3). A known body
    // feature (D53) is a fact about the place, not a warning: quiet ink, never a hazard color.
    hazard: { danger: c.bad, healing: c.warn, passage: c.acc, feature: c.fg3 },
    places: { label: c.fg2, landmark: c.fg3, halo: mapEarth(flavor), outline: c.fg2 },
    track: c.acc,
    scrim: c.scrim,
  };
}

/**
 * The pane's custom properties for the DOM marks and labels: the ground for halos, and the label
 * shadow (the field at the mock's strength, so the words read over anything).
 */
export function mapMarkVars(flavor: MapFlavor): CSSProperties {
  const ground = mapEarth(flavor);
  return {
    '--map-ground': ground,
    '--lab-sh': `color-mix(in oklab, var(--bg) ${flavor === 'dark' ? 92 : 95}%, transparent)`,
  } as CSSProperties;
}

/**
 * The shore's weight by zoom: soft where the region is a field of lakes, so a hundred 1 px outlines
 * don't become the loudest thing on the map, and full once a lake is the subject. A per-feature
 * dim (`withAccessDim`) goes on each stop's output — MapLibre allows `zoom` only at the top of a
 * paint expression, so the curve can't be multiplied from outside.
 */
export const SHORE_OPACITY_BY_ZOOM = { farZoom: 7, far: 0.9, nearZoom: 11, near: 1 } as const;

export function shoreOpacityByZoom(stop: (opacity: number) => unknown = (o) => o): unknown[] {
  const z = SHORE_OPACITY_BY_ZOOM;
  return ['interpolate', ['linear'], ['zoom'], z.farZoom, stop(z.far), z.nearZoom, stop(z.near)];
}

/** A contour's color: its band's line, or its band's index line on a multiple of 25 ft. */
export function contourColorByBand(ramp: DepthRamp): unknown[] {
  const depth = ['to-number', ['get', 'depthFt'], 0];
  const step = (colors: readonly string[]) => [
    'step',
    depth,
    colors[0],
    ...DEPTH_BAND_EDGES_FT.slice(1).flatMap((edge, i) => [edge, colors[i + 1]]),
  ];
  return ['case', isIndexLine(depth), step(ramp.indexes), step(ramp.lines)];
}

/**
 * A band polygon's fill: its band's token fill, keyed on the tile's `bandIndex`. A `step`, so an
 * index past the ramp clamps to the deepest band and a missing one reads as the shallowest — never
 * as no color at all.
 */
export function bandFillColor(ramp: DepthRamp): unknown[] {
  return [
    'step',
    ['to-number', ['get', 'bandIndex'], 0],
    ramp.fills[0],
    ...ramp.fills.slice(1).flatMap((color, i) => [i + 1, color]),
  ];
}

/** Index lines are 1.2 px, the rest 0.8 (mock `bathy`). */
export function contourWidthByBand(): unknown[] {
  return ['case', isIndexLine(['to-number', ['get', 'depthFt'], 0]), 1.2, 0.8];
}

function isIndexLine(depth: unknown[]): unknown[] {
  return ['all', ['>', depth, 0], ['==', ['%', depth, DEPTH_INDEX_INTERVAL_FT], 0]];
}
