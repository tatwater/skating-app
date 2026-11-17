import { featureGlyphOf } from './featureGlyph';
import type { FeatureRowWithGlyph } from './HazardsTabView';
import type { HazardsMapData } from './hazardsMap';
import {
  type DailyHazards,
  type FeatureInput,
  featureRows,
  type HazardInput,
  type Winters,
  wintersFrom,
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
/** The watch's opening as the season record stores it: a day, read as its UTC midnight. */
export const WATCH_OPENED = Date.UTC(2026, 9, 3);

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0).getTime();

/** A hazard's stored shape as the read hands it: a point and its radius, on Mascoma. */
const pinAt = (lng: number, lat: number, radiusMeters = 40) => ({
  geometryKind: 'point_radius' as const,
  geometry: { type: 'Point', coordinates: [lng, lat] },
  radiusMeters,
});

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
  (row, i) => ({ ...row, glyph: featureGlyphOf(MASCOMA_FEATURES[i] as FeatureInput) }),
);

/**
 * Last winter's hazards on Mascoma as the store holds them: the day each was first reported, and
 * whether it is still active (stale, never voted gone) or archived. An archived hazard's end isn't
 * stored, so the read counts it on its first day and as unknown every day after, to the winter's
 * end; the strip marks its first report and says the rest in words — never a lake gone clear.
 */
const LAST_WINTER: { m: number; d: number; active: boolean }[] = [
  { m: 12, d: 3, active: false },
  { m: 12, d: 14, active: false },
  { m: 12, d: 28, active: false },
  { m: 1, d: 24, active: false },
  { m: 2, d: 8, active: false },
  { m: 2, d: 9, active: true },
  { m: 2, d: 10, active: false },
  { m: 2, d: 15, active: false },
  { m: 2, d: 17, active: true },
  { m: 3, d: 8, active: false },
];

const UTC_DAY = 86_400_000;

/**
 * A season's day-by-day read, built the way `bodyConsole.dailyHazards` builds it: the window is the
 * season (1 July on), counted through the whole of the caller's UTC day. An active hazard counts
 * from its first report through today; an archived one with a recorded end (`ended`) through its
 * end's day; an archived one with none counts on its first day and is unknown after. Each listed
 * hazard says whether it is still active, as the server does since B01-3n; with `legacy`, the read
 * is one from before the server said it (the state unknown), which the strip still reads by the
 * next-day rule. Stories and tests only.
 */
export function dailyFrom(
  season: number,
  hazards: readonly { first: number; active: boolean; ended?: number }[],
  now: number,
  extra: Partial<Pick<DailyHazards, 'capped' | 'watchOpensOn'>> & { legacy?: boolean } = {},
): DailyHazards {
  const { start, days } = winterWindow(season);
  const last = Math.min(Math.floor(now / UTC_DAY) * UTC_DAY + UTC_DAY, start + days * UTC_DAY);
  const tally = new Map<number, { count: number; unknown: number }>();
  for (const h of hazards) {
    const firstDay = Math.floor(h.first / UTC_DAY) * UTC_DAY;
    const endDay =
      !h.active && h.ended !== undefined ? Math.floor(h.ended / UTC_DAY) * UTC_DAY : null;
    const through = h.active ? last : endDay === null ? last : Math.min(endDay + UTC_DAY, last);
    for (let t = Math.max(firstDay, start); t < through; t += UTC_DAY) {
      const d = tally.get(t) ?? { count: 0, unknown: 0 };
      if (h.active || endDay !== null || t === firstDay) d.count++;
      else d.unknown++;
      tally.set(t, d);
    }
  }
  return {
    season,
    days: [...tally].sort(([a], [b]) => a - b).map(([at, d]) => ({ at, ...d })),
    unknownEnds: hazards.filter((h) => !h.active && h.ended === undefined).length,
    hazards: hazards.map((h) => ({
      firstReportedDay: Math.floor(h.first / UTC_DAY) * UTC_DAY,
      endRecorded: !h.active && h.ended !== undefined,
      ...(extra.legacy === true ? {} : { active: h.active }),
    })),
    capped: extra.capped ?? false,
    watchOpensOn: extra.watchOpensOn ?? null,
  };
}

const lastWinterFirst = (h: { m: number; d: number }) =>
  Date.UTC(h.m >= 10 ? SEASON - 1 : SEASON, h.m - 1, h.d, 15);

/** Last winter's read, on the Body row's pinned day. */
export const LAST_WINTER_DAILY: DailyHazards = dailyFrom(
  SEASON - 1,
  LAST_WINTER.map((h) => ({ first: lastWinterFirst(h), active: h.active })),
  BODY_NOW,
);

/** Last winter's read as a server from before B01-3n gave it: no hazard's state said. */
export const LAST_WINTER_DAILY_LEGACY: DailyHazards = dailyFrom(
  SEASON - 1,
  LAST_WINTER.map((h) => ({ first: lastWinterFirst(h), active: h.active })),
  BODY_NOW,
  { legacy: true },
);

