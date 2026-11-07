/**
 * The skater map's colors, resolved from the design tokens for the GL layers that can't read a CSS
 * variable (D232). The DOM marks and labels use the token classes directly; this is the same values
 * for MapLibre's paint properties, so the two halves of the map can't drift apart.
 *
 * The one color that isn't a token is the **map's ground**: the halos and the label shadow are cut
 * in the basemap's own field color (Review 2), so it comes from the Protomaps flavor itself and
 * follows the basemap if the basemap ever changes.
 */

import { namedFlavor } from '@protomaps/basemaps';
import type { HazardPalette } from '@skating/core';
import { nativeThemes } from '@skating/design/native';
import type { CSSProperties } from 'react';
import { HAZARD_PALETTE } from '@/lib/hazardMap';
import { type MapFlavor, WATER_PALETTE } from '@/lib/waterMap';

/** The seven depth bands' lower edges, ft — the founder's ramp (mock `chrome.js` `EDGES`). */
export const DEPTH_BAND_EDGES_FT = [0, 5, 10, 20, 30, 45, 70] as const;
/** Every contour on a multiple of this is an index line: a touch heavier, a touch brighter. */
export const DEPTH_INDEX_INTERVAL_FT = 25;

/** The band a depth falls in: the last edge at or under it. Negative or unknown depth is band 0. */
export function depthBandIndex(depthFt: number): number {
  let band = 0;
  DEPTH_BAND_EDGES_FT.forEach((edge, i) => {
    if (depthFt >= edge) band = i;
  });
  return band;
}

export interface DepthRamp {
  fills: readonly string[];
  lines: readonly string[];
  indexes: readonly string[];
}

export interface MapPalette {
  flavor: MapFlavor;
  /** The basemap's field: the halo and label-shadow color. */
  ground: string;
  water: { fill: string; outline: string; fillOpacity: number };
  inactive: { fill: string; outline: string };
  /** The focused lake's shore and a hovered one's. */
  selected: string;
  hovered: string;
  depth: DepthRamp;
  hazard: HazardPalette;
  places: { label: string; halo: string; outline: string };
  track: string;
  scrim: string;
}

type ColorMap = Readonly<Record<keyof (typeof nativeThemes)['skater']['dark']['color'], string>>;

function themeColors(flavor: MapFlavor): ColorMap {
  return flavor === 'dark' ? nativeThemes.skater.dark.color : nativeThemes.skater.light.color;
}

/** The basemap's own field color for a flavor (#1f1f1f on dark). */
export function mapGround(flavor: MapFlavor): string {
  return (namedFlavor(flavor) as unknown as { earth: string }).earth;
}

export function mapPalette(flavor: MapFlavor): MapPalette {
  const c = themeColors(flavor);
  const band = (suffix: '' | '-line' | '-index') =>
    DEPTH_BAND_EDGES_FT.map((_, i) => c[`depth-${i}${suffix}` as keyof ColorMap] as string);
  const dark = flavor === 'dark';
  return {
    flavor,
    ground: mapGround(flavor),
    // The app's one water color for every body (Review 2: color on a body means selection or depth).
    water: {
      fill: WATER_PALETTE.dark.fill,
      outline: dark ? WATER_PALETTE.dark.outline : WATER_PALETTE.dark.fill,
      fillOpacity: dark ? 0.55 : 0.32,
    },
    // Inactive bodies are gray, not ice (Review 2).
    inactive: { fill: c.fg3, outline: c.fg3 },
    selected: c.fg,
    hovered: c.fg1,
    depth: { fills: band(''), lines: band('-line'), indexes: band('-index') },
    // Danger and healing in the skater tokens; the passage marker in ice — it is a suggestion
    // somebody made about a crossing, and green would read as a verdict on it (D3).
    hazard: { ...HAZARD_PALETTE[flavor], danger: c.bad, healing: c.warn, passage: c.acc },
    places: { label: c.fg2, halo: mapGround(flavor), outline: c.fg2 },
    track: c.acc,
    scrim: c.scrim,
  };
}

/**
 * The pane's custom properties for the DOM marks and labels: the ground for halos, and the label
 * shadow (the field at the mock's strength, so the words read over anything).
 */
export function mapMarkVars(flavor: MapFlavor): CSSProperties {
  const ground = mapGround(flavor);
  return {
    '--map-ground': ground,
    '--lab-sh': `color-mix(in oklab, var(--bg) ${flavor === 'dark' ? 92 : 95}%, transparent)`,
  } as CSSProperties;
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
