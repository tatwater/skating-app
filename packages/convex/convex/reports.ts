/**
 * Report functions (the core read/write loop, D3/D13/D22–D25/D41).
 *
 * The validation + normalization contract lives in `@skating/core` `validateReportInput` and is
 * **re-enforced here** at the trust boundary (D37) — the client runs the same check before submit,
 * but the server never trusts it. **All reports are public (D13)** — there is no visibility field;
 * minors can't post at all (D41). Reads gate on **moderation only** — a block never hides a report
 * (D3, safety-first); the block set instead annotates a blocked author's line (a Phase-03 "Blocked"
 * chip, Workstream 2/C) and hides comments/profiles, never a report.
 */

import {
  type ChipInput,
  type FeedCardData,
  type IceType,
  iceTypeKeys,
  isFormRoundTripOf,
  locatedSubAreaIds,
  memberSubAreaIds,
  RECOMMENDED_MIN_PHOTOS,
  RECOMMENDED_RECENCY_HOURS,
  type RecommendableReport,
  resolveSeason,
  type Season,
  type SurfaceTag,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
  seasonsBetween,
  selectRecommended,
  type TrustClass,
  toLocatedChip,
  validateReportInput,
} from '@skating/core';
import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import { resolvePlaceForCoord } from './adminAreas';
import { getCurrentProfile, requireContributor, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { recomputeBodySummary } from './lib/bodySummary';
import { type BodyInfo, bodyInfoFor, type FeedCardCaches, toFeedCard } from './lib/feedCards';
import { assertOwnedPhotos, syncReportPhotoLinks } from './lib/photoAccess';
import { refreshPostLatestSkateEnd, syncPostPhotos } from './lib/postSync';
import { syncReportSubAreas } from './lib/reportSubAreas';
import { getViewableReport, loadBlockedAuthorIds, redactPutIn } from './lib/reportVisibility';
import {
  assertLocatedSubAreas,
  assertPutInOfBody,
  createPost,
  editPostWords,
  inlineReportArgs,
  postWordsArgs,
  reportContent,
  toReportInput,
} from './lib/reportWrite';
import { trustClassFor } from './lib/reputation';
import { recordRevision, reportSnapshotOf } from './lib/revisions';
import { authorRemoveReport } from './moderation';
import { resolveReportSubAreas, stampCandidates } from './subAreas';
import { loadFavorites, type ViewerFavorites } from './waterBodyFavorites';

/**
 * Create a report — as the one-Report Post it always is now (A10 / D186). The pre-sheet forms on
 * both surfaces and the queue's pre-A10 drafts call this; the sheet calls `posts.create` with its
 * Reports inline. Same path, same rules (`lib/reportWrite.ts`): the Post-level key and the
 * Report's key are the one key this caller has, and the return stays the report id.
 */
export const create = mutation({
  args: inlineReportArgs,
  handler: async (ctx, args) => {
    // The pre-A10-2 replay rule, kept for the Reports that predate it (Phase 02a §6.2 / D30): a
    // Report written before every create went through a Post carries its key on the *row* and none
    // on the Post the backfill gave it, so `createPost`'s Post-key lookup misses and the per-Report
    // check would refuse the retry as a second Post claiming the Report — a lost-ack flush from
    // before the deploy would park for ever instead of returning the Report it already made.
    // Author-scoped like every other short-circuit; a stranger's key is still a conflict, below.
    if (args.idempotencyKey !== undefined) {
      const profile = await requireContributor(ctx);
      const existing = await ctx.db
        .query('reports')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
        .unique();
      if (existing && existing.authorId === profile._id) return existing._id;
    }
    const { reportIds } = await createPost(ctx, {
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      reports: [args],
    });
    const reportId = reportIds[0];
    if (reportId === undefined) throw new Error('createPost returned no report');
    return reportId;
  },
});

/**
 * A water body's report feed — newest **skate-end time** first (D28), **paginated** for infinite
 * scroll so a popular lake's history never `.collect()`s an unbounded set. All reports are public
 * (D13) and a block never hides a report (D3), so the filter is moderation-only (excludes
 * hidden/removed, D32) — applied *in* the index (`moderationStatus: 'visible'`) so a page is never
 * emptied by the gate. The blocked-author "Blocked"-chip annotation is layered on in the client.
 *
 * **Scoped to one season (D63/A05a), defaulting to this one.** The bound rides the index's own range
 * field, so this is a *narrower* read than it used to be rather than the same read with rows dropped —
 * seasonal visibility costs nothing and refunds something. Hiding is not unreachability: a report from
 * a past season still resolves by permalink through `get`, labeled with the season it belongs to.
 */
export const listByWaterBody = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    /**
     * Narrow to one named bay (A02 / D60) — the lake page's sub-area filter.
     *
     * Served by `by_sub_area_moderation_and_skate_end_time`, the same index the bounty gate uses, so
     * this is a *narrower* read rather than the same read with rows dropped after: on Champlain,
     * paginating the whole lake and filtering to Malletts Bay in JS would hand back short pages (or
     * empty ones) while still paying for every report on 200 km of ice. The moderation gate stays
     * inside the index for the reason its body-scoped sibling documents.
     */
    subAreaId: v.optional(v.id('waterBodySubAreas')),
    /**
     * Which season to list (D63) — the calendar year it starts in, `2024` being `'24/'25`. Absent ⇒
     * **this** season, which is the map's and the list's only default state.
     *
     * Bounded on **both** sides even for the current season. `SKATE_TIME_FUTURE_TOLERANCE_MS` lets a
     * report be filed up to an hour ahead, so within an hour of the boundary a report can legitimately
     * carry next season's `skateEndTime` — and it belongs to next season, by the only definition of
     * season there is. A lower-bound-only range would show it in June.
     */
    season: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { waterBodyId, subAreaId, season, paginationOpts }) => {
    const viewer = await getCurrentProfile(ctx);
    // `v.number()` admits `NaN` and `1e15`; both become index bounds that match nothing, so an empty
    // lake would be the answer to a malformed question. `resolveSeason` lands those on the same
    // default as no argument at all.
    const target: Season = resolveSeason(season, seasonOf(Date.now()));
    const from = seasonStartMs(target);
    const to = seasonEndMs(target);
    if (subAreaId !== undefined) {
      // The bay index is keyed by sub-area alone, so `waterBodyId` contributes nothing to that read —
      // which is exactly what makes an unvalidated pair a cross-lake leak: ask for Lake Morey while
      // naming a Champlain bay and the page hands back Champlain's reports under Morey's header. Both
      // clients only offer bays that came from `listForBody` for the body on screen, but that's a UI
      // courtesy, not an authority (§7c) — the pairing is decided here.
      //
      // Checked against the **survivor** (D36): a merge repoints the loser's bays onto the survivor
      // (`repointSubAreasOnMerge`), so a link still naming the merged-away body is a legitimate pair
      // and shouldn't 400 someone's bookmark.
      //
      // A *delisted* bay is deliberately still filterable, unlike `bounties.create`, which rejects
      // one: a bounty on an invisible bay is unfulfillable, whereas a bay's reports are the lake's
      // reports either way — nothing is exposed by narrowing to them, and erroring a feed mid-scroll
      // because a moderator delisted the bay is worse than serving it until the client's own bay list
      // catches up and drops the filter.
      const survivor = await resolveSurvivor(ctx, waterBodyId);
      const subArea = await ctx.db.get(subAreaId);
      if (!survivor || !subArea || subArea.waterBodyId !== survivor._id) {
        throw new ConvexError('That sub-area is not on this water body');
      }
      // Off the `reportSubAreas` join since A09: a report can be a member of two bays (the two-bay
      // skate), and a per-report index could only ever find it under one. The join carries the
      // moderation gate and the skate time as mirrors precisely so this read stays *in* the index;
      // the page is then hydrated one `get` per row, bounded by the page size.
      const joined = await ctx.db
        .query('reportSubAreas')
        .withIndex('by_sub_area_moderation_skate_end', (q) =>
          q
            .eq('subAreaId', subAreaId)
            .eq('moderationStatus', 'visible')
            .gte('skateEndTime', from)
            .lt('skateEndTime', to),
        )
        .order('desc')
        .paginate(paginationOpts);
      const page: Doc<'reports'>[] = [];
      for (const row of joined.page) {
        const report = await ctx.db.get(row.reportId);
        // A mirror that has fallen behind the row it mirrors is the only way to reach here; the
        // report's own status is the authority, so it is re-checked rather than trusted.
        if (report && report.moderationStatus === 'visible') {
          page.push(await redactPutIn(ctx, report, viewer));
        }
      }
      return { ...joined, page };
    }
    const result = await ctx.db
      .query('reports')
      .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
        q
          .eq('waterBodyId', waterBodyId)
          .eq('moderationStatus', 'visible')
          .gte('skateEndTime', from)
          .lt('skateEndTime', to),
      )
      .order('desc')
      .paginate(paginationOpts);
    // Served docs honor the put-in opt-out (`redactPutIn`); the rows themselves are untouched.
    return {
      ...result,
      page: await Promise.all(result.page.map((r) => redactPutIn(ctx, r, viewer))),
    };
  },
});

