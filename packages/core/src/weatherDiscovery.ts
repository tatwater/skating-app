/**
 * Weather-first discovery — the per-cell digest and the filter that reads it (N6h Workstream E /
 * **D159**, **D164**, **D165**).
 *
 * ## Why a digest exists
 *
 * *"Bodies within two hours' drive that got at least three nights below 20°F and no snow since"* is
 * a question about ~3,043 Tier-B cells × a window of days — ~21,000 documents against Convex's
 * 16,384-document read cap, before a single body is resolved. So the daily sweep reduces each cell's
 * recent days to **one small document** holding exactly the quantities a filter asks about, and the
 * query reads digests, not days.
 *
 * ## Why the chain lengths are also flat scalars
 *
 * In a real January every cell in Vermont clears *"3 nights below 20°F"*, so "read every digest and
 * test it" is a full-table read on the headline use case. `nightsBelow20F` and its siblings exist so
 * the deployment can **index** them and walk from the requested length upward, reading only digests
 * that can match. Four thresholds, four fields, four indexes — a slider would have made that a table
 * per degree, which is why D164 pinned them.
 *
 * ## Complete days only, and the digest says which day it is as of
 *
 * Today's row is partial from the first fetch of the morning (its un-elapsed hours are forecast), so
 * the digest is built as of the cell's newest *complete* day and carries that date. Every card prints
 * it: a filter answer is a claim about a finished window, never about right now.
 */

import {
  COLD_CHAIN_THRESHOLDS_F,
  type ColdChain,
  type ColdChainDay,
  type ColdChainThresholdF,
  coldChain,
  describeColdChain,
  isColdChainThresholdF,
  noSnowSinceChain,
  nthColdNightDayMs,
  thresholdLabel,
} from './coldChain';
import { bandForCoord, bandWithinRadius, type DriveTimeBands } from './driveTime';
import { formatRelativeTime } from './feed';
import type { FeedFilters } from './feedFilters';
import type { LatLng } from './geometry';
import { waterBodyClassLabel } from './types';
import { weatherCellFor } from './weatherCell';
import { dayMsToLocalDate, monthDayLabel } from './weatherDay';
import { bodyWeatherAnchor } from './weatherScope';

/** One threshold's chain as the digest stores it — {@link ColdChain} minus what a filter never reads. */
export interface DigestChain {
  thresholdF: ColdChainThresholdF;
  nights: number;
  startDayMs: number;
  coldNightMask: number;
  openEnded: boolean;
  snowSinceStartCm: number;
  snowUnknownDays: number;
}

/** The per-cell digest. Only **alive** chains are stored; a dead one is no chain to a filter. */
export interface WeatherCellDigest {
  /** The newest complete day the digest describes — printed on every card as "as of". */
  asOfDayMs: number;
  /** Complete days the digest saw inside its window; a thin digest is a weaker claim. */
  daysKnown: number;
  chains: DigestChain[];
  /** Flat copies of each alive chain's length, for the deployment's indexes. `0` when none. */
  nightsBelow32F: number;
  nightsBelow20F: number;
  nightsBelow10F: number;
  nightsBelow0F: number;
}

/**
 * How old a digest may be and still answer a filter, in days.
 *
 * ⚠ **A digest is never cleared, so freshness is what retires it.** The sweep stands down at the
 * season's close (D163) and the rows keep their last date — a chain that was alive *as of April*
 * would otherwise match *"3 nights below 20°F"* in July, with `status` calling the filter
 * available, and every reader would say so with a straight face. Three days survives a missed tick
 * or two; a digest older than that is no longer a claim about now, and every read — the list, the
 * map, the feed narrow, the availability gate — asks this one question.
 */
export const DIGEST_MAX_AGE_DAYS = 3;

/** The oldest `asOfDayMs` a digest may carry and still be read, for `nowMs`. */
export function digestFreshnessCutoffMs(nowMs: number): number {
  const DAY = 86_400_000;
  return Math.floor(nowMs / DAY) * DAY - DIGEST_MAX_AGE_DAYS * DAY;
}

/** Is this digest recent enough to answer a filter? See {@link DIGEST_MAX_AGE_DAYS}. */
export function digestIsFresh(
  digest: Pick<WeatherCellDigest, 'asOfDayMs'>,
  nowMs: number,
): boolean {
  return digest.asOfDayMs >= digestFreshnessCutoffMs(nowMs);
}

