import { hazardFootprint } from '@skating/core';
import { featureGlyph } from './featureGlyph';
import type { FeatureRowWithGlyph, Winters } from './HazardsTabView';
import type { HazardsMapData } from './hazardsMap';
import {
  type DailyOnLake,
  type FeatureInput,
  featureRows,
  type HazardInput,
  monthTicks,
  stripValues,
  winterWindow,
} from './hazardsModel';

/**
 * Board 5.4.7's Mascoma Lake on the Body row's pinned day — Wednesday 14 October 2026, midday in
 * the runner's own zone, day 10 of the watch (it opened 3 Oct). Nothing marked yet this winter;
 * two known features; last winter's record for the strip. A populated list (17 Feb 2026's) for the
 * rows the default board doesn't show. Stories and tests only.
 */
export const BODY_NOW = new Date(2026, 9, 14, 12, 0).getTime();
export const SEASON = 2026;
export const WATCH_OPENED = new Date(2026, 9, 3, 12, 0).getTime();

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0).getTime();

export const MASCOMA_FEATURES: FeatureInput[] = [
  {
    _id: 'f-spring',
    type: 'spring_current',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [-72.1502, 43.6385] },
    radiusMeters: 60,
    subAreaName: 'Mascoma River inlet',
    promotedFromHazardId: 'h-old-spring',
    createdAt: day(2026, 1, 21),
  },
  {
    _id: 'f-narrows',
    type: 'bridge_narrows',
    geometryKind: 'line',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-72.1581, 43.6312],
        [-72.1566, 43.6322],
      ],
    },
    bufferMeters: 40,
    subAreaName: 'Shaker Bridge',
    createdAt: day(2025, 11, 18),
  },
];

export const MASCOMA_FEATURE_ROWS: FeatureRowWithGlyph[] = featureRows(MASCOMA_FEATURES).map(
  (row, i) => {
    const f = MASCOMA_FEATURES[i] as FeatureInput;
    return {
      ...row,
      glyph: featureGlyph(
        hazardFootprint({
          geometryKind: f.geometryKind,
          geometry: f.geometry as GeoJSON.Point,
          ...(f.radiusMeters !== undefined ? { radiusMeters: f.radiusMeters } : {}),
          ...(f.bufferMeters !== undefined ? { bufferMeters: f.bufferMeters } : {}),
        }),
      ),
    };
  },
);

/** When each of last winter's hazards was on the lake (first reported → archived or stale). */
const LAST_WINTER: [number, number, number, number][] = [
  [12, 3, 1, 8],
  [12, 14, 12, 21],
  [12, 28, 2, 9],
  [1, 24, 1, 26],
  [2, 8, 2, 20],
  [2, 9, 3, 16],
  [2, 10, 2, 23],
  [2, 15, 2, 18],
  [2, 17, 3, 2],
  [3, 8, 3, 13],
];

const UTC_DAY = 86_400_000;

/** Last winter's per-day count, as the read would hand it. */
export const LAST_WINTER_DAILY: DailyOnLake = (() => {
  const { start, days } = winterWindow(SEASON - 1);
  const counts = new Map<number, number>();
  for (const [m0, d0, m1, d1] of LAST_WINTER) {
    const y0 = m0 >= 10 ? 2025 : 2026;
    const y1 = m1 >= 10 ? 2025 : 2026;
    for (let t = Date.UTC(y0, m0 - 1, d0); t < Date.UTC(y1, m1 - 1, d1); t += UTC_DAY) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return {
    season: SEASON - 1,
    days: [...counts]
      .filter(([t]) => t >= start && t < start + days * UTC_DAY)
      .map(([at, count]) => ({ at, count })),
  };
})();

export const MASCOMA_WINTERS: Winters = {
  days: winterWindow(SEASON).days,
  months: monthTicks(SEASON),
  current: stripValues({ season: SEASON, days: [] }, BODY_NOW),
  previous: stripValues(LAST_WINTER_DAILY, BODY_NOW),
  today: 13,
  opens: 2,
};

/** 17 Feb 2026's list, for the rows (as `hazards.listForBody` hands them). */
export const FEB_NOW = new Date(2026, 1, 17, 12, 0).getTime();
export const FEB_HAZARDS: HazardInput[] = [
  {
    _id: 'h-ridge',
    type: 'pressure_ridge',
    subAreaName: 'Black Point to Wood Island',
    freshness: 'fresh',
    provisional: false,
    confirmCount: 3,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 26 * 3_600_000,
    status: 'active',
  },
  {
    _id: 'h-crack',
    type: 'wet_crack',
    subAreaName: 'Across the north end',
    freshness: 'aging',
    provisional: false,
    healingState: 'healing_unsafe',
    confirmCount: 1,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 93 * 3_600_000,
    status: 'active',
  },
  {
    _id: 'h-thin',
    type: 'thin_ice',
    subAreaName: 'Off Lower Shaker Village',
    freshness: 'fresh',
    provisional: false,
    confirmCount: 1,
    goneCount: 1,
    lastConfirmedAt: FEB_NOW - 20.5 * 3_600_000,
    status: 'active',
  },
  {
    _id: 'h-slush',
    type: 'overflow_slush',
    subAreaName: 'Off Mascoma Lake Campground',
    freshness: 'stale',
    provisional: false,
    confirmCount: 1,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 194 * 3_600_000,
    status: 'active',
  },
  {
    _id: 'h-air',
    type: 'air_pockets',
    subAreaName: 'East of Relham Island',
    freshness: 'fresh',
    provisional: true,
    confirmCount: 0,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 4.3 * 3_600_000,
    status: 'active',
  },
];
export const FEB_ARCHIVED: HazardInput[] = [
  {
    _id: 'h-inlet',
    type: 'spring_current',
    subAreaName: 'Mascoma River inlet',
    freshness: 'stale',
    provisional: false,
    confirmCount: 2,
    goneCount: 2,
    lastConfirmedAt: day(2026, 2, 9),
    status: 'archived',
  },
  {
    _id: 'h-launch',
    type: 'open_water',
    subAreaName: 'Off the Boat Launch',
    freshness: 'stale',
    provisional: false,
    confirmCount: 1,
    goneCount: 2,
    lastConfirmedAt: day(2026, 1, 26),
    status: 'archived',
  },
];

/** The map's data for the default board: no hazards, the two features. */
export const MASCOMA_MAP_DATA: HazardsMapData = {
  hazards: [],
  features: MASCOMA_FEATURES.map((f) => ({ ...f, geometryKind: f.geometryKind })),
};
