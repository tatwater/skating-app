import {
  confirmerClause,
  freshnessLabel,
  type HazardFreshness,
  type HazardType,
  hazardTypeLabel,
  humanizeEnum,
  iceTypeKeys,
  isHazardVisibleByDefault,
  isMeasuredDepthSource,
  isPassageMarker,
  metersToFeet,
  metersToMiles,
  NO_KNOWN_HAZARDS,
  OBSERVED_FROM_LABELS,
  type ObservedFrom,
  relativeWhen,
  roundTo,
  SKATE_QUALITY_LABELS,
  type SkateQuality,
  SUITABILITY_LABELS,
  type Suitability,
  sqMetersToAcres,
  stalenessCaveat,
  UNREPORTED_HAZARDS_POSSIBLE,
  waterBodyClassLabel,
} from '@skating/core';

/**
 * The lake sidebar's rules, as pure functions (B03 §1.1): what the header's facts say, what an In
 * view row says, what a hazard row and a report row say, and the hazard list's copy rule. Every
 * string a skater reads in the sidebar that is decided rather than read comes from here, so the
 * tests can hold the words — and, for the hazard list, prove the D3 rule over every count.
 *
 * **Nothing here describes the ice (D3).** A hazard's age is said as *confidence in the report*
 * (`freshnessLabel`, `stalenessCaveat`), never as a state of the water; a lake with nothing on its
 * list says so in the full sentence; a report's badges are the author's own claims, labeled as such.
 */

// ── The header's facts ──────────────────────────────────────────────────────────────────────

/**
 * One fact in the header's row: a kicker, the figure, and its unit beside it. **Units sit with the
 * values** (Review 3): the kicker reads `DEPTH AVG / MAX`, the figure `31 / 79`, the unit `ft`.
 */
export interface LakeFact {
  kicker: string;
  value: string;
  unit: string;
  /** A tooltip naming where the figure came from, when the source is worth naming. */
  title?: string;
}

type DepthSourceName = Parameters<typeof isMeasuredDepthSource>[0];

/** The depth fields a body or a bay carries. */
export interface DepthInput {
  meanDepthM?: number;
  maxDepthM?: number;
  meanDepthSource?: DepthSourceName;
  maxDepthSource?: DepthSourceName;
}

const usable = (v: number | undefined): v is number =>
  v !== undefined && Number.isFinite(v) && v > 0;

/** Whole feet, prefixed `~` when the source is a model rather than a survey. */
function feet(meters: number, source: DepthSourceName | undefined): string {
  const estimated = source !== undefined && !isMeasuredDepthSource(source);
  return `${estimated ? '~' : ''}${roundTo(metersToFeet(meters))}`;
}

/**
 * The depth fact — `DEPTH AVG / MAX · 31 / 79 ft`, or the half that's on file (`DEPTH MAX · 11 ft`
 * for George Pond). `null` when neither is: most of the corpus has no depth at all, and the header
 * then simply has one fact fewer rather than a dash.
 */
export function depthFact(body: DepthInput): LakeFact | null {
  const mean = usable(body.meanDepthM) && body.meanDepthSource !== undefined;
  const max = usable(body.maxDepthM) && body.maxDepthSource !== undefined;
  if (mean && max) {
    return {
      kicker: 'Depth avg / max',
      value: `${feet(body.meanDepthM as number, body.meanDepthSource)} / ${feet(body.maxDepthM as number, body.maxDepthSource)}`,
      unit: 'ft',
    };
  }
  if (max)
    return {
      kicker: 'Depth max',
      value: feet(body.maxDepthM as number, body.maxDepthSource),
      unit: 'ft',
    };
  if (mean)
    return {
      kicker: 'Depth avg',
      value: feet(body.meanDepthM as number, body.meanDepthSource),
      unit: 'ft',
    };
  return null;
}

/** `AREA · 1,143 ac`. Whole acres; a pond under one acre still reads as `1`. */
export function areaFact(surfaceAreaSqM: number | undefined): LakeFact | null {
  if (!usable(surfaceAreaSqM)) return null;
  const acres = Math.max(1, Math.round(sqMetersToAcres(surfaceAreaSqM)));
  return { kicker: 'Area', value: acres.toLocaleString('en-US'), unit: 'ac' };
}