/** The index field a threshold's length lives in. */
export function nightsFieldFor(
  thresholdF: ColdChainThresholdF,
): 'nightsBelow32F' | 'nightsBelow20F' | 'nightsBelow10F' | 'nightsBelow0F' {
  switch (thresholdF) {
    case 32:
      return 'nightsBelow32F';
    case 20:
      return 'nightsBelow20F';
    case 10:
      return 'nightsBelow10F';
    case 0:
      return 'nightsBelow0F';
  }
}

function toDigestChain(chain: ColdChain): DigestChain | null {
  if (!chain.alive || chain.nights === 0 || chain.startDayMs === null) return null;
  return {
    thresholdF: chain.thresholdF,
    nights: chain.nights,
    startDayMs: chain.startDayMs,
    coldNightMask: chain.coldNightMask,
    openEnded: chain.openEnded,
    snowSinceStartCm: chain.snowSinceStartCm,
    snowUnknownDays: chain.snowUnknownDays,
  };
}

/**
 * Reduce a cell's complete days to its digest, as of `asOfDayMs` (the newest complete day). Days
 * newer than that are ignored — the caller may hand over today's partial row and this will not read
 * it.
 */
export function buildWeatherCellDigest(
  days: readonly ColdChainDay[],
  asOfDayMs: number,
): WeatherCellDigest {
  const digest: WeatherCellDigest = {
    asOfDayMs,
    daysKnown: days.filter((d) => d.dayMs <= asOfDayMs).length,
    chains: [],
    nightsBelow32F: 0,
    nightsBelow20F: 0,
    nightsBelow10F: 0,
    nightsBelow0F: 0,
  };
  for (const thresholdF of COLD_CHAIN_THRESHOLDS_F) {
    const stored = toDigestChain(coldChain(days, thresholdF, { asOfDayMs }));
    if (!stored) continue;
    digest.chains.push(stored);
    digest[nightsFieldFor(thresholdF)] = stored.nights;
  }
  return digest;
}

/**
 * The weather half of the shared filter row (D166) — *"at least N nights below T, and no snow
 * since"*. `minNights` ≥ 1; `noSnowSince` is the founder's second knob and off by default.
 */
export interface WeatherDiscoveryFilter {
  thresholdF: ColdChainThresholdF;
  minNights: number;
  noSnowSince?: boolean;
}

/** The most nights a filter can ask for — the digest cannot see further back than its window. */
export const WEATHER_FILTER_MAX_NIGHTS = 30;

/** Coerce an untrusted blob into a clean filter, or `undefined` when it is not one. */
export function sanitizeWeatherFilter(raw: unknown): WeatherDiscoveryFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  if (!isColdChainThresholdF(input.thresholdF)) return undefined;
  const minNights = input.minNights;
  if (
    typeof minNights !== 'number' ||
    !Number.isInteger(minNights) ||
    minNights < 1 ||
    minNights > WEATHER_FILTER_MAX_NIGHTS
  ) {
    return undefined;
  }
  const filter: WeatherDiscoveryFilter = { thresholdF: input.thresholdF, minNights };
  if (input.noSnowSince === true) filter.noSnowSince = true;
  return filter;
}

/** The matched chain plus the event the feed orders on. */
export interface WeatherMatch {
  chain: DigestChain;
  /** The day the chain reached `minNights` — the morning the lake crossed the line asked about. */
  eventDayMs: number;
}

/**
 * Does a digest satisfy the filter? Returns the matched chain and the event day, or `null`.
 *
 * *"No snow since"* is refused when any day since the chain's first night has no snow figure — an
 * unknown day must never read as "no snow fell" (D161 step 4).
 */
export function matchWeatherFilter(
  digest: Pick<WeatherCellDigest, 'chains'>,
  filter: WeatherDiscoveryFilter,
): WeatherMatch | null {
  const chain = digest.chains.find((c) => c.thresholdF === filter.thresholdF);
  if (!chain || chain.nights < filter.minNights) return null;
  if (filter.noSnowSince && !noSnowSinceChain(chain)) return null;
  const eventDayMs = nthColdNightDayMs(chain, filter.minNights);
  if (eventDayMs === null) return null;
  return { chain, eventDayMs };
}

/**
 * The instant a feed orders a body event by. A day key is UTC midnight of a local date; the night
 * ended that morning, so noon UTC (≈ 7 AM in the Northeast) is the honest point inside the day —
 * it sorts under a report skated that afternoon and above one from the evening before.
 */