/**
 * A single report for its detail view — moderation-checked (hidden/removed excluded, D32).
 *
 * **Deliberately not season-scoped** (A05a design review). Hiding governs the default view, not
 * reachability: someone may hold a link, a bookmark or an old notification, and a 404 on a URL that
 * used to work is a worse lie than an old report clearly marked old. The client derives the label from
 * `skateEndTime` with `seasonOf`, so there is nothing to keep in sync here.
 */
export const get = query({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await getViewableReport(ctx, reportId);
    if (report === null) return null;
    // The bays the chips and readings name (A10 / D193), as names — a `where` is stored by id and
    // the detail says "north end of Malletts Bay", never the id. A bay that is gone is left out.
    const bayNames: Record<string, string> = {};
    for (const id of locatedSubAreaIds(report)) {
      const bayId = ctx.db.normalizeId('waterBodySubAreas', id);
      const bay = bayId ? await ctx.db.get(bayId) : null;
      if (bay && bay.removedAt === undefined) bayNames[id] = bay.name;
    }
    // The put-in opt-out is honored at the API, not left to the drawer (`redactPutIn`).
    return { ...(await redactPutIn(ctx, report, await getCurrentProfile(ctx))), bayNames };
  },
});

/**
 * The seasons a water body has anything to show — the season selector's option list, newest first.
 *
 * **One read.** The oldest visible report on the body, taken *ascending* off the index the lake page
 * already uses, and every season from there to now. A "which seasons actually have data" query would
 * be a scan of the body's whole history for a control that has to render instantly, and the answer
 * would be barely different: a season with nothing in it lands on the same empty state as a lake that
 * was quiet that winter, which is the honest thing to show either way.
 *
 * Reports, not hazards, because reports are what a lake overwhelmingly has more of — a body whose only
 * '23/'24 artifact is a hazard offers one season too few, which is a missing menu entry rather than
 * missing data (the hazard is still reachable from a season that *is* offered, by permalink, and from
 * the admin promotion list).
 */
