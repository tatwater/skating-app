/**
 * Weather-first discovery — the reads (N6h Workstream E / **D159**, **D164**, **D165**, **D166**).
 *
 * ## The pipeline, and why each stage is where it is
 *
 * 1. **Digests, through the threshold's index.** `weatherCellDigests` carries each cell's chain
 *    length per D164 threshold as a flat field with its own index, so *"at least 3 nights below
 *    20°F"* walks `by_nights_20` from 3 upward and never reads a digest that cannot match. In a real
 *    January that is most of the table; in November it is a handful. The rest of the predicate (the
 *    snow clause, the event day) is tested in memory over what the index returned.
 * 2. **Cells, not bodies.** Matched digests are the answer to *"where"*; nothing has read a body yet.
 *    The map stops here (`matchedCells`) and dims by cell on the client (D166).
 * 3. **The drive-time band, on cell centres first.** Per-user and uncacheable, so it comes last in
 *    D159's ordering — but cheap on a cell centre, and applying it before the join is what keeps a
 *    Vermont-wide freeze from resolving 12,000 bodies for a viewer who asked for thirty minutes.
 *    A bounding box widened by a cell half-diagonal is the pre-test; the band itself is applied to
 *    each body's centroid exactly, as the feed does.
 * 4. **Bodies, newest-event-first, to a cap.** Cells are sorted by the day their chain reached the
 *    requested length and the `bodyWeatherCells` join is walked in that order until the limit is
 *    met. The read is proportional to the *page*, which is the only honest reading of D159's
 *    "proportional to the answer".
 *
 * ## No auth gate, on purpose
 *
 * `reports.listFeed` serves signed-out readers, and the discovery list is the same page. The only
 * per-user input is the viewer's own band, which is absent for a signed-out reader and simply not
 * applied — the radius knob then narrows nothing, exactly as it does for reports.
 */

import {
  type BodyResultData,
  bandForCoord,
  bandWithinRadius,
  type DriveTimeBand,
  type DriveTimeBands,
  eventInstantMs,
  matchWeatherFilter,
  sanitizeFeedFilters,
  spansMultipleSampleCells,
  WEATHER_TIER_SPECS,
  type WeatherDiscoveryFilter,
  type WeatherMatch,
} from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { getCurrentProfile } from './lib/auth';
import { isListed } from './lib/listing';
import { loadFavoriteBodyIds } from './waterBodyFavorites';

/** Body results per read. Bounded because the interleave (D165) is over a list, not a cursor. */
export const BODY_RESULT_LIMIT = 50;
const MAX_BODY_RESULT_LIMIT = 200;

/**
 * Half a filter cell's diagonal, in degrees — the margin the band's bounding box is widened by
 * before a cell centre is tested against it. A body sits anywhere inside its cell, so a centre just
 * outside the box can still own a body just inside it.
 */
const CELL_HALF_DIAGONAL_DEG = (WEATHER_TIER_SPECS.filter.cellDeg * Math.SQRT2) / 2;

type DigestRow = Doc<'weatherCellDigests'>;

/** The digests whose chain at `thresholdF` is at least `minNights` long — one index walk. */
async function digestsAtLeast(ctx: QueryCtx, filter: WeatherDiscoveryFilter): Promise<DigestRow[]> {
  const n = filter.minNights;
  switch (filter.thresholdF) {
    case 32:
      return ctx.db
        .query('weatherCellDigests')
        .withIndex('by_nights_32', (q) => q.gte('nightsBelow32F', n))
        .collect();
    case 20:
      return ctx.db
        .query('weatherCellDigests')
        .withIndex('by_nights_20', (q) => q.gte('nightsBelow20F', n))
        .collect();
    case 10:
      return ctx.db
        .query('weatherCellDigests')
        .withIndex('by_nights_10', (q) => q.gte('nightsBelow10F', n))
        .collect();
    case 0:
      return ctx.db
        .query('weatherCellDigests')
        .withIndex('by_nights_0', (q) => q.gte('nightsBelow0F', n))
        .collect();
  }
}

/** A matched cell: its digest, the match, and the event day the walk orders on. */
interface MatchedCell {
  digest: DigestRow;
  match: WeatherMatch;
}

/** Stage 1 + the in-memory half of the predicate. Newest event first. */
async function matchedCellsFor(
  ctx: QueryCtx,
  filter: WeatherDiscoveryFilter,
): Promise<MatchedCell[]> {
  const rows = await digestsAtLeast(ctx, filter);
  const out: MatchedCell[] = [];
  for (const digest of rows) {
    const match = matchWeatherFilter(digest, filter);
    if (match) out.push({ digest, match });
  }
  // Newest event first; equal days by key, so two reads of one state list in one order.
  out.sort(
    (a, b) =>
      b.match.eventDayMs - a.match.eventDayMs || a.digest.cellKey.localeCompare(b.digest.cellKey),
  );
  return out;
}