/** Last winter's hazards as `hazards.listForBody` hands them with archived (the archived group). */
export const LAST_WINTER_LIST: HazardInput[] = LAST_WINTER.map((h, i) => ({
  _id: `h-last-${i}`,
  type: 'pressure_ridge',
  ...pinAt(-72.16 + i * 0.001, 43.635),
  freshness: 'stale',
  provisional: false,
  confirmCount: 1,
  goneCount: h.active ? 0 : 2,
  lastConfirmedAt: lastWinterFirst(h),
  firstReportedAt: lastWinterFirst(h),
  status: h.active ? 'active' : 'archived',
}));

/** This winter's read on 14 Oct: nothing marked, the watch open since 3 Oct. */
export const THIS_WINTER_DAILY: DailyHazards = dailyFrom(SEASON, [], BODY_NOW, {
  watchOpensOn: WATCH_OPENED,
});

/** Last winter on its own, as a past winter is drawn when chosen: each first report a mark. */
export const PAST_WINTERS = wintersFrom([LAST_WINTER_DAILY], BODY_NOW) as Winters;

/** This winter beside last winter's record, as the default board draws them, both marked. */
export const MASCOMA_WINTERS = wintersFrom(
  [THIS_WINTER_DAILY, LAST_WINTER_DAILY],
  BODY_NOW,
) as Winters;

/** 17 Feb 2026's list, for the rows (as `hazards.listForBody` hands them). */
export const FEB_NOW = new Date(2026, 1, 17, 12, 0).getTime();
export const FEB_HAZARDS: HazardInput[] = [
  {
    _id: 'h-ridge',
    ...pinAt(-72.1611, 43.6402),
    type: 'pressure_ridge',
    subAreaName: 'Black Point to Wood Island',
    freshness: 'fresh',
    provisional: false,
    confirmCount: 3,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 26 * 3_600_000,
    firstReportedAt: FEB_NOW - 26 * 3_600_000 - 5 * 86_400_000,
    status: 'active',
  },
  {
    _id: 'h-crack',
    ...pinAt(-72.1545, 43.6468),
    type: 'wet_crack',
    subAreaName: 'Across the north end',
    freshness: 'aging',
    provisional: false,
    healingState: 'healing_unsafe',
    confirmCount: 1,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 93 * 3_600_000,
    firstReportedAt: FEB_NOW - 93 * 3_600_000 - 5 * 86_400_000,
    status: 'active',
  },
  {
    _id: 'h-thin',
    ...pinAt(-72.1689, 43.6331),
    type: 'thin_ice',
    subAreaName: 'Off Lower Shaker Village',
    freshness: 'fresh',
    provisional: false,
    confirmCount: 1,
    goneCount: 1,
    lastConfirmedAt: FEB_NOW - 20.5 * 3_600_000,
    firstReportedAt: FEB_NOW - 20.5 * 3_600_000 - 5 * 86_400_000,
    status: 'active',
  },
  {
    _id: 'h-slush',
    ...pinAt(-72.1757, 43.644),
    type: 'overflow_slush',
    subAreaName: 'Off Mascoma Lake Campground',
    freshness: 'stale',
    provisional: false,
    confirmCount: 1,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 194 * 3_600_000,
    firstReportedAt: FEB_NOW - 194 * 3_600_000 - 5 * 86_400_000,
    status: 'active',
  },
  {
    _id: 'h-air',
    ...pinAt(-72.1498, 43.6376),
    type: 'air_pockets',
    subAreaName: 'East of Relham Island',
    freshness: 'fresh',
    provisional: true,
    confirmCount: 0,
    goneCount: 0,
    lastConfirmedAt: FEB_NOW - 4.3 * 3_600_000,
    firstReportedAt: FEB_NOW - 4.3 * 3_600_000 - 5 * 86_400_000,
    status: 'active',
  },
];
export const FEB_ARCHIVED: HazardInput[] = [
  {
    _id: 'h-inlet',
    ...pinAt(-72.1502, 43.6385),
    type: 'spring_current',
    subAreaName: 'Mascoma River inlet',
    freshness: 'stale',
    provisional: false,
    confirmCount: 2,
    goneCount: 2,
    lastConfirmedAt: day(2026, 2, 9),
    firstReportedAt: day(2026, 2, 9) - 5 * 86_400_000,
    status: 'archived',
  },
  {
    _id: 'h-launch',
    ...pinAt(-72.1584, 43.6297),
    type: 'open_water',
    subAreaName: 'Off the Boat Launch',
    freshness: 'stale',
    provisional: false,
    confirmCount: 1,
    goneCount: 2,
    lastConfirmedAt: day(2026, 1, 26),
    firstReportedAt: day(2026, 1, 26) - 5 * 86_400_000,
    status: 'archived',
  },
];

/** The map's data for the default board: no hazards, the two features. */
export const MASCOMA_MAP_DATA: HazardsMapData = {
  season: 2025,
  current: 2025,
  hazards: [],
  features: MASCOMA_FEATURES.map((f) => ({ ...f, geometryKind: f.geometryKind })),
};