export const seasonsForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<{ seasons: Season[]; current: Season }> => {
    const now = Date.now();
    const current = seasonOf(now);
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return { seasons: [current], current };
    const oldest = await ctx.db
      .query('reports')
      .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
        q.eq('waterBodyId', body._id).eq('moderationStatus', 'visible'),
      )
      .order('asc')
      .first();
    // Clamped to `now` for the same reason `servedFeedSeason` clamps: an hour of allowed future skate
    // time must never put a season that hasn't started into the menu.
    return { seasons: seasonsBetween(Math.min(oldest?.skateEndTime ?? now, now), now), current };
  },
});

/** Offline read-cache bounds (decision #8): the freshest few reports per body, within a recent window. */
const OFFLINE_CACHE_MAX_PER_BODY = 5;
const OFFLINE_CACHE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h

/**
 * Recent reports for a set of bodies as ready-to-cache `FeedCardData` (Phase 04, decision #8) — the
 * data the mobile offline read-cache stores so an **opened lake** and the viewer's **favorites** read
 * back on the ice with no signal. Per body: the freshest ≤5 visible reports within the last 72h
 * (whichever bound is smaller), enriched identically to the feed via `toFeedCard`. Empty ids → empty.
 */
export const recentCardsForBodies = query({
  args: { waterBodyIds: v.array(v.id('waterBodies')) },
  handler: async (ctx, { waterBodyIds }) => {
    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const [blocked, favorites] = await Promise.all([
      loadBlockedAuthorIds(ctx, viewerId),
      loadFavorites(ctx, viewerId),
    ]);
    const now = Date.now();
    // The season bound only ever *tightens* the 72h window, and only for the few days after July 1 —
    // but on exactly those days it's the difference between a phone that went offline in June coming
    // back with last season's ice on it and coming back honest. Whichever bound is later wins.
    const cutoff = Math.max(now - OFFLINE_CACHE_WINDOW_MS, seasonStartMs(seasonOf(now)));
    const caches: FeedCardCaches = { bodyInfo: new Map(), authors: new Map(), viewer };
    const cards: FeedCardData[] = [];
    for (const waterBodyId of [...new Set(waterBodyIds)]) {
      const recent = await ctx.db
        .query('reports')
        .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
          q
            .eq('waterBodyId', waterBodyId)
            .eq('moderationStatus', 'visible')
            .gte('skateEndTime', cutoff),
        )
        .order('desc')
        .take(OFFLINE_CACHE_MAX_PER_BODY);
      for (const r of recent) {
        cards.push(await toFeedCard(ctx, r, caches, { blocked, favorites }, now));
      }
    }
    return cards;
  },
});