export function eventInstantMs(eventDayMs: number): number {
  return eventDayMs + 12 * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The body-result card (D165)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where on the lake a match was read: the lake's own cell, or a named bay's. Served, because only the
 * join knows which cell matched — and *"3 nights below 20°F at Malletts Bay"* is a claim about
 * somewhere real where the same sentence about 170 km of Champlain would not be.
 */
export type BodyResultPlace =
  | { kind: 'body' }
  | { kind: 'subArea'; subAreaId: string; name: string };

/**
 * A body that matched the weather filter, as `weatherDiscovery.listBodyResults` returns it. The feed
 * interleaves these with report cards by `eventMs` (D165) and the map does not use them at all — it
 * dims by cell (D166).
 */
export interface BodyResultData {
  waterBodyId: string;
  name: string;
  /** `WATER_BODY_CLASSES` member, labelled by `waterBodyClassLabel`. */
  type: string;
  states?: string[];
  /** The instant the feed orders on — {@link eventInstantMs} of `eventDayMs`. */
  eventMs: number;
  /** The day the chain reached the requested length, at the matched place. */
  eventDayMs: number;
  /** The newest complete day the reading describes — printed as "as of". */
  asOfDayMs: number;
  chain: DigestChain;
  place: BodyResultPlace;
  /** Other bays of the same lake that also matched, by name. */
  otherBayNames: string[];
  /** The lake is too large for one reading and was checked at one point (PR 1's caveat). */
  oneSampleForALargeBody: boolean;
  accessKind?: string;
  /** A moderator ruled no public access (N6f); the card marks it, never hides it. */
  noPublicAccess: boolean;
  isFavorite: boolean;
}

/** Render-ready body result. `relativeTime` depends on `now`, so it is computed per render. */
export interface BodyResultView {
  waterBodyId: string;
  /** The bay when the match was read there, else the lake — the same rule as a report card. */
  locationPrimary: string;
  locationSecondary: string | null;
  /** The chain sentence — *"4 nights below 20°F, no snow since the first"*. */
  headline: string;
  /** *"as of Feb 4"* */
  asOfLabel: string;
  /** *"Also at Shelburne Bay, Burlington Bay"*, or `null`. */
  alsoAtLabel: string | null;
  /** The size caveat, or `null`. */
  caveat: string | null;
  eventMs: number;
  relativeTime: string;
  /** `subAreaId` to focus on tap, when the match was read at a bay. */
  focusSubAreaId: string | null;
  isFavorite: boolean;
  noPublicAccess: boolean;
  isHikeIn: boolean;
}

/** The "as of" line every card prints (D165): a filter answer is a claim about a finished window. */
export function asOfLabel(asOfDayMs: number): string {
  return `as of ${monthDayLabel(dayMsToLocalDate(asOfDayMs))}`;
}

/** The size caveat, word for word the panel's (PR 1), so the two surfaces cannot drift. */
export const ONE_SAMPLE_CAVEAT =
  'This lake is large enough that weather differs across it — this reading is from one point near the middle.';

/**
 * Compose the render-ready body card. Pure; `now` is injected so the relative label is deterministic
 * and stays live on the client, exactly as `buildFeedCardView` does for a report.
 */
export function buildBodyResultView(data: BodyResultData, now: number): BodyResultView {
  const headline = describeColdChain(data.chain) ?? '';
  const isBay = data.place.kind === 'subArea';
  // The bay leads when the reading is from one (the same rule as a report card on a bay); the lake
  // and its class and state follow. Absent segments are dropped rather than left as a gap.
  const secondary = [
    isBay ? data.name : null,
    waterBodyClassLabel(data.type),
    data.states && data.states.length > 0 ? data.states.join(', ') : null,
  ].filter((segment): segment is string => !!segment);
  return {
    waterBodyId: data.waterBodyId,
    locationPrimary: data.place.kind === 'subArea' ? data.place.name : data.name,
    locationSecondary: secondary.length > 0 ? secondary.join(' · ') : null,
    headline,
    asOfLabel: asOfLabel(data.asOfDayMs),
    alsoAtLabel: data.otherBayNames.length > 0 ? `Also at ${data.otherBayNames.join(', ')}` : null,
    caveat: data.oneSampleForALargeBody ? ONE_SAMPLE_CAVEAT : null,
    eventMs: data.eventMs,
    relativeTime: formatRelativeTime(data.eventMs, now),
    focusSubAreaId: data.place.kind === 'subArea' ? data.place.subAreaId : null,
    isFavorite: data.isFavorite,
    noPublicAccess: data.noPublicAccess,
    isHikeIn: data.accessKind === 'hike_in',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Interleaving body results with the paginated report feed (D165)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One row of the heterogeneous "Latest" feed. */
export type LatestItem<R> = { kind: 'report'; data: R } | { kind: 'body'; data: BodyResultData };

/**
 * Merge a bounded body-result list into the paginated report list, newest first.
 *
 * The reports paginate; the bodies do not. So a body event **older than the oldest loaded report**
 * is held back until the next page arrives — otherwise it would sort above reports it is older
 * than, simply because those reports have not loaded yet. Once the report pagination is
 * `exhausted`, every remaining body is appended in order. Both lists are assumed newest-first, as
 * their queries serve them.
 */
export function interleaveLatest<R>(
  reports: readonly R[],
  reportTime: (r: R) => number,
  bodies: readonly BodyResultData[],
  exhausted: boolean,
): LatestItem<R>[] {
  const out: LatestItem<R>[] = [];
  const oldestLoaded = reports.length > 0 ? reportTime(reports[reports.length - 1] as R) : null;
  const floor = exhausted || oldestLoaded === null ? Number.NEGATIVE_INFINITY : oldestLoaded;
  let b = 0;
  for (const r of reports) {
    const t = reportTime(r);
    while (b < bodies.length && (bodies[b] as BodyResultData).eventMs > t) {
      out.push({ kind: 'body', data: bodies[b] as BodyResultData });
      b += 1;
    }
    out.push({ kind: 'report', data: r });
  }
  for (; b < bodies.length; b++) {
    const body = bodies[b] as BodyResultData;
    if (body.eventMs < floor) break;
    out.push({ kind: 'body', data: body });
  }
  return out;
}

/**
 * The map chip's sentence (D166): the knob, the radius if set, then the date the digest is as of.
 * *"Showing lakes with 3+ nights below 20°F, no snow since · within 60 min · as of Feb 4"*. One
 * string for both clients, so a dimmed map is explained in the same words everywhere.
 */
export function describeWeatherFilter(
  filters: Pick<FeedFilters, 'weather' | 'radiusMinutes'>,
  asOfDayMs: number | null | undefined,
): string {
  const w = filters.weather;
  if (!w) return '';
  const knob = `${w.minNights}+ night${w.minNights === 1 ? '' : 's'} below ${thresholdLabel(w.thresholdF)}${w.noSnowSince ? ', no snow since' : ''}`;
  const radius =
    filters.radiusMinutes !== undefined ? ` · within ${filters.radiusMinutes} min` : '';
  const asOf = asOfDayMs ? ` · ${asOfLabel(asOfDayMs)}` : '';
  return `Showing lakes with ${knob}${radius}${asOf}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The map's dim (D166)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What the map has for each body in view — the `listInViewport` row, reduced to what the dim reads. */
export interface DimmableBody {
  _id: string;
  centroid: { lat: number; lng: number };
  interiorPoint?: { lat: number; lng: number };
  representativePoint?: { lat: number; lng: number };
}

/** `weatherDiscovery.matchedCells`, as the map receives it. */
export interface MatchedCells {
  cellKeys: readonly string[];
  bayBodyIds: readonly string[];
}

/**
 * The bodies in view that do **not** satisfy the map's narrow (weather + drive-time radius) and
 * should draw dimmed. Empty when no weather filter is active — the radius alone never dims the map,
 * as it never did before this phase; it is the weather filter that makes the map a discovery
 * surface, and the radius rides along with it (founder call 21).
 *
 * A body matches when its own filter cell matched, or it was matched through a bay. The radius is
 * tested on the centroid with the viewer's own bands, favorites exempt, exactly as the feed does —
 * a body that is a match in the feed must never be a dim on the map.
 */
export function weatherDimmedBodyIds(
  bodies: readonly DimmableBody[],
  filters: Pick<FeedFilters, 'weather' | 'radiusMinutes'>,
  matched: MatchedCells | undefined,
  viewer: { bands: DriveTimeBands; home?: LatLng | undefined; favorites: ReadonlySet<string> },
): Set<string> {
  const out = new Set<string>();
  if (!filters.weather || !matched) return out;
  const cells = new Set(matched.cellKeys);
  const viaBay = new Set(matched.bayBodyIds);
  for (const body of bodies) {
    const anchor = bodyWeatherAnchor(body);
    const cellMatched = cells.has(weatherCellFor('filter', anchor.lat, anchor.lng).key);
    if (!cellMatched && !viaBay.has(body._id)) {
      out.add(body._id);
      continue;
    }
    if (filters.radiusMinutes !== undefined && !viewer.favorites.has(body._id)) {
      const band = bandForCoord(body.centroid, viewer.bands, viewer.home);
      if (!bandWithinRadius(band, filters.radiusMinutes)) out.add(body._id);
    }
  }
  return out;
}