/** A simple lat/lng box — the band's extent, for the cell-centre pre-test. */
interface Box {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** The viewer's band geometry, as `bandForCoord` consumes it, plus its bounding box. */
function viewerBands(viewer: Doc<'profiles'> | null): {
  bands: DriveTimeBands;
  home: { lat: number; lng: number } | undefined;
  box: Box | null;
} {
  const bands = {
    band30: viewer?.cachedIsochrones?.band30,
    band60: viewer?.cachedIsochrones?.band60,
    outerRadiusMeters: viewer?.outerRadiusMeters,
  } as DriveTimeBands;
  const home = viewer?.homeCoord;
  // The outer band is a crow-flies radius from home, so its box is the largest of the three and
  // bounds all of them. Without a home there is no band, and the box is null: nothing passes.
  if (!home || bands.outerRadiusMeters === undefined) return { bands, home, box: null };
  const dLat = bands.outerRadiusMeters / 111_320;
  const dLng =
    bands.outerRadiusMeters / (111_320 * Math.max(0.2, Math.cos((home.lat * Math.PI) / 180)));
  return {
    bands,
    home,
    box: {
      minLat: home.lat - dLat,
      maxLat: home.lat + dLat,
      minLng: home.lng - dLng,
      maxLng: home.lng + dLng,
    },
  };
}

function inBox(lat: number, lng: number, box: Box, margin: number): boolean {
  return (
    lat >= box.minLat - margin &&
    lat <= box.maxLat + margin &&
    lng >= box.minLng - margin &&
    lng <= box.maxLng + margin
  );
}

/**
 * The cells the filter matches, for the map (D166). Returns cell keys rather than bodies: the client
 * already holds every body in its viewport and can compute a body's filter cell from its anchor
 * (the filter tier does not band by elevation, so the key is purely positional), which makes the
 * dim a set lookup per feature and this read independent of how many lakes are on screen.
 *
 * `bayBodyIds` are the lakes matched *through a bay* — a giant whose own mid-lake cell did not
 * match but whose named bay did must not draw dimmed. ~128 bays in the corpus, so this is a small
 * read over the join.
 *
 * The drive-time radius is applied on the client, from the viewer's own cached bands, for the same
 * reason: it already has them (`profiles.current`), and a per-body test there is exact where a
 * cell-centre test here is not.
 */
export const matchedCells = query({
  args: { filters: v.any() },
  handler: async (
    ctx,
    { filters: raw },
  ): Promise<{ cellKeys: string[]; bayBodyIds: Id<'waterBodies'>[]; asOfDayMs: number | null }> => {
    const filters = sanitizeFeedFilters(raw);
    if (!filters.weather) return { cellKeys: [], bayBodyIds: [], asOfDayMs: null };
    const cells = await matchedCellsFor(ctx, filters.weather);
    const keys = new Set(cells.map((c) => c.digest.cellKey));
    const bayBodyIds = new Set<Id<'waterBodies'>>();
    let asOfDayMs: number | null = null;
    for (const c of cells) {
      if (asOfDayMs === null || c.digest.asOfDayMs > asOfDayMs) asOfDayMs = c.digest.asOfDayMs;
    }
    // Bay memberships across the whole join: bounded by the number of bays in the corpus.
    const bays = await ctx.db
      .query('bodyWeatherCells')
      .withIndex('by_bay', (q) => q.eq('isBay', true))
      .collect();
    for (const row of bays) if (keys.has(row.cellKey)) bayBodyIds.add(row.waterBodyId);
    return { cellKeys: [...keys], bayBodyIds: [...bayBodyIds], asOfDayMs };
  },
});

/**
 * The bodies the filter matches, newest event first, for the feed's interleave (D165).
 *
 * `exhausted` is false when the cap stopped the walk with matched cells still unread — the client
 * then knows the list is a page, not the answer. Favorites are exempt from the radius, as they are
 * for reports (Phase 4 decision #1); nothing is exempt from the weather.
 */
export const listBodyResults = query({
  args: { filters: v.any(), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { filters: raw, limit },
  ): Promise<{ results: BodyResultData[]; exhausted: boolean; asOfDayMs: number | null }> => {
    const filters = sanitizeFeedFilters(raw);
    const weather = filters.weather;
    if (!weather) return { results: [], exhausted: true, asOfDayMs: null };
    const cap = Math.min(
      MAX_BODY_RESULT_LIMIT,
      Math.max(1, Math.floor(limit ?? BODY_RESULT_LIMIT)),
    );

    const viewer = await getCurrentProfile(ctx);
    const favorites = await loadFavoriteBodyIds(ctx, viewer?._id ?? '');
    const { bands, home, box } = viewerBands(viewer);
    const radius: DriveTimeBand | undefined = filters.radiusMinutes;

    let cells = await matchedCellsFor(ctx, weather);
    let asOfDayMs: number | null = null;
    for (const c of cells) {
      if (asOfDayMs === null || c.digest.asOfDayMs > asOfDayMs) asOfDayMs = c.digest.asOfDayMs;
    }
    // Stage 3's pre-test. A favorite outside the box is still reachable below — but only through a
    // cell inside it; a favorited lake two states away under a radius filter is the one case this
    // trades away, and it is the same trade `listFeed` makes when it paginates by time.
    if (radius !== undefined) {
      cells =
        box === null
          ? []
          : cells.filter((c) => inBox(c.digest.lat, c.digest.lng, box, CELL_HALF_DIAGONAL_DEG));
    }

    // Stage 4: bodies, newest-first, deduplicated. A lake seen again through an older cell (another
    // bay) adds that bay's name; its card keeps the newest reading, which is the one it prints.
    const byBody = new Map<string, BodyResultData>();
    const results: BodyResultData[] = [];
    const bodyCache = new Map<string, Doc<'waterBodies'> | null>();
    let exhausted = true;
    for (const cell of cells) {
      if (results.length >= cap) {
        exhausted = false;
        break;
      }
      const members = await ctx.db
        .query('bodyWeatherCells')
        .withIndex('by_cell', (q) => q.eq('cellKey', cell.digest.cellKey))
        .collect();
      for (const m of members) {
        const seen = byBody.get(m.waterBodyId);
        if (seen) {
          if (m.subAreaId) {
            const bay = await ctx.db.get(m.subAreaId);
            if (bay && bay.removedAt === undefined && !seen.otherBayNames.includes(bay.name)) {
              seen.otherBayNames.push(bay.name);
            }
          }
          continue;
        }
        if (results.length >= cap) {
          exhausted = false;
          break;
        }
        let body = bodyCache.get(m.waterBodyId);
        if (body === undefined) {
          body = await ctx.db.get(m.waterBodyId);
          bodyCache.set(m.waterBodyId, body);
        }
        if (!body || !isListed(body)) continue;
        // Unnamed water is left out of the *list*, as `viewportLakes` leaves it out of the sidebar:
        // on the map an unnamed pond is a distinct shape in a place, but a card reading only
        // "Lake or pond · NH" is not a destination anyone can pick from three of them. It still
        // draws undimmed on the map, which is where an unnamed match is legible.
        if (body.name.trim() === '') continue;
        const isFavorite = favorites.has(body._id);
        if (radius !== undefined && !isFavorite) {
          const band = bandForCoord(body.centroid, bands, home);
          if (!bandWithinRadius(band, radius)) continue;
        }
        let place: BodyResultData['place'] = { kind: 'body' };
        if (m.subAreaId) {
          const bay = await ctx.db.get(m.subAreaId);
          if (!bay || bay.removedAt !== undefined) continue;
          place = { kind: 'subArea', subAreaId: bay._id, name: bay.name };
        }
        const data: BodyResultData = {
          waterBodyId: body._id,
          name: body.name,
          type: body.type,
          ...(body.states !== undefined ? { states: body.states } : {}),
          eventMs: eventInstantMs(cell.match.eventDayMs),
          eventDayMs: cell.match.eventDayMs,
          asOfDayMs: cell.digest.asOfDayMs,
          chain: cell.match.chain,
          place,
          otherBayNames: [],
          oneSampleForALargeBody:
            place.kind === 'body' &&
            (body.weatherSamplePoints?.length ?? 0) <= 1 &&
            spansMultipleSampleCells(body.bbox),
          ...(body.accessKind !== undefined ? { accessKind: body.accessKind } : {}),
          noPublicAccess: body.publicAccess?.verdict === 'none',
          isFavorite,
        };
        byBody.set(body._id, data);
        results.push(data);
      }
    }
    return { results, exhausted, asOfDayMs };
  },
});

/**
 * Whether discovery can answer anything right now — for the filter row's disabled state (call 24).
 *
 * Out of season Tier B is empty until D163's gate opens, so the knobs render disabled with *"no
 * weather data yet this season"* rather than silently returning nothing. One `first()`: the
 * question is existence. `asOfDayMs` is that one digest's, which is the sweep's date give or take a
 * cell's timezone — good enough for a caption, not a claim.
 */
export const status = query({
  args: {},
  handler: async (ctx): Promise<{ available: boolean; asOfDayMs: number | null }> => {
    const any = await ctx.db.query('weatherCellDigests').first();
    return { available: any !== null, asOfDayMs: any?.asOfDayMs ?? null };
  },
});