/**
 * Hard ceiling on the recommended candidate scan. The 48h recency floor already bounds the window in the
 * index; this caps the pathological busy-window case so the read stays well under Convex's per-query
 * limits (the `listInViewport` read-cap lesson, PRs #10/#11). Newest-first `.take()`, so a truncation only
 * ever drops the *oldest* in-window reports — the least likely to be the freshest exceptional ice.
 */
const RECOMMENDED_SCAN_CAP = 500;

/**
 * The **recommended** filter-breaking feed (decisions 13–15) — a *separate* query the client interleaves
 * near the top of `listFeed`, never spliced into the paginated stream (decision 13). Returns 0–2 visually
 * distinct cards of *exceptional, corroborated* ice that a viewer's own distance/quality/thickness filters
 * would hide — gated on trust + corroboration, never a lone great report (D3), so we never amplify one
 * unverified claim into a wasted trip.
 *
 * The pure bar + bundling/cap live in `@skating/core` (`selectRecommended`); this query only assembles the
 * candidate bag and hydrates the winners. Cheap doc-level gates (recency floor, `great`, black ice, ≥
 * `RECOMMENDED_MIN_PHOTOS` photos) filter first; only survivors pay for the author-trust lookup and the
 * corroboration tally (`report_corroborated` rows on the `by_ref` index). Blocks + moderation are honored
 * (never broken): non-visible reports are excluded in-index and a blocked author's report is dropped here.
 *
 * **Caps (decision 15):** stateless for Phase 06 — `selectRecommended` bundles the top reports per body and
 * caps at `RECOMMENDED_MAX_BODIES_PER_DAY` unique bodies *per fetch*. A qualifying report is vanishingly
 * rare (all gates at once), so a flood can't occur at alpha volume. The server-tracked cross-fetch/day
 * dedup + hard per-day cap (a per-user impressions store + an ack mutation) is a logged fast-follow —
 * built when the feature proves it fires often enough to need pacing.
 */
