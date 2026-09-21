/**
 * The feed card and the feed's narrowing, shared by every surface that shows a Report as a card
 * (A10 §2.4 / §12): the Post feed (`posts.listFeed`), the offline read-cache
 * (`reports.recentCardsForBodies`), the recommended strip (`reports.recommended`) and the profile
 * history. One card builder so the surfaces can never drift, one narrowing so a Post and a Report
 * answer a filter the same way.
 */

import {
  bandForCoord,
  clipPathEnds,
  type DriveTimeBands,
  digestIsFresh,
  type FeedAuthor,
  type FeedCardData,
  type FeedFilters,
  iceTypeKeys,
  isFavoriteReport,
  type LatLng,
  type LngLat,
  matchesFilters,
  matchWeatherFilter,
  type PostCardData,
  PUT_IN_CLIP_M,
  reportWhereSummary,
  type Season,
  type SilhouetteData,
  sanitizeFeedFilters,
  seasonOf,
  sectorFrame,
  silhouettePath,
  silhouetteRings,
  standingOf,
  surfaceTagKeys,
  visiblePostReports,
  type WeatherDiscoveryFilter,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { subAreaDriveCoordFor } from '../subAreas';
import { loadFavorites, type ViewerFavorites } from '../waterBodyFavorites';
import { getCurrentProfile } from './auth';
import { publicAuthor } from './authorView';
import { canSeePutIn, loadBlockedAuthorIds } from './reportVisibility';
import { bodyWeatherCell, subAreaWeatherCell } from './sampling';

/** A resolved survivor body's feed-relevant fields: display name + on-water centroid (for band calc). */
export interface BodyInfo {
  name: string;
  centroid: LatLng;
  /**
   * The body's standing (A07b). The global feed shows a report on a *dormant* body (a report there is
   * what brought it back, and the drawer explains the rest) but not on a *removed* one — a
   * landowner's own skate on a taken-down pond is theirs and the pond's, not the feed's. The
   * recommended strip, which *pushes*, wants `active` only.
   */
  standing: 'active' | 'dormant' | 'removed' | 'unlisted';
  /** The body's easiest known approach (A06d/D144) — drives the feed card's Hike-In chip. */
  accessKind?: string;
  /**
   * The body's `filter`-tier weather cell (A06h / D165), for the weather narrow. Absent for a
   * dangling ref. Read off the body doc the cache already loaded, so the narrow costs no extra read
   * beyond one digest per distinct cell on the page.
   */
  filterCellKey?: string;
  /** The parent's elevation, so a report's bay can be keyed the way the registry keyed it. */
  elevationM?: number;
  /**
   * The outline at card scale and the wedge apex (A10 §12.3), once per body per page. Absent for a
   * dangling ref. Computed from the polygon the body doc already carried into this read — no extra
   * fetch — and cached with the rest, so twenty cards on one lake simplify it once.
   */
  silhouette?: Pick<SilhouetteData, 'rings' | 'bbox' | 'origin' | 'middleRadiusM'>;
}

/** Resolve a report's surviving water-body name + centroid, following `mergedIntoId` (D36); cached. */
export async function bodyInfoFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cache: Map<string, BodyInfo>,
): Promise<BodyInfo> {
  const cached = cache.get(waterBodyId);
  if (cached !== undefined) return cached;
  let body = await ctx.db.get(waterBodyId);
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId);
  }
  const info: BodyInfo = {
    name: body?.name ?? 'Unknown water body',
    standing: body ? standingOf(body).standing : 'unlisted',
    // A resolvable body always has a centroid; the fallback keeps the type total for a dangling ref.
    centroid: body?.centroid ?? { lat: 0, lng: 0 },
    // The Hike-In chip (A06d/D87). Free here — the body doc is already loaded and cached per query, so
    // a page of thirty reports over five lakes costs five reads either way.
    ...(body?.accessKind !== undefined ? { accessKind: body.accessKind } : {}),
    ...(body ? { filterCellKey: bodyWeatherCell(body, 'filter').key } : {}),
    ...(body?.elevationM !== undefined ? { elevationM: body.elevationM } : {}),
    ...(body ? { silhouette: silhouetteBaseFor(body) } : {}),
  };
  cache.set(waterBodyId, info);
  return info;
}