/** `ELEVATION · 748 ft`. */
export function elevationFact(elevationM: number | undefined): LakeFact | null {
  if (elevationM === undefined || !Number.isFinite(elevationM)) return null;
  return {
    kicker: 'Elevation',
    value: Math.round(metersToFeet(elevationM)).toLocaleString('en-US'),
    unit: 'ft',
  };
}

/** The header's row, in the boards' order: area, depth, elevation — whichever are on file. */
export function lakeFacts(
  body: DepthInput & { surfaceAreaSqM?: number; elevationM?: number },
): LakeFact[] {
  return [areaFact(body.surfaceAreaSqM), depthFact(body), elevationFact(body.elevationM)].filter(
    (f): f is LakeFact => f !== null,
  );
}

/** The kicker over the name: "Reservoir · NH", "Bay · NH". */
export function lakeKicker(kind: string, states: readonly string[] | undefined): string {
  const label = kind === 'bay' ? 'Bay' : waterBodyClassLabel(kind);
  return states && states.length > 0 ? `${label} · ${states.join(', ')}` : label;
}

// ── The In view list ────────────────────────────────────────────────────────────────────────

/**
 * An In view row's sub-line: "Pond · 9 acres · 16 ft max" — what it is, how big, how deep. A list
 * says "79 ft max"; the header says the pair (Review 2).
 */
export function inViewSubLine(lake: {
  type: string;
  surfaceAreaSqM?: number;
  maxDepthM?: number;
}): string {
  const parts = [waterBodyClassLabel(lake.type)];
  if (usable(lake.surfaceAreaSqM)) {
    const acres = Math.max(1, Math.round(sqMetersToAcres(lake.surfaceAreaSqM)));
    parts.push(`${acres.toLocaleString('en-US')} ${acres === 1 ? 'acre' : 'acres'}`);
  }
  if (usable(lake.maxDepthM)) parts.push(`${Math.round(metersToFeet(lake.maxDepthM))} ft max`);
  return parts.join(' · ');
}

/** The row's right side: the latest day's count over its day, or a quiet note. */
export type InViewTrailing =
  | { kind: 'reports'; count: string; when: string }
  | { kind: 'note'; text: string };

/** The calendar day of `ms` in `timeZone`, as a sortable key. */
function dayKey(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-CA', timeZone ? { timeZone } : {});
}

/**
 * "3 reports / Today", "1 report / Tuesday" from the reports skated there in the last few days; an
 * inactive body says so; otherwise "No recent reports" — the read covers days, not the season, so it
 * can't know "yet", and silence here is never a statement about the ice.
 */
export function inViewTrailing(
  skateEndTimes: readonly number[],
  { now, inactive, timeZone }: { now: number; inactive: boolean; timeZone?: string },
): InViewTrailing {
  if (inactive) return { kind: 'note', text: 'Inactive' };
  if (skateEndTimes.length === 0) return { kind: 'note', text: 'No recent reports' };
  const latest = Math.max(...skateEndTimes);
  const day = dayKey(latest, timeZone);
  const count = skateEndTimes.filter((t) => dayKey(t, timeZone) === day).length;
  const when =
    day === dayKey(now, timeZone)
      ? 'Today'
      : new Date(latest).toLocaleDateString('en-US', {
          weekday: 'long',
          ...(timeZone ? { timeZone } : {}),
        });
  return { kind: 'reports', count: `${count} ${count === 1 ? 'report' : 'reports'}`, when };
}

/** "3 open bounties" — each person's ask is its own bounty, and nobody sees points (Review 2, 4). */
export function openBountiesLine(count: number): string {
  return `${count} open ${count === 1 ? 'bounty' : 'bounties'}`;
}