export const recommended = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getCurrentProfile(ctx);
    // A personalized filter-breaker — no viewer, no "outside *your* usual range". Signed-out feed is plain.
    if (!viewer) return [];
    const now = Date.now();
    const cutoff = now - RECOMMENDED_RECENCY_HOURS * 60 * 60 * 1000;
    const blocked = await loadBlockedAuthorIds(ctx, viewer._id);

    // Recent visible reports, **newest first** and hard-capped — the recency floor bounds the window in
    // the index, but a busy 48h across every lake could still be large, so we `.take()` a ceiling rather
    // than an unbounded `.collect()` (the same read-cap discipline as `bounties.listOpen`; a qualifying
    // report is rare, so the freshest slice never omits a real candidate at alpha). Truncation is logged.
    const recent = await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', cutoff),
      )
      .order('desc')
      .take(RECOMMENDED_SCAN_CAP);
    if (recent.length === RECOMMENDED_SCAN_CAP) {
      console.warn(
        `reports.recommended hit the ${RECOMMENDED_SCAN_CAP}-row scan cap; older in-window candidates may be omitted.`,
      );
    }

    const recentById = new Map<string, Doc<'reports'>>();
    const candidates: RecommendableReport[] = [];
    const authorTrust = new Map<string, TrustClass | null>();
    const recommendedBodies = new Map<string, BodyInfo>();
    for (const r of recent) {
      recentById.set(r._id, r);
      // Cheap mandatory gates first (each also re-checked by `isRecommendable`): never break blocks (D3),
      // then the exact quality / ice / photo bar — so we only pay for trust + corroboration on survivors.
      if (blocked.has(r.authorId)) continue;
      if (r.skateQuality !== 'great') continue;
      if (!iceTypeKeys(r.iceTypes).includes('black_ice')) continue;
      if (r.photoIds.length < RECOMMENDED_MIN_PHOTOS) continue;
      // The strip *recommends* a lake, so the lake has to be one we push (A07b). Cached per body
      // for the page, like the feed's own lookup.
      const bodyInfo = await bodyInfoFor(ctx, r.waterBodyId, recommendedBodies);
      if (bodyInfo.standing !== 'active') continue;

      let trust = authorTrust.get(r.authorId);
      if (trust === undefined) {
        const author = await ctx.db.get(r.authorId);
        trust = author ? trustClassFor(author, now) : null;
        authorTrust.set(r.authorId, trust);
      }

      // Corroborators for this report = `report_corroborated` ledger rows keyed to it (by_ref).
      const refEvents = await ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', r._id))
        .collect();
      const corroborationCount = refEvents.filter((e) => e.reason === 'report_corroborated').length;

      candidates.push({
        reportId: r._id,
        waterBodyId: r.waterBodyId,
        skateEndTime: r.skateEndTime,
        ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
        // The located chips, so the bar can ask whether black ice was claimed of the lake (§12.2).
        iceTypes: r.iceTypes,
        photoCount: r.photoIds.length,
        corroborationCount,
        authorTrust: trust,
      });
    }

    // Pure selection: filter to the exceptional bar, bundle top reports per body, cap unique bodies.
    const cards = selectRecommended(candidates, { now });

    // Hydrate each winning report into a full `FeedCardData` so the client renders it like a feed card
    // (author ring, chips, thumbnails) inside the distinct "Recommended" wrapper. Reuses `toFeedCard`.
    const caches: FeedCardCaches = { bodyInfo: new Map(), authors: new Map(), viewer };
    // Recommended breaks filters; the favorite boost is irrelevant here.
    const noFavorites: ViewerFavorites = { bodyIds: new Set(), subAreaIds: new Set() };
    const result: { waterBodyId: string; cards: FeedCardData[] }[] = [];
    for (const card of cards) {
      const cardData: FeedCardData[] = [];
      for (const reportId of card.reportIds) {
        const r = recentById.get(reportId);
        if (r)
          cardData.push(await toFeedCard(ctx, r, caches, { blocked, favorites: noFavorites }, now));
      }
      if (cardData.length > 0) result.push({ waterBodyId: card.waterBodyId, cards: cardData });
    }
    return result;
  },
});

/**
 * Author-only edit (D25): last-write-wins over the content fields + a fresh `updatedAt`. Re-runs the
 * full `@skating/core` contract. The target water body isn't editable here; an unprovided put-in pin
 * preserves the existing `point` rather than silently clearing it.
 */