/** The per-body half of a card's silhouette: the simplified rings, the bbox, the apex, the middle. */
function silhouetteBaseFor(body: Doc<'waterBodies'>): BodyInfo['silhouette'] {
  const geom = body.polygon as unknown as Parameters<typeof silhouetteRings>[0];
  const { rings, bbox } = silhouetteRings(geom);
  // `sectorFrame` is what the sheet's `where` means by a sector, so the card's wedge agrees with it;
  // the interior point is honored when it is inside the water, else derived. `null` on a broken
  // outline, in which case the apex falls back to the interior point (or the shoreline centroid).
  const frame = sectorFrame(geom as never, body.interiorPoint ?? undefined);
  return {
    rings,
    bbox,
    origin: frame?.origin ?? body.interiorPoint ?? body.centroid,
    ...(frame ? { middleRadiusM: frame.middleRadiusM } : {}),
  };
}

/**
 * Resolve a report author's public attribution + cosmetic trust (D13/D50); cached per query. Carries the
 * `TrustAvatar` ring inputs — `profileImageUrl` + the derived `trustClass` (never the raw score) — so a
 * feed card can ring its author. `now` is the per-query clock threaded into the class derivation.
 */
async function authorFor(
  ctx: QueryCtx,
  authorId: Id<'profiles'>,
  cache: Map<string, FeedAuthor>,
  now: number,
): Promise<FeedAuthor> {
  const cached = cache.get(authorId);
  if (cached !== undefined) return cached;
  const author = publicAuthor(await ctx.db.get(authorId), now);
  cache.set(authorId, author);
  return author;
}

/** Per-query enrichment caches shared across a page of feed cards (body info + author attribution). */
export interface FeedCardCaches {
  bodyInfo: Map<string, BodyInfo>;
  authors: Map<string, FeedAuthor>;
  /** A named bay's ring at card scale, per bay id; `null` caches a bay that is gone (A10 §12.3). */
  bayRings?: Map<string, LngLat[] | null>;
  /** The viewer, for the put-in rule (Phase 04 #7): author and moderators see it regardless. */
  viewer?: Doc<'profiles'> | null;
}

/**
 * Does this report's lake satisfy the weather filter (A06h / D165, D166)?
 *
 * The report's own bay when it has one — a report from Malletts Bay is about Malletts Bay's cell,
 * which is not Champlain's — else the body's anchor cell, then one digest read per distinct cell on
 * the page. `undefined` when the cell has no digest: out of season, or a lake nobody has swept, and
 * `matchesFilters` treats that as not a match rather than as unknown-passes, because a weather
 * filter is a claim about the lake and a lake nobody checked cannot make it.
 */
async function weatherMatchedFor(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  body: BodyInfo,
  filter: WeatherDiscoveryFilter,
  caches: { bayCells: Map<string, string | null>; digests: Map<string, boolean> },
): Promise<boolean | undefined> {
  let cellKey = body.filterCellKey;
  if (r.subAreaId !== undefined) {
    let bayCell = caches.bayCells.get(r.subAreaId);
    if (bayCell === undefined) {
      const bay = await ctx.db.get(r.subAreaId);
      bayCell =
        bay && bay.removedAt === undefined
          ? subAreaWeatherCell(bay, { elevationM: body.elevationM }, 'filter').key
          : null;
      caches.bayCells.set(r.subAreaId, bayCell);
    }
    if (bayCell !== null) cellKey = bayCell;
  }
  if (cellKey === undefined) return undefined;
  const cached = caches.digests.get(cellKey);
  if (cached !== undefined) return cached;
  const digest = await ctx.db
    .query('weatherCellDigests')
    .withIndex('by_key', (q) => q.eq('cellKey', cellKey))
    .first();
  // Fresh or nothing — a digest the sweep stopped updating in April must not narrow a July feed.
  const matched =
    digest !== null &&
    digestIsFresh(digest, Date.now()) &&
    matchWeatherFilter(digest, filter) !== null;
  caches.digests.set(cellKey, matched);
  return matched;
}

