/**
 * **The season so far, counted once each** (B01, Overview › Metrics) — the figures a day's rollup
 * can't add up to: how many *people* signed in or contributed this season (a person on ten days is
 * one person), how many *posts* the reports were in, how many *bodies* had hazards; the season's
 * reports by vantage; the most-reported bodies; and the same activity by state.
 *
 * ## A walk, one page per transaction
 *
 * A season's rows are far past what one transaction may read, and a distinct count can't be summed
 * from the days. So this walks the season's rows source by source — reports, comments, kudos,
 * photos, hazards, sign-ins — one page per transaction, carrying its tallies and id sets forward
 * through its own arguments (the `sweepCorpus` pattern), and writes `season_reach` and
 * `most_reported` once, at the end, stamped on the window's last day. Nothing partial is ever
 * written: a chart never shows a half-walked season as if it were the whole one.
 *
 * Each id set is bounded ({@link ID_CAP}); one that fills stops growing and its figure is named in
 * `capped`, which the reads return as `null` — a floor is never shown as the count.
 *
 * ## Which season
 *
 * The window is `seasonRecordWindow` (1 October through today, or the whole of a past season): the
 * same rule the charts use. The 6-hourly rollup walks the current season; a past season is walked
 * by hand (`start` with its `season`). Between 1 July and 30 September the window is empty and
 * nothing is walked or written.
 */

import {
  POSITIVE_REACTION_KINDS,
  positiveReactionOf,
  resolveSeason,
  type Season,
  seasonOf,
  seasonRecordSpan,
  seasonRecordWindow,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { writeMetricSnapshot } from './lib/metrics';
import { isCountedComment } from './lib/pulse';

/** Rows read per transaction. Comments, kudos and photos each read their report too. */
const PAGE = 300;

/** The most ids a set carries forward. Past it the set stops growing and its figure is capped. */
export const ID_CAP = 20_000;

/** The most bodies the most-reported tally carries. Past it, the ranking is capped. */
const BODY_CAP = 5_000;

/** How many bodies the most-reported ranking keeps. */
export const MOST_REPORTED_ROWS = 20;

/** The sources, in walk order. */
export const STAGES = ['reports', 'comments', 'kudos', 'photos', 'hazards', 'signIns'] as const;
type Stage = (typeof STAGES)[number];

/** One state's season: counts, and its contributors as an id set while walking. */
type StateTally = {
  reports: number;
  comments: number;
  photos: number;
  kudos: number;
  people: string[];
};

/** What the walk carries from page to page. Plain data — it travels as a function argument. */
export type Tally = {
  counts: { reports: number; comments: number; kudos: number; photos: number; hazards: number };
  vantage: Record<string, number>;
  sets: {
    posts: string[];
    commented: string[];
    kudosPeople: string[];
    photographed: string[];
    hazardBodies: string[];
    signedIn: string[];
    contributors: string[];
  };
  states: Record<string, StateTally>;
  bodies: Record<string, { reports: number; photos: number; people: string[]; last: number }>;
  capped: string[];
};

export function emptyTally(): Tally {
  return {
    counts: { reports: 0, comments: 0, kudos: 0, photos: 0, hazards: 0 },
    vantage: {},
    sets: {
      posts: [],
      commented: [],
      kudosPeople: [],
      photographed: [],
      hazardBodies: [],
      signedIn: [],
      contributors: [],
    },
    states: {},
    bodies: {},
    capped: [],
  };
}

/** The state a report was filed from (its point-derived place), or `unknown`. */
const stateOf = (report: Doc<'reports'> | null): string => report?.place?.state ?? 'unknown';

/** A page's working copy of the tally: the id arrays as sets, written back by {@link pack}. */
function unpack(t: Tally) {
  const sets = Object.fromEntries(
    Object.entries(t.sets).map(([k, ids]) => [k, new Set(ids)]),
  ) as Record<keyof Tally['sets'], Set<string>>;
  const statePeople = new Map(
    Object.entries(t.states).map(([state, s]) => [state, new Set(s.people)]),
  );
  const bodyPeople = new Map(Object.entries(t.bodies).map(([id, b]) => [id, new Set(b.people)]));
  const capped = new Set(t.capped);

  /** Add to a bounded set; a full set stops growing and marks its figure capped. */
  const addTo = (set: Set<string>, id: string, name: string) => {
    if (set.has(id)) return;
    if (set.size >= ID_CAP) {
      capped.add(name);
      return;
    }
    set.add(id);
  };
  const state = (code: string): StateTally => {
    const s = t.states[code] ?? { reports: 0, comments: 0, photos: 0, kudos: 0, people: [] };
    t.states[code] = s;
    if (!statePeople.has(code)) statePeople.set(code, new Set());
    return s;
  };
  const statePerson = (code: string, id: string) => {
    state(code);
    addTo(statePeople.get(code) as Set<string>, id, `states.${code}.contributors`);
  };
  const contributor = (id: string) => addTo(sets.contributors, id, 'contributors');

  const pack = (): Tally => ({
    ...t,
    sets: Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, [...s]])) as Tally['sets'],
    states: Object.fromEntries(
      Object.entries(t.states).map(([code, s]) => [
        code,
        { ...s, people: [...(statePeople.get(code) ?? [])] },
      ]),
    ),
    bodies: Object.fromEntries(
      Object.entries(t.bodies).map(([id, b]) => [
        id,
        { ...b, people: [...(bodyPeople.get(id) ?? [])] },
      ]),
    ),
    capped: [...capped],
  });

  return { sets, addTo, state, statePerson, contributor, bodyPeople, capped, pack };
}