export const update = mutation({
  args: {
    reportId: v.id('reports'),
    ...reportContent,
    /**
     * The words of the Post this Report belongs to, edited in the same transaction (A10-3): the
     * sheet's *Save changes* is one edit, so a refusal of either half — a Post taken down since,
     * a title past its bound — lands neither, and the history never holds half of it.
     */
    post: v.optional(postWordsArgs),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const existing = await ctx.db.get(args.reportId);
    if (!existing) throw new ConvexError('Report not found');
    if (existing.authorId !== profile._id)
      throw new ConvexError('Only the author can edit a report');
    // Don't let an author keep editing content a moderator has taken down (hidden/removed, D32) —
    // the edit path doesn't touch `moderationStatus`, so re-appearing it would require re-moderation.
    if (existing.moderationStatus !== 'visible')
      throw new ConvexError('This report has been moderated and can no longer be edited');

    const now = Date.now();
    const result = validateReportInput(toReportInput(args, existing.waterBodyId), { now });
    if (!result.ok) {
      throw new ConvexError({
        code: 'invalid_report',
        errors: result.errors.map((e) => `${e.field}: ${e.message}`),
      });
    }
    const n = result.normalized;

    const photoIds = [...new Set(args.photoIds ?? existing.photoIds)];
    await assertOwnedPhotos(ctx, photoIds, profile._id, { reportId: args.reportId });

    // Re-resolve the point-derived place (Phase 05) from the final point — an edited put-in pin moves
    // the location label with it. `place` is cleared to undefined when the new point resolves nowhere.
    const point = n.point ?? existing.point;
    const place = await resolvePlaceForCoord(ctx, point);
    // Moving the put-in pin can move the report into (or out of) a bay, so the membership is
    // re-resolved alongside `place` — through the same rule as create, so an activity-sourced
    // report keeps its track's list rather than collapsing to the pin's bay on its first edit.
    // Cleared to undefined when the new point sits in none.
    const body = await ctx.db.get(existing.waterBodyId);
    const candidates = await stampCandidates(ctx, existing.waterBodyId);
    assertLocatedSubAreas(n, candidates);
    const putInId = await assertPutInOfBody(ctx, n.putInId, existing.waterBodyId);
    const subAreas = await resolveReportSubAreas(
      ctx,
      {
        waterBodyId: existing.waterBodyId,
        point,
        ...(existing.activityId !== undefined ? { activityId: existing.activityId } : {}),
      },
      candidates,
      body?.polygon as unknown as Polygon | MultiPolygon,
    );

    // The Post's words, when the edit carries them — through the same helper as `posts.update`,
    // inside this transaction, so a refusal there rolls back the Report's half too.
    if (args.post !== undefined) {
      if (existing.postId === undefined) throw new ConvexError('This report has no post to edit');
      await editPostWords(ctx, existing.postId, args.post, profile, now);
    }

    // What it said before this edit, for a moderator (A10-3) — written before the patch, in the
    // same transaction, so the history and the row can never disagree about the order of events.
    await recordRevision(
      ctx,
      { targetType: 'report', targetId: args.reportId, snapshot: reportSnapshotOf(existing) },
      profile._id,
      now,
    );

    await ctx.db.patch(args.reportId, {
      point,
      // Last-write-wins like the pin it names: the sheet re-sends the put-in it shows, and clearing
      // the put-in is an edit like any other.
      putInId,
      skateEndTime: n.skateEndTime,
      skateStartTime: n.skateStartTime,
      place,
      subAreaId: subAreas.subAreaId,
      subAreaName: subAreas.subAreaName,
      subAreaIds: subAreas.subAreaIds,
      subAreaNames: subAreas.subAreaNames,
      skateEndPrecision: n.skateEndPrecision,
      observedFrom: n.observedFrom,
      sighting: n.sighting,
      iceTypes: n.iceTypes,
      surfaceTags: n.surfaceTags,
      skateQuality: n.skateQuality,
      suitability: n.suitability,
      iceThickness: n.iceThickness,
      snow: n.snow,
      conditions: mergeEditedConditions(existing.conditions, n.conditions),
      notes: n.notes,
      // Last-write-wins like every other content field, not "keep unless sent": the form only ever
      // sends the opt-out (`buildReportInput` omits `showPutIn` when shown), so preserving the stored
      // value on absence would make hidden → shown an edit that silently never lands.
      showPutIn: args.showPutIn,
      photoIds,
      // Distinct from `updatedAt` on purpose (A06f). `updatedAt` moves for reasons the author had
      // nothing to do with — the conditions autofill backfills the weather hours later — so a byline
      // reading "edited" off it would accuse people of edits they never made. This moves only here.
      editedAt: now,
      updatedAt: now,
    });
    // The list is replaced wholesale, so the back-links follow it both ways (A10 / D186), and the
    // Post's album is the union over its members, so it follows too.
    await syncReportPhotoLinks(ctx, args.reportId, existing.photoIds, photoIds);
    if (existing.postId !== undefined) {
      await syncPostPhotos(ctx, existing.postId, { reportId: args.reportId, photoIds });
    }
    // The join mirrors both things this edit can move — the membership and the skate time (A09).
    await syncReportSubAreas(
      ctx,
      {
        _id: args.reportId,
        waterBodyId: existing.waterBodyId,
        moderationStatus: existing.moderationStatus,
        skateEndTime: n.skateEndTime,
      },
      memberSubAreaIds(subAreas),
    );
    // And the Post's sort key (A10 / D186): `latestSkateEndTime` is the max over its Reports, so
    // re-dating this one can move the Post in the feed. Absent only on a Report the backfill has
    // not yet reached.
    if (existing.postId !== undefined && n.skateEndTime !== existing.skateEndTime) {
      await refreshPostLatestSkateEnd(ctx, existing.postId, {
        reportId: args.reportId,
        skateEndTime: n.skateEndTime,
      });
    }

    // **An edit changes the card's inputs, so the card is recomputed (A06c §5).** `skateEndTime` and
    // `skateQuality` are both patched above and both feed the summary directly: re-dating a report
    // can move it in or out of the 14-day window, and re-rating it moves the D86 mean. Without this
    // the card would be wrong until the six-hourly sweep — and the module doc for
    // `lib/bodySummary.ts` claims the write paths are "exact by construction rather than
    // exact-until-a-path-is-missed", which was untrue for exactly this path.
    //
    // The body cannot change here (`update` reads `existing.waterBodyId` and never takes one), so
    // there is a single card to refresh rather than an old one and a new one.
    await recomputeBodySummary(ctx, existing.waterBodyId);
    return args.reportId;
  },
});