/**
 * Shape one visible report into a `FeedCardData` — the single source of truth for the feed-card
 * payload, shared by the global `listFeed` and the offline-cache `recentCardsForBodies` so the two
 * can never drift. `blocked` de-emphasizes a blocked author but never hides the report (D3); a block
 * is not moderation.
 */
export async function toFeedCard(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  caches: FeedCardCaches,
  sets: { blocked: Set<string>; favorites: ViewerFavorites },
  now: number,
): Promise<FeedCardData> {
  const body = await bodyInfoFor(ctx, r.waterBodyId, caches.bodyInfo);
  return {
    reportId: r._id,
    waterBodyId: r.waterBodyId,
    bodyName: body.name,
    // The bay name, when the lake has one (A02/D60) — `buildFeedCardView` composes it ahead of the
    // body and the town through `formatLocationLine`, so the card can't disagree with report detail.
    ...(r.subAreaName !== undefined ? { subAreaName: r.subAreaName } : {}),
    // The list form for a two-bay skate (A09) — the names travel with the report, so this costs no
    // read; `formatLocationLine` prefers the list when it is present.
    ...(r.subAreaNames !== undefined ? { subAreaNames: r.subAreaNames } : {}),
    ...(r.place !== undefined ? { place: r.place } : {}),
    skateEndTime: r.skateEndTime,
    ...(r.skateStartTime !== undefined ? { skateStartTime: r.skateStartTime } : {}),
    // The card wants the keys; the located shape is a §12.2 read enhancement, later.
    iceTypes: iceTypeKeys(r.iceTypes),
    surfaceTags: surfaceTagKeys(r.surfaceTags),
    ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
    // The A10 axes a reader needs at a glance (§12.1): how they saw it, who it is for, and what a
    // shore observer saw. Absent means unstated, and the card says nothing.
    ...(r.suitability !== undefined ? { suitability: r.suitability } : {}),
    ...(r.observedFrom !== undefined ? { observedFrom: r.observedFrom } : {}),
    ...(r.sighting !== undefined ? { sighting: r.sighting } : {}),
    photoThumbUrls: await thumbUrlsFor(ctx, r.photoIds),
    author: await authorFor(ctx, r.authorId, caches.authors, now),
    blocked: sets.blocked.has(r.authorId),
    // A lake favorite takes the whole lake; a bay favorite takes only the reports in the bay (A09).
    isFavorite: isFavoriteReport(sets.favorites, r),
    ...(body.accessKind !== undefined ? { accessKind: body.accessKind } : {}),
    ...(body.silhouette
      ? { silhouette: await silhouetteFor(ctx, r, body.silhouette, caches) }
      : {}),
  };
}

/**
 * The per-report half of the silhouette (A10 §12.3): the put-in only when the viewer may see it
 * (Phase 04 #7 — the author and moderators always, everyone else unless withheld), the recorded
 * skate with its ends trimmed when the put-in is withheld (D58, the same clip the map applies), the
 * chips' sector, and the named bay's ring. One activity read per report that has one; one bay read
 * per distinct bay on the page.
 */
async function silhouetteFor(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  base: NonNullable<BodyInfo['silhouette']>,
  caches: FeedCardCaches,
): Promise<SilhouetteData> {
  const viewer = caches.viewer ?? null;
  const privileged = canSeePutIn(viewer, r);
  const withheld = r.showPutIn === false && !privileged;
  const out: SilhouetteData = { ...base };
  if (!withheld) out.putIn = r.point;
  if (r.activityId !== undefined) {
    const activity = await ctx.db.get(r.activityId);
    if (activity?.path?.type === 'LineString') {
      const line = activity.path as { type: 'LineString'; coordinates: number[][] };
      const path = withheld ? clipPathEnds(line, PUT_IN_CLIP_M) : line;
      if (path) out.path = silhouettePath(path.coordinates, base.bbox);
    }
  }
  const where = reportWhereSummary(r);
  if (where.sector !== undefined) out.sector = where.sector;
  if (where.subAreaId !== undefined) {
    if (!caches.bayRings) caches.bayRings = new Map();
    const bayRings = caches.bayRings;
    let ring = bayRings.get(where.subAreaId);
    if (ring === undefined) {
      const bayId = ctx.db.normalizeId('waterBodySubAreas', where.subAreaId);
      const bay = bayId ? await ctx.db.get(bayId) : null;
      ring =
        bay && bay.removedAt === undefined
          ? (silhouetteRings(bay.polygon as never).rings[0] ?? null)
          : null;
      bayRings.set(where.subAreaId, ring);
    }
    if (ring) out.bayRing = ring;
  }
  return out;
}