/** The In view heading's figure: "6 lakes". */
export function lakesCountLine(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'lake' : 'lakes'}`;
}

// ── Known hazards (D237) ────────────────────────────────────────────────────────────────────

/**
 * The hazard list's copy rule, the one D237 settled: **a populated list carries no standing
 * caveat** — the (i) beside *Known hazards* holds "It's possible there are unreported hazards on
 * this ice." — and **an empty list keeps its full sentence**, because an empty list is exactly where
 * silence would otherwise read as an all-clear (D3). Exactly one of the two is ever shown, so the
 * list is never silent and never says it twice. Both strings come from `@skating/core`'s
 * `hazardCopy`, the one home web and mobile share.
 */
export interface HazardListCopy {
  /** The (i) tooltip beside the title, on a populated list. */
  tooltip: string | null;
  /** The sentence an empty list shows in place of rows. */
  empty: string | null;
}

export function hazardListCopy(itemCount: number): HazardListCopy {
  return itemCount > 0
    ? { tooltip: UNREPORTED_HAZARDS_POSSIBLE, empty: null }
    : { tooltip: null, empty: NO_KNOWN_HAZARDS };
}

/**
 * When every marker on a lake is old enough to sit behind "Show older", the visible list is empty
 * but the lake is not — said in these words so it can't read as the empty state (kept from the old
 * drawer's list, word for word).
 */
export const ONLY_OLDER_MARKERS = 'Nothing reported recently — only older, unverified markers.';

/** A hazard as the lake's list reads it (`hazards.listForBody`'s view, the fields used). */
export interface HazardRowInput {
  _id: string;
  type: HazardType;
  freshness: HazardFreshness;
  provisional: boolean;
  healingState?: 'none' | 'healing_unsafe' | 'disputed';
  subAreaName?: string;
  firstReportedAt: number;
  confirmCount: number;
  clusterConfirmCount?: number;
}

export interface HazardRowModel {
  id: string;
  title: string;
  /** "Mascoma North · reported 3 days ago · confirmed by 2 skaters". */
  line: string;
  /** How sure the report still is — confidence in the observation, never a state of the ice. */
  confidence: string;
  /** The type's own caveat once a report has aged: what it may have become, never "gone". */
  caveat: string | null;
  /** The marks beside the title. */
  tags: string[];
  /** Fresh rows rest in red; an aging one is still red — only the wording softens (D3). */
  older: boolean;
}

export function hazardRowModel(h: HazardRowInput, now: number): HazardRowModel {
  const confirmed = confirmerClause([], h.clusterConfirmCount ?? h.confirmCount);
  const line = [h.subAreaName, `reported ${relativeWhen(h.firstReportedAt, now)}`, confirmed]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' · ');
  const tags: string[] = [];
  if (isPassageMarker(h.type)) tags.push('Crossing');
  if (h.healingState === 'disputed') tags.push('Disputed');
  if (h.healingState === 'healing_unsafe') tags.push('Healing');
  if (h.provisional) tags.push('Unconfirmed');
  return {
    id: h._id,
    title: hazardTypeLabel(h.type),
    line,
    confidence: freshnessLabel(h.freshness),
    caveat: h.freshness === 'fresh' ? null : stalenessCaveat(h.type),
    tags,
    older: !isHazardVisibleByDefault(h.freshness),
  };
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────

/** A report as `reports.listByWaterBody` returns it (the fields the lake's row reads). */
export interface ReportRowInput {
  _id: string;
  authorId: string;
  skateEndTime: number;
  subAreaName?: string;
  subAreaNames?: string[];
  observedFrom?: ObservedFrom;
  suitability?: Suitability;
  skateQuality?: SkateQuality;
  iceTypes?: Parameters<typeof iceTypeKeys>[0];
  notes?: string;
  photoIds?: readonly string[];
}

export interface ReportRowModel {
  id: string;
  when: string;
  /** "Mascoma North · From shore". Empty when the report says neither. */
  where: string;
  /**
   * The author's claims, labeled: who it's for (an outline; "Don't go" in red), then how it skated
   * (the filled face — the boards' `.bdg.solid`).
   */
  badges: { label: string; kind: 'suitability' | 'quality'; tone: 'default' | 'bad' }[];
  notes: string | null;
  iceTypes: string[];
  photoCount: number;
}

const DAY_MS = 86_400_000;

/**
 * When a report was skated, short: "Today · 11:40 AM", "Thu · 3:15 PM" within the week, then
 * "Jan 5". Only this season is ever listed, so a year is never needed.
 */
export function reportWhen(ms: number, now: number, timeZone?: string): string {
  const tz = timeZone ? { timeZone } : {};
  const time = new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...tz,
  });
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return `Today · ${time}`;
  if (now - ms < 6 * DAY_MS) {
    const day = new Date(ms).toLocaleDateString('en-US', { weekday: 'short', ...tz });
    return `${day} · ${time}`;
  }
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...tz });
}

export function reportRowModel(r: ReportRowInput, now: number, timeZone?: string): ReportRowModel {
  const bays = r.subAreaNames?.length ? r.subAreaNames : r.subAreaName ? [r.subAreaName] : [];
  const where = [bays.join(', '), r.observedFrom ? OBSERVED_FROM_LABELS[r.observedFrom] : undefined]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' · ');
  const badges: ReportRowModel['badges'] = [];
  if (r.suitability) {
    badges.push({
      label: SUITABILITY_LABELS[r.suitability],
      kind: 'suitability',
      tone: r.suitability === 'dont_go' ? 'bad' : 'default',
    });
  }
  if (r.skateQuality) {
    badges.push({ label: SKATE_QUALITY_LABELS[r.skateQuality], kind: 'quality', tone: 'default' });
  }
  const notes = r.notes?.trim();
  return {
    id: r._id,
    when: reportWhen(r.skateEndTime, now, timeZone),
    where,
    badges,
    notes: notes ? notes : null,
    iceTypes: iceTypeKeys(r.iceTypes).map(humanizeEnum),
    photoCount: r.photoIds?.length ?? 0,
  };
}

// ── About ───────────────────────────────────────────────────────────────────────────────────

const COMPASS_8 = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

/** "northwest to southeast", from a long axis's bearing (either end; the axis has no direction). */
export function axisLine(bearingDeg: number): string {
  const b = ((bearingDeg % 180) + 180) % 180;
  const i = Math.round(b / 45) % 8;
  const a = COMPASS_8[i] as string;
  const z = COMPASS_8[(i + 4) % 8] as string;
  // Read north-first, as a person would say it ("northwest to southeast", not the reverse): the
  // bearing lands in 0–180°, so only southeast and south have their north end on the far side.
  return i >= 3 ? `${z} to ${a}` : `${a} to ${z}`;
}

function miles(m: number): string {
  const mi = metersToMiles(m);
  return `${roundTo(mi, mi < 100 ? 1 : 0)} mi`;
}

/** The Shape section's rows: shoreline, length (with its axis), width — whichever are on file. */
export function shapeRows(body: {
  shorelineM?: number;
  longAxisM?: number;
  longAxisBearingDeg?: number;
  shortAxisM?: number;
}): { term: string; value: string }[] {
  const rows: { term: string; value: string }[] = [];
  if (usable(body.shorelineM)) rows.push({ term: 'Shoreline', value: miles(body.shorelineM) });
  if (usable(body.longAxisM)) {
    const axis =
      body.longAxisBearingDeg !== undefined && Number.isFinite(body.longAxisBearingDeg)
        ? `, ${axisLine(body.longAxisBearingDeg)}`
        : '';
    rows.push({ term: 'Length', value: `${miles(body.longAxisM)}${axis}` });
  }
  if (usable(body.shortAxisM)) {
    rows.push({ term: 'Width', value: `${miles(body.shortAxisM)} at its widest` });
  }
  return rows;
}

/** The basemap's credit, at every sidebar's foot (Review 4: `.caveat.foot`). */
export const BASEMAP_CREDIT = 'Basemap and water © OpenStreetMap contributors.';

/**
 * The foot's lines: the contours' own credit while the map is drawing them (the tile is the
 * authority, read by the map into its store), then the basemap's, always.
 */
export function attributionLines(contourCredit: string | null): string[] {
  const credit = contourCredit?.trim();
  if (!credit) return [BASEMAP_CREDIT];
  return [credit.charAt(0).toUpperCase() + credit.slice(1), BASEMAP_CREDIT];
}