/**
 * An author deleting their own Report (A10-3). Soft: the row stays, `removed`, with an
 * `author_delete` audit row; the Post goes with its last member (D186). A Report a moderator has
 * already removed is left to them; a hidden one may still be deleted by its author — it is theirs.
 */
export const remove = mutation({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db.get(reportId);
    if (!existing) throw new ConvexError('Report not found');
    if (existing.authorId !== profile._id)
      throw new ConvexError('Only the author can delete a report');
    await authorRemoveReport(ctx, existing, profile, Date.now());
    return reportId;
  },
});

/**
 * Merge an edited conditions block over the stored one, keeping both the measurement and its
 * provenance where the author didn't actually touch the weather.
 *
 * **The bug this fixes is silent and one-directional.** A report's conditions are often filled in by
 * `internal.conditions.autofillConditions` from Open-Meteo, stamped `source: 'openmeteo'`. The edit
 * form has no slot for provenance and `buildReportInput` stamps everything it emits `source: 'user'`
 * — so an author fixing a typo in their notes would re-mark the *weather* as personally observed,
 * turning a model's number into a human's claim with nobody deciding that.
 *
 * The comparison is on the values, not on a dirty flag the client could get wrong: if every weather
 * figure came back identical, nothing about the weather was edited, whatever else was. Change one and
 * the block becomes the author's, which is the honest reading of someone typing over it.
 *
 * ⚠ **It asks whether the number came back off the form untouched, not whether it is close.** The
 * two are stored in precise metric and edited in whole °F / whole mph, so an untouched −3.4 °C comes
 * back as −3.33; a bare `stored === next` would call every edit a weather edit and defeat the whole
 * function. `isFormRoundTripOf` predicts the form's exact arithmetic instead of allowing a tolerance
 * — deliberately, because the inputs take decimals and a tolerance would swallow a real 0.4° edit.
 * The stored number is then kept verbatim for each field that survived, so a round-trip can't nudge a
 * measurement the author never opened.
 *
 * Only ever *downgrades* toward the stored source, so it cannot launder a user's number into an
 * observation.
 */
function mergeEditedConditions(
  stored: Doc<'reports'>['conditions'],
  next: Doc<'reports'>['conditions'],
): Doc<'reports'>['conditions'] {
  if (!stored || !next) return next;
  const sameTemp = isFormRoundTripOf('airTempC', stored.airTempC, next.airTempC);
  const sameWind = isFormRoundTripOf('windSpeedKph', stored.windSpeedKph, next.windSpeedKph);
  // Undo the rounding drift field by field, independently of the source decision below: a value the
  // author couldn't have changed shouldn't move, even on an edit that *did* touch the rest of the block.
  const merged = {
    ...next,
    ...(sameTemp && stored.airTempC !== undefined ? { airTempC: stored.airTempC } : {}),
    ...(sameWind && stored.windSpeedKph !== undefined ? { windSpeedKph: stored.windSpeedKph } : {}),
  };
  if (stored.source === next.source) return merged;
  const unchanged =
    sameTemp &&
    sameWind &&
    stored.windDir === next.windDir &&
    stored.sky === next.sky &&
    stored.precip === next.precip;
  return unchanged ? { ...merged, source: stored.source } : merged;
}