/** Resolve a report's photo **thumbnail** serving URLs for the feed carousel; missing files skipped. */
async function thumbUrlsFor(
  ctx: QueryCtx,
  photoIds: Doc<'reports'>['photoIds'],
): Promise<string[]> {
  // Resolve every photo concurrently — a page of reports each carrying a few photos would otherwise
  // serialize into dozens of round-trips per `listFeed` call. Missing files resolve to null, dropped.
  const urls = await Promise.all(
    photoIds.map(async (photoId) => {
      const photo = await ctx.db.get(photoId);
      if (!photo) return null;
      return ctx.storage.getUrl(photo.thumbStorageId as Id<'_storage'>);
    }),
  );
  return urls.filter((url): url is string => url !== null);
}

/**
 * Everything the feed knows about the viewer for one page: their blocks, their favorites, their
 * drive-time bands and home, the sanitized filters, the clock, and the per-page caches. Loaded once
 * per query and threaded through the narrowing and the card builder.
 */
export interface FeedViewer {
  blocked: Set<string>;
  favorites: ViewerFavorites;
  bands: DriveTimeBands;
  home: LatLng | undefined;
  filters: FeedFilters;
  now: number;
  caches: FeedCardCaches;
  weatherCaches: { bayCells: Map<string, string | null>; digests: Map<string, boolean> };
  /** The bay's own drive-time coordinate (A09 kickoff call 2); `null` caches a bay that is gone. */
  bayCoords: Map<string, LatLng | null>;
}

export async function loadFeedViewer(ctx: QueryCtx, rawFilters: unknown): Promise<FeedViewer> {
  const viewer = await getCurrentProfile(ctx);
  const viewerId = viewer?._id ?? '';
  const [blocked, favorites] = await Promise.all([
    loadBlockedAuthorIds(ctx, viewerId),
    loadFavorites(ctx, viewerId),
  ]);
  return {
    blocked,
    favorites,
    // Stored bands validate as the broad GeoJSON union, but ORS only ever writes Polygon/MultiPolygon;
    // cast to the band shape `bandForCoord` consumes (same pattern as `adminAreas` polygon reads).
    bands: {
      band30: viewer?.cachedIsochrones?.band30,
      band60: viewer?.cachedIsochrones?.band60,
      outerRadiusMeters: viewer?.outerRadiusMeters,
    } as DriveTimeBands,
    home: viewer?.homeCoord,
    filters: sanitizeFeedFilters(rawFilters),
    now: Date.now(),
    caches: { bodyInfo: new Map(), authors: new Map(), bayRings: new Map(), viewer },
    weatherCaches: { bayCells: new Map(), digests: new Map() },
    bayCoords: new Map(),
  };
}

/**
 * Does one visible Report survive the viewer's filters (Phase 04, additive; A06h weather; A09 bay
 * banding)? `matchesFilters` is include-unknown for optional attributes, distance is hard and
 * favorites are exempt; an empty `filters` matches everything. The body is passed in because the
 * caller has already resolved it for the standing check.
 */