/** A report this page needs, read once per page. */
async function reportsById(
  ctx: MutationCtx,
  ids: ReadonlyArray<Id<'reports'> | undefined>,
): Promise<Map<string, Doc<'reports'> | null>> {
  const out = new Map<string, Doc<'reports'> | null>();
  for (const id of ids) {
    if (id === undefined || out.has(id)) continue;
    out.set(id, await ctx.db.get(id));
  }
  return out;
}

/** One page of one stage: the rows it read, folded into the tally. */
async function walkPage(
  ctx: MutationCtx,
  stage: Stage,
  span: { from: number; to: number; firstDay: string; lastDay: string },
  cursor: string | null,
  tally: Tally,
): Promise<{ tally: Tally; isDone: boolean; continueCursor: string }> {
  const w = unpack(tally);
  const t = tally;
  const opts = { cursor, numItems: PAGE };

  switch (stage) {
    case 'reports': {
      const page = await ctx.db
        .query('reports')
        .withIndex('by_moderation_and_skate_end_time', (q) =>
          q
            .eq('moderationStatus', 'visible')
            .gte('skateEndTime', span.from)
            .lt('skateEndTime', span.to),
        )
        .paginate(opts);
      for (const r of page.page) {
        t.counts.reports++;
        if (r.postId !== undefined) w.addTo(w.sets.posts, r.postId, 'posts');
        const vantage = r.observedFrom ?? 'unstated';
        t.vantage[vantage] = (t.vantage[vantage] ?? 0) + 1;
        w.contributor(r.authorId);
        const code = stateOf(r);
        w.state(code).reports++;
        w.statePerson(code, r.authorId);
        let body = t.bodies[r.waterBodyId];
        if (body === undefined) {
          if (Object.keys(t.bodies).length >= BODY_CAP) {
            w.capped.add('mostReported');
          } else {
            body = { reports: 0, photos: 0, people: [], last: 0 };
            t.bodies[r.waterBodyId] = body;
            w.bodyPeople.set(r.waterBodyId, new Set());
          }
        }
        if (body !== undefined) {
          body.reports++;
          body.photos += r.photoIds.length;
          body.last = Math.max(body.last, r.skateEndTime);
          w.addTo(w.bodyPeople.get(r.waterBodyId) as Set<string>, r.authorId, 'mostReported');
        }
      }
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
    case 'comments': {
      const page = await ctx.db
        .query('comments')
        .withIndex('by_created_at', (q) => q.gte('createdAt', span.from).lt('createdAt', span.to))
        .paginate(opts);
      const counted = page.page.filter(isCountedComment);
      const reports = await reportsById(
        ctx,
        counted.map((c) => c.reportId),
      );
      for (const c of counted) {
        t.counts.comments++;
        w.addTo(w.sets.commented, c.reportId, 'commented');
        w.contributor(c.authorId);
        const code = stateOf(reports.get(c.reportId) ?? null);
        w.state(code).comments++;
        w.statePerson(code, c.authorId);
      }
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
    case 'kudos': {
      const page = await ctx.db
        .query('reportRatings')
        .withIndex('by_created_at', (q) => q.gte('createdAt', span.from).lt('createdAt', span.to))
        .paginate(opts);
      const positive = page.page.filter((r) => positiveReactionOf(r.verdict) !== null);
      const reports = await reportsById(
        ctx,
        positive.map((r) =>
          r.targetType === 'report'
            ? (ctx.db.normalizeId('reports', r.targetId) ?? undefined)
            : undefined,
        ),
      );
      for (const r of positive) {
        t.counts.kudos++;
        w.addTo(w.sets.kudosPeople, r.raterId, 'kudosPeople');
        // Kudos on a hazard count in the season's total; only a report says which state it is in.
        if (r.targetType === 'report') w.state(stateOf(reports.get(r.targetId) ?? null)).kudos++;
      }
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
    case 'photos': {
      const page = await ctx.db
        .query('photos')
        .withIndex('by_created_at', (q) => q.gte('createdAt', span.from).lt('createdAt', span.to))
        .paginate(opts);
      const attached = page.page.filter((p) => p.reportId !== undefined);
      const reports = await reportsById(
        ctx,
        attached.map((p) => p.reportId),
      );
      for (const p of attached) {
        const reportId = p.reportId as Id<'reports'>;
        t.counts.photos++;
        w.addTo(w.sets.photographed, reportId, 'photographed');
        w.state(stateOf(reports.get(reportId) ?? null)).photos++;
      }
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
    case 'hazards': {
      const page = await ctx.db
        .query('hazards')
        .withIndex('by_created_at', (q) => q.gte('createdAt', span.from).lt('createdAt', span.to))
        .paginate(opts);
      for (const h of page.page) {
        t.counts.hazards++;
        w.addTo(w.sets.hazardBodies, h.waterBodyId, 'hazardBodies');
        w.contributor(h.createdByUserId);
      }
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
    case 'signIns': {
      const page = await ctx.db
        .query('signInDays')
        .withIndex('by_day', (q) => q.gte('day', span.firstDay).lte('day', span.lastDay))
        .paginate(opts);
      for (const s of page.page) w.addTo(w.sets.signedIn, s.userId, 'signedIn');
      return { tally: w.pack(), isDone: page.isDone, continueCursor: page.continueCursor };
    }
  }
}

/** The ranking: most reports first, then the most recently reported. */
export function mostReported(
  bodies: Tally['bodies'],
  limit = MOST_REPORTED_ROWS,
): Array<{
  bodyId: string;
  reports: number;
  photos: number;
  people: number;
  lastReportAt: number;
}> {
  return Object.entries(bodies)
    .map(([bodyId, b]) => ({
      bodyId,
      reports: b.reports,
      photos: b.photos,
      people: b.people.length,
      lastReportAt: b.last,
    }))
    .sort(
      (a, b) =>
        b.reports - a.reports ||
        b.lastReportAt - a.lastReportAt ||
        a.bodyId.localeCompare(b.bodyId),
    )
    .slice(0, limit);
}

/** What `season_reach` stores: the tally with its id sets counted. */
export function reachMeta(season: Season, through: string, t: Tally) {
  return {
    season,
    through,
    counts: t.counts,
    over: {
      reports: t.sets.posts.length,
      comments: t.sets.commented.length,
      kudos: t.sets.kudosPeople.length,
      photos: t.sets.photographed.length,
      hazards: t.sets.hazardBodies.length,
    },
    people: { signedIn: t.sets.signedIn.length, contributors: t.sets.contributors.length },
    vantage: t.vantage,
    states: Object.fromEntries(
      Object.entries(t.states).map(([code, s]) => [
        code,
        {
          reports: s.reports,
          comments: s.comments,
          photos: s.photos,
          kudos: s.kudos,
          contributors: s.people.length,
        },
      ]),
    ),
    kinds: [...POSITIVE_REACTION_KINDS],
    capped: t.capped,
  };
}

const stageValidator = v.union(...STAGES.map((s) => v.literal(s)));

/**
 * Walk a season (default: the one now falls in). Nothing happens while its window is empty.
 * `pnpm --filter @skating/convex exec convex run seasonReach:start '{"season":2025}'` walks a past one.
 */
export const start = internalMutation({
  args: { season: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const season = resolveSeason(args.season, seasonOf(now));
    const span = seasonRecordSpan(season, now);
    const { days } = seasonRecordWindow(season, now);
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    if (span === null || firstDay === undefined || lastDay === undefined) {
      return { season, walking: false };
    }
    // The span is fixed here and carried: a page re-deriving it after midnight would change the
    // query under its cursor.
    await ctx.scheduler.runAfter(0, internal.seasonReach.step, {
      season,
      span: { ...span, firstDay, lastDay },
      stage: STAGES[0],
      cursor: null,
      tally: emptyTally(),
    });
    return { season, walking: true };
  },
});

/** One page of the walk; the last page of the last stage writes the two snapshots. */
export const step = internalMutation({
  args: {
    season: v.number(),
    span: v.object({ from: v.number(), to: v.number(), firstDay: v.string(), lastDay: v.string() }),
    stage: stageValidator,
    cursor: v.union(v.string(), v.null()),
    // The tally is plain data the walk itself built; its shape is `Tally`.
    tally: v.any(),
  },
  handler: async (ctx, { season, span, stage, cursor, tally }) => {
    const page = await walkPage(ctx, stage, span, cursor, tally as Tally);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.seasonReach.step, {
        season,
        span,
        stage,
        cursor: page.continueCursor,
        tally: page.tally,
      });
      return { done: false };
    }
    const next = STAGES[STAGES.indexOf(stage) + 1];
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.seasonReach.step, {
        season,
        span,
        stage: next,
        cursor: null,
        tally: page.tally,
      });
      return { done: false };
    }

    await writeMetricSnapshot(ctx, 'season_reach', span.lastDay, {
      meta: reachMeta(season, span.lastDay, page.tally),
    });
    await writeMetricSnapshot(ctx, 'most_reported', span.lastDay, {
      meta: {
        season,
        through: span.lastDay,
        rows: mostReported(page.tally.bodies),
        capped: page.tally.capped.includes('mostReported'),
      },
    });
    return { done: true };
  },
});