/**
 * One-time migration (Phase 05): copy each report's legacy `skateTime` → `skateEndTime`, drop the old
 * field, and stamp the point-derived `place` (against the imported `adminAreas`). A field **rename**
 * isn't migration-free, so run this via the Phase-03 strict-schema dance on a deployment with data:
 * temporarily `schemaValidation: false` → push → `pnpm exec convex run reports:renameSkateTimeToSkateEndTime`
 * → revert → redeploy strict. Run it **after** the `adminAreas` import so `place` resolves. Idempotent:
 * a report already carrying `skateEndTime` keeps it, and re-running only backfills a still-missing
 * `place`. Dev has a handful of test reports; prod is uninitialized. `collect()` suits that scale — a
 * large corpus would need pagination.
 */
export const renameSkateTimeToSkateEndTime = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const page = await ctx.db
      .query('reports')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(500, Math.max(1, batchSize ?? 100)) });
    const reports = page.page;
    let renamed = 0;
    let placed = 0;
    for (const r of reports) {
      // The legacy field is off the typed schema now, so read it through a narrow cast.
      const legacy = (r as { skateTime?: number }).skateTime;
      const patch: Record<string, unknown> = {};
      if (r.skateEndTime === undefined && typeof legacy === 'number') {
        patch.skateEndTime = legacy;
      }
      // Drop the dangling old field so strict validation passes once re-enabled.
      if (legacy !== undefined) patch.skateTime = undefined;
      if (r.place === undefined) {
        const place = await resolvePlaceForCoord(ctx, r.point);
        if (place !== undefined) {
          patch.place = place;
          placed++;
        }
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(r._id, patch as Partial<Doc<'reports'>>);
        // Count only an actual copy — a cleanup-only patch (report already had `skateEndTime`, we
        // just drop a dangling legacy `skateTime`) isn't a rename and mustn't inflate the count.
        if ('skateEndTime' in patch) renamed++;
      }
    }
    return {
      total: reports.length,
      renamed,
      placed,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * The A10-1 shape backfill: lift every bare-key chip to `{ type }`, fold `snowCoverCm` into
 * `snow.depthCm`, and clear the old field — the "backfill" step of widen → deploy → backfill →
 * narrow, after which the schema drops the string form and `snowCoverCm`. Pure, so the migration
 * and its test agree on exactly what changes: returns the patch, or `null` for a row already in
 * the new shape (the migration is idempotent by construction).
 */
export function a10ShapePatch(report: Doc<'reports'>): Partial<Doc<'reports'>> | null {
  // The pre-A10 shapes are off the typed schema now (narrowed after the dev backfill), so the
  // legacy forms are read through a narrow cast — the same move the `skateTime` rename made.
  const legacy = report as unknown as {
    iceTypes: ChipInput<IceType>[];
    surfaceTags: ChipInput<SurfaceTag>[];
    snowCoverCm?: number;
  };
  const patch: Record<string, unknown> = {};
  if (legacy.iceTypes.some((chip) => typeof chip === 'string')) {
    patch.iceTypes = legacy.iceTypes.map(toLocatedChip);
  }
  if (legacy.surfaceTags.some((chip) => typeof chip === 'string')) {
    patch.surfaceTags = legacy.surfaceTags.map(toLocatedChip);
  }
  if (legacy.snowCoverCm !== undefined) {
    // A row with both (an edit under the widened schema) keeps the object's depth.
    patch.snow =
      report.snow?.depthCm !== undefined
        ? report.snow
        : { ...(report.snow ?? {}), depthCm: legacy.snowCoverCm };
    patch.snowCoverCm = undefined;
  }
  return Object.keys(patch).length > 0 ? (patch as Partial<Doc<'reports'>>) : null;
}

/** `pnpm exec convex run reports:backfillA10Shapes` — paginated, self-scheduling, idempotent. */
export const backfillA10Shapes = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const page = await ctx.db
      .query('reports')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(500, Math.max(1, batchSize ?? 200)) });
    let patched = 0;
    for (const r of page.page) {
      const patch = a10ShapePatch(r);
      if (patch === null) continue;
      await ctx.db.patch(r._id, patch);
      patched++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.reports.backfillA10Shapes, {
        cursor: page.continueCursor,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    }
    return { scanned: page.page.length, patched, isDone: page.isDone };
  },
});