export async function reportMatchesFeed(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  body: BodyInfo,
  viewer: FeedViewer,
): Promise<boolean> {
  const isFavorite = isFavoriteReport(viewer.favorites, r);
  let coord: LatLng = body.centroid;
  if (r.subAreaId !== undefined) {
    let bayCoord = viewer.bayCoords.get(r.subAreaId);
    if (bayCoord === undefined) {
      bayCoord = await subAreaDriveCoordFor(ctx, r.subAreaId);
      viewer.bayCoords.set(r.subAreaId, bayCoord);
    }
    if (bayCoord !== null) coord = bayCoord;
  }
  const band = bandForCoord(coord, viewer.bands, viewer.home);
  // The weather narrow (D165): resolved here, applied inside `matchesFilters` with the rest.
  const weatherMatched =
    viewer.filters.weather === undefined
      ? undefined
      : await weatherMatchedFor(ctx, r, body, viewer.filters.weather, viewer.weatherCaches);
  return matchesFilters(
    {
      skateEndTime: r.skateEndTime,
      ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
      iceTypes: iceTypeKeys(r.iceTypes),
      surfaceTags: surfaceTagKeys(r.surfaceTags),
      ...(r.iceThickness !== undefined ? { iceThickness: r.iceThickness } : {}),
    },
    viewer.filters,
    {
      band,
      isFavorite,
      now: viewer.now,
      ...(weatherMatched !== undefined ? { weatherMatched } : {}),
    },
  );
}

/**
 * Which season the feed serves when nobody asked for one: **this season, or the newest one that has a
 * Post in it** (D63, kickoff decision 3).
 *
 * Season-scoping the feed the way the lake list is scoped would empty the home screen on July 1 and
 * leave it empty until first ice — five months, not a July curiosity. The plain fix ("if the current
 * season is empty, show the previous one") is subtly wrong for a longer gap and needs a probe read to
 * decide. This is one read that answers both: the newest visible Post in the app. If it's from this
 * season, that's what we serve; if the app has been asleep since March, we serve March's season rather
 * than an empty one behind it.
 *
 * **Stable across a paginated scroll**, which is what makes this safe to compute per page: it depends
 * only on the newest Post in the app, not on the page being read. The one thing that changes it is
 * the *first* Post of a new season landing mid-scroll, which reactively re-answers the feed to the
 * live season — the correct outcome for the one moment a year it can happen.
 */
export async function servedFeedSeason(ctx: QueryCtx, current: Season): Promise<Season> {
  const newest = await ctx.db
    .query('posts')
    .withIndex('by_moderation_and_latest_skate_end_time', (q) =>
      q.eq('moderationStatus', 'visible'),
    )
    .order('desc')
    .first();
  if (!newest) return current;
  // Clamped to the current season because `SKATE_TIME_FUTURE_TOLERANCE_MS` allows an hour of overhang:
  // within an hour of July 1 the newest Post can legitimately be *next* season's, and serving a
  // season that hasn't started would hide everything anyone skated in the one that has.
  return Math.min(seasonOf(newest.latestSkateEndTime), current);
}

/**
 * One Post as the feed shows it, or `null` when the viewer would see nothing under the header: the
 * members a moderator hid are not shown and not counted (`visiblePostReports`); the members the
 * viewer's filters hid are not shown and *are* counted; a body a takedown removed (A07b) drops its
 * Report the way the report feed always did. Shared by the feed and the profile history.
 */
export async function toPostCard(
  ctx: QueryCtx,
  post: Doc<'posts'>,
  viewer: FeedViewer,
): Promise<PostCardData | null> {
  const members: Doc<'reports'>[] = [];
  for (const id of post.reportIds) {
    const member = await ctx.db.get(id);
    if (member) members.push(member);
  }
  const reports = [];
  let omittedCount = 0;
  for (const r of visiblePostReports(post, members)) {
    const body = await bodyInfoFor(ctx, r.waterBodyId, viewer.caches.bodyInfo);
    // A takedown reaches the feed (A07b) — see `BodyInfo.standing`.
    if (body.standing === 'removed') continue;
    if (!(await reportMatchesFeed(ctx, r, body, viewer))) {
      omittedCount++;
      continue;
    }
    reports.push(
      await toFeedCard(
        ctx,
        r,
        viewer.caches,
        { blocked: viewer.blocked, favorites: viewer.favorites },
        viewer.now,
      ),
    );
  }
  const first = reports[0];
  if (!first) return null;
  return {
    postId: post._id,
    ...(post.title !== undefined ? { title: post.title } : {}),
    ...(post.body !== undefined ? { body: post.body } : {}),
    latestSkateEndTime: post.latestSkateEndTime,
    author: first.author,
    blocked: first.blocked,
    isFavorite: reports.some((r) => r.isFavorite === true),
    reports,
    omittedCount,
  };
}
