/**
 * Named landmarks (D202) — the islands, points, reference bays, narrows, river mouths, bridges,
 * marinas, lighthouses, dams, shore towns and shore establishments a body is steered by.
 *
 * Three writers, one table:
 *
 * - **The ETL** (`scripts/etl load-landmarks`) — OSM + GNIS, matched to a body *offline* against a
 *   geometry export (`listBodyGeometry`), then written in batches of whole bodies (`importBatch`).
 *   Matching here, per point, would read the candidate body's polygon once per landmark —
 *   Champlain's ~300 KB for each of its several hundred — the A06d parking pass's 105 GB mistake.
 * - **A moderator** on the lake editor: drop a point, name it, pick a kind; rename, move, re-kind,
 *   remove, restore. An edit sets `moderatorEditedAt`, and a re-run of the ETL then leaves the name,
 *   kind and point alone.
 * - **The chord tool**, when a landmark is promoted to a bay (`retireAsPromoted`).
 *
 * One reader shape: `listForBody`, bounded per body and never viewport-wide, carrying the prominence
 * and label zoom both maps sort and filter by. A landmark is a label, never a place: nothing here
 * links to a page, and nothing here says anything about the ice (D3).
 */

import {
  LANDMARK_KINDS,
  type LandmarkKind,
  type LandmarkSourceCheck,
  landmarkDropsHeld,
  landmarkLabelMinZoom,
  landmarkProminence,
  landmarkSourceCheck,
  landmarkSourceReasons,
  landmarkSourcesVouch,
  landmarksAreSamePlace,
  MAX_LANDMARKS_PER_BODY,
  nextLandmarkSourceBar,
  normalizeLandmarkNames,
} from '@skating/core';
import { ConvexError, type Infer, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
import {
  assertNotABayName,
  auditLandmark,
  bayNaming,
  identityOf,
  isCatalogsLive,
  LandmarkRowIndex,
  landmarksForBody,
  liveLandmarksForBody,
  removedLandmarksForBody,
  subAreaFor,
} from './lib/landmarkRows';
import { isListed } from './lib/listing';
import { latLng, literals } from './lib/validators';
import { stampCandidates } from './subAreas';

/** The label-ready view of a row: what both maps and the sheet read. */
function toView(row: Doc<'bodyLandmarks'>) {
  const input = {
    kind: row.kind,
    areaSqM: row.areaSqM,
    corpusMessages: row.corpusMessages,
    reportCount: row.reportCount,
  };
  return {
    _id: row._id,
    name: row.name,
    kind: row.kind,
    point: row.point,
    aliases: row.aliases,
    ...(row.subAreaId !== undefined ? { subAreaId: row.subAreaId } : {}),
    ...(row.areaSqM !== undefined ? { areaSqM: row.areaSqM } : {}),
    prominence: landmarkProminence(input),
    minZoom: landmarkLabelMinZoom({ ...input, lat: row.point.lat }),
  };
}

export type LandmarkView = ReturnType<typeof toView>;

/**
 * The live landmarks on one body, most prominent first — the map's label layer, the sheet's list.
 * Public, like the body's hazards and put-ins: a name on a map is not personal data.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const rows = await liveLandmarksForBody(ctx, waterBodyId);
    return rows
      .map(toView)
      .sort((a, b) => b.prominence - a.prominence || a.name.localeCompare(b.name));
  },
});

/**
 * Moderator: every landmark on a body, removed ones flagged — the lake editor's list, which offers a
 * restore. Carries the provenance a moderator needs to judge a row (where it came from, whether a
 * person already vouched for it).
 */
export const listForEditor = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireRole(ctx, 'moderator');
    const rows = await landmarksForBody(ctx, waterBodyId);
    return rows
      .map((row) => ({
        ...toView(row),
        source: row.source,
        externalIds: row.externalIds,
        ...(row.corpusMessages !== undefined ? { corpusMessages: row.corpusMessages } : {}),
        ...(row.moderatorEditedAt !== undefined
          ? { moderatorEditedAt: row.moderatorEditedAt }
          : {}),
        ...(row.removedAt !== undefined ? { removedAt: row.removedAt } : {}),
        ...(row.catalogDroppedAt !== undefined ? { catalogDroppedAt: row.catalogDroppedAt } : {}),
        ...(row.mergedIntoId !== undefined ? { mergedIntoId: row.mergedIntoId } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The ETL's two ends
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Listed bodies with their geometry, paged — the one read of the corpus the landmark ETL makes, so
 * that every point is matched offline rather than by a per-point lookup here.
 *
 * **A byte budget, not a row budget** (`sweepBodySummaries`): `paginate` reads whole documents, and
 * this returns every polygon it reads, so a page is bounded by the read *and* the return cap (16 MB
 * each). Twenty a page puts even an all-giants page (Champlain is ~300 KB) at a third of that. The
 * whole walk reads each body once — ~45 MB over ~25,000 bodies — which is less than the per-point
 * lookups it replaces would have cost at Champlain's shore alone.
 */
export const listBodyGeometry = internalQuery({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(50, Math.max(1, batchSize ?? 20));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const bodies = page.page.filter(isListed).map((body) => ({
      _id: body._id,
      name: body.name,
      states: body.states,
      polygon: body.polygon,
      bbox: body.bbox,
      surfaceAreaSqM: body.surfaceAreaSqM,
    }));
    return { bodies, cursor: page.continueCursor, isDone: page.isDone };
  },
});

const importedLandmark = v.object({
  name: v.string(),
  kind: literals(LANDMARK_KINDS),
  point: latLng,
  areaSqM: v.optional(v.number()),
  /** `osm` or `gnis` — which catalog the row's name and point came from. */
  source: v.union(v.literal('osm'), v.literal('gnis')),
  externalIds: v.array(v.string()),
  aliases: v.array(v.string()),
  corpusMessages: v.optional(v.number()),
});

/**
 * Load landmarks for a batch of bodies — **dry unless `dryRun: false`**, as every loader in
 * `scripts/etl` is. Batched across bodies because ten thousand bodies carry one or two landmarks
 * each, and one `convex run` per body would be hours of process spawns for seconds of writes. The
 * loader packs batches by landmark count and **never splits a body**: each line is the run's whole
 * list for its body, which is what lets the resolution below be exact and the drop below be safe.
 *
 * **Resolve, then write — one write per row per call.** Each candidate finds its row by any shared
 * upstream id, else by core's `landmarksAreSamePlace` (a candidate with no row joins another new
 * candidate the same way), and the candidates that resolve to one row are applied together: the
 * first sets the name, kind and point, and the group's ids and spellings are its ids and aliases. So
 * a row the catalogs own takes this run's aliases — an alias a later run drops leaves — and two
 * candidates for one row cannot take turns overwriting it, run after run.
 *
 * Skipped or held, and counted: a name empty or longer than a place name (`invalidName`); a
 * candidate named for one of the body's live bays (`alreadyBay`); a
 * removed row stays removed (a re-run must not resurrect what a moderator took down); a moderator's
 * row keeps its name, kind, point and spellings and only gains ids, spellings and the corpus count;
 * a new row past `MAX_LANDMARKS_PER_BODY` is refused (`overCap`) — the cap is enforced here so the
 * read can trust it. A body no longer listed is skipped whole: the export it was matched against is
 * older than this call, and a lake removed in between should not gain labels. Counts are per row.
 *
 * **What a run stopped placing leaves (`dropped`).** A line marked `complete` is everything the
 * catalogs place on that body — the transform marks a body complete only when the run read every
 * state it lies in, and writes an empty line for a covered body it placed nothing on. A catalog row
 * on a complete body that no candidate resolved to is retired with `catalogDroppedAt` — soft, so the
 * ids that point at it still resolve — and a later run that places it again brings it back
 * (`returned`). Only the catalogs' own rows: a moderator's row, or one a moderator edited, is theirs.
 *
 * **Only when the sources vouch.** `complete` retires nothing unless the run's per-source counts
 * (`sources`) clear the bar this deployment accepted (`landmarkSourceCheck`, each source's highest
 * accepted count) — a truncated extract is not a removal, and the first complete load on a
 * deployment only sets the bar. And a lake about to lose more than half its catalog rows holds them (`dropsHeld`,
 * `landmarkDropsHeld`). Each has its own override, on the operator's word — `acceptSourceDrop`,
 * `acceptMassDrop` — so excusing a real catalog shrink never also switches off the brake.
 */
type ImportCounts = {
  created: number;
  updated: number;
  unchanged: number;
  removedHeld: number;
  moderatorHeld: number;
  overCap: number;
  bodyNotListed: number;
  alreadyBay: number;
  invalidName: number;
  dropped: number;
  /** Rows a complete line would have dropped, held by the per-lake brake (`landmarkDropsHeld`). */
  dropsHeld: number;
  returned: number;
};

function emptyCounts(): ImportCounts {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    removedHeld: 0,
    moderatorHeld: 0,
    overCap: 0,
    bodyNotListed: 0,
    alreadyBay: 0,
    invalidName: 0,
    dropped: 0,
    dropsHeld: 0,
    returned: 0,
  };
}

/** A placement's id names its feature up to the `#` (`osm:way/1#in@44.02,-73.10` → `osm:way/1`). */
function featureIdOf(id: string): string {
  return id.split('#')[0] as string;
}

const sourceCounts = v.array(v.object({ source: v.string(), count: v.number() }));

async function acceptedBaseline(ctx: QueryCtx) {
  return ctx.db.query('landmarkSourceBaselines').withIndex('by_accepted_at').order('desc').first();
}

export const importBatch = internalMutation({
  args: {
    bodies: v.array(
      v.object({
        waterBodyId: v.id('waterBodies'),
        landmarks: v.array(importedLandmark),
        /** The run read every state the body lies in, so this list is all the catalogs place on it. */
        complete: v.optional(v.boolean()),
      }),
    ),
    campaignId: v.optional(v.string()),
    /** When the body export the run was matched against was taken (`summary.bodiesExportedAt`). */
    matchedAt: v.optional(v.number()),
    /** What each catalog source read on this run (`summary.bySource`) — what vouches for `complete`. */
    sources: v.optional(sourceCounts),
    /** The operator says a source shortfall is real (`--accept-source-drop`). */
    acceptSourceDrop: v.optional(v.boolean()),
    /** The operator says a lake's mass drop is real (`--accept-mass-drop`) — a separate word. */
    acceptMassDrop: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { bodies, campaignId, matchedAt, dryRun } = args;
    const acceptSourceDrop = args.acceptSourceDrop === true;
    // A line's `complete` retires rows only when the run's sources vouch for it against the last load
    // this deployment accepted. Checked here, in the one writer, so no caller can skip it.
    let check: LandmarkSourceCheck = { blocking: [], shrinks: [] };
    if (bodies.some((b) => b.complete === true)) {
      check = landmarkSourceCheck(args.sources, (await acceptedBaseline(ctx))?.sources);
    }
    // The operator may excuse a shrink, never a block (no bar yet, no counts, an empty source).
    const vouched = landmarkSourcesVouch(check, acceptSourceDrop);
    const shortfalls = landmarkSourceReasons(check);
    const total = emptyCounts();
    for (const { waterBodyId, landmarks, complete } of bodies) {
      const counts = await importOneBody(ctx, waterBodyId, landmarks, {
        complete: complete === true && vouched,
        matchedAt,
        acceptMassDrop: args.acceptMassDrop === true,
        campaignId,
        write: dryRun === false,
      });
      for (const key of Object.keys(total) as (keyof ImportCounts)[]) total[key] += counts[key];
    }
    return { ...total, shortfalls: vouched ? [] : shortfalls };
  },
});

/**
 * Record a complete load as the deployment's new source baseline (D202) — called by the loader after
 * an applied complete run with no failed batch, never by a dry run or a transform. Refused (and the
 * old bar kept) when the run's own sources fall short of it — a shrink unless the operator said it is
 * real, a block always; with no bar yet, the run is held only to having read something from every
 * source. The bar moves up freely and down only on the operator's word (`nextLandmarkSourceBar`).
 */
export const acceptCompleteLoad = internalMutation({
  args: {
    sources: sourceCounts,
    campaignId: v.optional(v.string()),
    acceptSourceDrop: v.optional(v.boolean()),
  },
  handler: async (ctx, { sources, campaignId, acceptSourceDrop }) => {
    const baseline = await acceptedBaseline(ctx);
    // With no bar yet, the run is held to having read something from every source it names.
    const check = landmarkSourceCheck(sources, baseline?.sources ?? sources);
    const accept = acceptSourceDrop === true;
    const shortfalls = landmarkSourceReasons(check);
    if (!landmarkSourcesVouch(check, accept)) return { accepted: false, shortfalls };
    await ctx.db.insert('landmarkSourceBaselines', {
      // Never lowered without the operator's word, and then only the sources they excused.
      sources: nextLandmarkSourceBar(sources, baseline?.sources, check, accept),
      ...(campaignId !== undefined ? { campaignId } : {}),
      ...(accept && check.shrinks.length > 0 ? { acceptedShrink: true } : {}),
      acceptedAt: Date.now(),
    });
    return { accepted: true, shortfalls };
  },
});

type Incoming = Infer<typeof importedLandmark> & { aliases: string[] };

/** The candidates that resolve to one row — an existing one, or one this call will create. */
interface Group {
  existing?: Doc<'bodyLandmarks'>;
  members: Incoming[];
}

async function importOneBody(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  landmarks: Infer<typeof importedLandmark>[],
  {
    complete,
    matchedAt,
    acceptMassDrop,
    campaignId,
    write,
  }: {
    complete: boolean;
    matchedAt: number | undefined;
    acceptMassDrop: boolean;
    campaignId: string | undefined;
    write: boolean;
  },
): Promise<ImportCounts> {
  const counts = emptyCounts();
  const liveRows = await liveLandmarksForBody(ctx, waterBodyId);
  // A complete run's empty line usually lands on a body that never had a landmark: the live read
  // says so, and neither the removed rows nor the body's polygon is read.
  if (landmarks.length === 0 && !(complete && liveRows.some(isCatalogsLive))) return counts;
  const rows = [...liveRows, ...(await removedLandmarksForBody(ctx, waterBodyId))];
  const body = await ctx.db.get(waterBodyId);
  if (!body || !isListed(body)) {
    counts.bodyNotListed = landmarks.length;
    return counts;
  }

  const candidates = await stampCandidates(ctx, waterBodyId);
  // A name a live bay here already answers to is the bay's (D202): "Malletts Bay" the village and
  // "Malletts Bay" the sub-area would be two labels saying one thing — the one rule, `bayNaming`.
  const bays = candidates.map(({ ref, polygon }) => ({
    _id: ref._id,
    polygon,
    names: [ref.name, ...(ref.aliases ?? [])],
  }));

  // ── Resolve every candidate to its row ───────────────────────────────────────────────────────
  // The one rule a merge also uses (`LandmarkRowIndex.assign`), decided for the whole line at once:
  // a live row an upstream id names, then same-place rows closest pair first (live before removed),
  // so a river's two mouths near one row each keep their own. A candidate skipped below still claims
  // the row it resolves to, so a complete line never drops a row only because this run declined to
  // write it. (A name too broken to keep resolves by its ids alone.)
  const index = new LandmarkRowIndex(rows);
  const entries = landmarks.map((raw) => {
    const names = normalizeLandmarkNames(raw.name, raw.aliases);
    const probe: Incoming = names
      ? { ...raw, name: names.name, aliases: names.aliases }
      : { ...raw, name: '', aliases: [] };
    return { probe, valid: names !== null };
  });
  const assigned = index.assign(entries.map((e) => e.probe));
  const claimed = new Set([...assigned.values()].map((row) => row._id));
  const byRow = new Map<Id<'bodyLandmarks'>, Group>();
  const fresh: Group[] = [];
  for (const { probe: incoming, valid } of entries) {
    const existing = assigned.get(incoming);
    if (!valid) {
      counts.invalidName++;
      continue;
    }
    // The row it answers to is kept as it is — and the far Mud Bay the rule leaves alone is no
    // bay's, so it loads like any landmark.
    if (bayNaming({ point: incoming.point, names: [incoming.name, ...incoming.aliases] }, bays)) {
      counts.alreadyBay++;
      continue;
    }
    if (existing) {
      const group = byRow.get(existing._id);
      if (group) group.members.push(incoming);
      else byRow.set(existing._id, { existing, members: [incoming] });
      continue;
    }
    const identity = identityOf(incoming);
    const joined = fresh.find((group) =>
      group.members.some(
        (m) =>
          m.externalIds.some((id) => incoming.externalIds.includes(id)) ||
          landmarksAreSamePlace(identityOf(m), identity),
      ),
    );
    if (joined) joined.members.push(incoming);
    else fresh.push({ members: [incoming] });
  }

  const now = Date.now();
  const stamp = campaignId !== undefined ? { lastCampaignId: campaignId } : {};
  // A feature's id accumulates (one that left the catalog still finds its row); a *placement's* —
  // a river mouth's `osm:way/1#in@44.0213,-73.1002` — is this run's alone, or a shore redrawn by a
  // campaign would grow every mouth's ids run after run.
  const idsOf = (members: readonly Incoming[], also: readonly string[] = []) => [
    ...new Set([
      ...also.filter((id) => !id.includes('#')),
      ...members.flatMap((m) => m.externalIds),
    ]),
  ];
  const spellingsOf = (members: readonly Incoming[]) =>
    members.flatMap((m) => [m.name, ...m.aliases]);
  const corpusOf = (members: readonly Incoming[], floor = 0) =>
    Math.max(floor, ...members.map((m) => m.corpusMessages ?? 0)) || undefined;

  let live = rows.filter((row) => row.removedAt === undefined).length;

  // ── Rows this run no longer places — first, so their room goes to what it does ──────────────
  if (complete) {
    const dropping = rows.filter(
      (row) =>
        isCatalogsLive(row) &&
        !byRow.has(row._id) &&
        !claimed.has(row._id) &&
        // A merge moved it here after the export this run matched against, which placed its
        // catalogs on the merged lake: this line could not have had it.
        !(row.movedAt !== undefined && (matchedAt === undefined || row.movedAt > matchedAt)),
    );
    // The per-lake brake: most of a lake's labels do not leave in one run on the catalogs' say-so.
    const held =
      !acceptMassDrop && landmarkDropsHeld(dropping.length, rows.filter(isCatalogsLive).length);
    if (held) counts.dropsHeld += dropping.length;
    for (const row of held ? [] : dropping) {
      counts.dropped++;
      live--;
      if (write) {
        await ctx.db.patch(row._id, {
          removedAt: now,
          catalogDroppedAt: now,
          ...stamp,
          updatedAt: now,
        });
      }
    }
  }

  /** The catalogs' word on a row they own: this run's name, kind, point and spellings. */
  const catalogPatch = (existing: Doc<'bodyLandmarks'>, members: readonly Incoming[]) => {
    const first = members[0] as Incoming;
    // A footprint and a specific kind the row holds from a merge's fold are kept by a run matched
    // against an export older than that merge (it could not have seen the folded feature); any other
    // run is the catalogs' word, and a footprint they no longer draw goes.
    const predatesMerge =
      existing.movedAt !== undefined && (matchedAt === undefined || existing.movedAt > matchedAt);
    const areaSqM =
      members.find((m) => m.areaSqM !== undefined)?.areaSqM ??
      (predatesMerge ? existing.areaSqM : undefined);
    return {
      name: first.name,
      // The specific kind wins, as in the ETL's own fold: a GNIS "other" and an OSM island resolved
      // to one row are an island, whichever came first in the line.
      kind:
        members.find((m) => m.kind !== 'other')?.kind ??
        (predatesMerge ? existing.kind : first.kind),
      point: first.point,
      areaSqM,
      // Whichever catalog the name and point came from this run — the editor shows it as provenance.
      source: first.source,
      subAreaId: subAreaFor(first.point, candidates)?.subAreaId,
      // Upstream ids accumulate — an id that left the catalog still finds its row — while the
      // spellings are this run's: the row is the catalogs', and a spelling they dropped goes.
      externalIds: idsOf(members, existing.externalIds),
      aliases: normalizeLandmarkNames(first.name, spellingsOf(members))?.aliases ?? [],
      corpusMessages: corpusOf(members),
    } satisfies Partial<Doc<'bodyLandmarks'>>;
  };

  // ── Existing rows: one patch each ────────────────────────────────────────────────────────────
  for (const { existing, members } of byRow.values()) {
    if (!existing) continue;
    if (existing.removedAt !== undefined) {
      // A person's removal holds; the catalogs' own drop is undone by the catalogs placing it again —
      // unless a moderator has since edited the dropped row, which makes it theirs.
      if (existing.catalogDroppedAt === undefined || existing.moderatorEditedAt !== undefined) {
        counts.removedHeld++;
        continue;
      }
      if (live >= MAX_LANDMARKS_PER_BODY) {
        counts.overCap++;
        continue;
      }
      live++;
      counts.returned++;
      if (write) {
        await ctx.db.patch(existing._id, {
          ...catalogPatch(existing, members),
          removedAt: undefined,
          catalogDroppedAt: undefined,
          ...stamp,
          updatedAt: now,
        });
      }
      continue;
    }
    let patch: Partial<Doc<'bodyLandmarks'>>;
    if (existing.moderatorEditedAt !== undefined) {
      counts.moderatorHeld++;
      // Spellings come only with a feature the row did not already carry: one the moderator deleted
      // from a feature it knows stays deleted, run after run. (A mouth's id is its feature's up to
      // the `#`, so a redrawn shore is not a new feature.)
      const known = new Set(existing.externalIds.map(featureIdOf));
      const newcomers = members.filter((m) =>
        m.externalIds.some((id) => !known.has(featureIdOf(id))),
      );
      patch = {
        externalIds: idsOf(members, existing.externalIds),
        aliases:
          normalizeLandmarkNames(existing.name, [...existing.aliases, ...spellingsOf(newcomers)])
            ?.aliases ?? existing.aliases,
        corpusMessages: corpusOf(members, existing.corpusMessages),
      };
    } else {
      patch = catalogPatch(existing, members);
    }
    if (unchanged(existing, patch)) {
      if (existing.moderatorEditedAt === undefined) counts.unchanged++;
      continue;
    }
    if (existing.moderatorEditedAt === undefined) counts.updated++;
    if (write) await ctx.db.patch(existing._id, { ...patch, ...stamp, updatedAt: now });
  }

  // ── New rows, up to the cap ──────────────────────────────────────────────────────────────────
  for (const { members } of fresh) {
    if (live >= MAX_LANDMARKS_PER_BODY) {
      counts.overCap++;
      continue;
    }
    live++;
    counts.created++;
    const first = members[0] as Incoming;
    const corpusMessages = corpusOf(members);
    if (!write) continue;
    await ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name: first.name,
      kind: first.kind,
      point: first.point,
      ...(first.areaSqM !== undefined ? { areaSqM: first.areaSqM } : {}),
      ...(subAreaFor(first.point, candidates) ?? {}),
      source: first.source,
      externalIds: idsOf(members),
      aliases: normalizeLandmarkNames(first.name, spellingsOf(members))?.aliases ?? [],
      ...(corpusMessages !== undefined ? { corpusMessages } : {}),
      ...stamp,
      createdAt: now,
      updatedAt: now,
    });
  }
  return counts;
}

/** Would this patch change nothing a reader sees? Arrays compare as sets, in order-insensitive form. */
function unchanged(row: Doc<'bodyLandmarks'>, patch: Partial<Doc<'bodyLandmarks'>>): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const current = row[key as keyof Doc<'bodyLandmarks'>];
    if (Array.isArray(value) || Array.isArray(current)) {
      const a = [...((current as string[] | undefined) ?? [])].sort();
      const b = [...((value as string[] | undefined) ?? [])].sort();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
    } else if (value !== null && typeof value === 'object') {
      if (JSON.stringify(value) !== JSON.stringify(current)) return false;
    } else if (value !== current) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A moderator's hand
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function cleanNames(name: string, aliases: readonly string[] | undefined) {
  const names = normalizeLandmarkNames(name, aliases ?? []);
  if (!names) throw new ConvexError('A landmark needs a name of 80 characters or fewer');
  return names;
}

/**
 * Refuse a second live landmark that is the same place as one this lake already has — core's
 * `landmarksAreSamePlace`, the rule the import and the ETL use, so a moderator is refused exactly the
 * pairs the catalogs would have merged. "Long Point" is on half the lakes in Vermont and on
 * Champlain twice; two of them far apart are two places.
 */
function assertNotDuplicate(
  rows: readonly Doc<'bodyLandmarks'>[],
  candidate: {
    kind: LandmarkKind;
    point: { lat: number; lng: number };
    name: string;
    aliases: readonly string[];
  },
  exceptId?: Id<'bodyLandmarks'>,
): void {
  const identity = identityOf(candidate);
  const clash = rows.find(
    (row) =>
      row._id !== exceptId &&
      row.removedAt === undefined &&
      landmarksAreSamePlace(identityOf(row), identity),
  );
  if (clash) throw new ConvexError(`"${clash.name}" is already a landmark here`);
}

/**
 * A body a moderator may put a label on: one on the map. A merged or removed body is listed nowhere,
 * and a label written to it from a stale editor tab — after the merge moved the rest — would be
 * stranded for good.
 */
async function requireListedBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'>> {
  const body = await ctx.db.get(waterBodyId);
  if (!body) throw new ConvexError('That water body no longer exists');
  if (!isListed(body)) throw new ConvexError('That water body is not on the map');
  return body;
}

/** Moderator: drop a named point on a lake (D202). */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    name: v.string(),
    kind: literals(LANDMARK_KINDS),
    point: latLng,
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    await requireListedBody(ctx, args.waterBodyId);
    const names = cleanNames(args.name, args.aliases);
    const rows = await liveLandmarksForBody(ctx, args.waterBodyId);
    assertNotDuplicate(rows, { kind: args.kind, point: args.point, ...names });
    await assertNotABayName(ctx, args.waterBodyId, {
      point: args.point,
      names: [names.name, ...names.aliases],
    });
    if (rows.filter((row) => row.removedAt === undefined).length >= MAX_LANDMARKS_PER_BODY) {
      throw new ConvexError(`This lake already has ${MAX_LANDMARKS_PER_BODY} landmarks`);
    }
    const now = Date.now();
    const id = await ctx.db.insert('bodyLandmarks', {
      waterBodyId: args.waterBodyId,
      name: names.name,
      kind: args.kind,
      point: args.point,
      ...(subAreaFor(args.point, await stampCandidates(ctx, args.waterBodyId)) ?? {}),
      source: 'moderator',
      externalIds: [],
      aliases: names.aliases,
      moderatorEditedAt: now,
      createdByUserId: actor._id,
      createdAt: now,
      updatedAt: now,
    });
    await auditLandmark(ctx, actor._id, 'create_landmark', id, `Added "${names.name}"`, {
      kind: args.kind,
    });
    return id;
  },
});

/**
 * Moderator: rename, move or re-kind a landmark, or change its aliases. Marks the row as a
 * moderator's, so the next ETL run keeps what was set here.
 */
export const update = mutation({
  args: {
    landmarkId: v.id('bodyLandmarks'),
    name: v.optional(v.string()),
    kind: v.optional(literals(LANDMARK_KINDS)),
    point: v.optional(latLng),
    aliases: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(args.landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    const names = cleanNames(args.name ?? row.name, args.aliases ?? row.aliases);
    const point = args.point ?? row.point;
    const rows = await liveLandmarksForBody(ctx, row.waterBodyId);
    const kind = args.kind ?? row.kind;
    assertNotDuplicate(rows, { kind, point, ...names }, row._id);
    await assertNotABayName(ctx, row.waterBodyId, { point, names: [names.name, ...names.aliases] });
    const now = Date.now();
    const moved = args.point !== undefined;
    await ctx.db.patch(row._id, {
      name: names.name,
      aliases: names.aliases,
      kind,
      point,
      // A moved point may have crossed into (or out of) a bay; an unmoved one keeps its stamp.
      ...(moved
        ? { subAreaId: subAreaFor(point, await stampCandidates(ctx, row.waterBodyId))?.subAreaId }
        : {}),
      moderatorEditedAt: now,
      updatedAt: now,
    });
    await auditLandmark(ctx, actor._id, 'edit_landmark', row._id, `Edited "${names.name}"`, {
      ...(names.name !== row.name ? { from: row.name } : {}),
      ...(moved ? { moved: true } : {}),
      ...(args.kind !== undefined && args.kind !== row.kind ? { kind: args.kind } : {}),
    });
  },
});

/** Moderator: take a landmark off the map. Soft, so a re-run of the ETL never brings it back. */
export const remove = mutation({
  args: { landmarkId: v.id('bodyLandmarks'), reason: v.optional(v.string()) },
  handler: async (ctx, { landmarkId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    // A row the catalogs dropped is already off the map, but a run that places it again would bring
    // it back: removing it makes the removal a person's, which holds.
    if (row.removedAt !== undefined && row.catalogDroppedAt === undefined) return;
    await ctx.db.patch(landmarkId, {
      removedAt: Date.now(),
      catalogDroppedAt: undefined,
      updatedAt: Date.now(),
    });
    await auditLandmark(
      ctx,
      actor._id,
      'remove',
      landmarkId,
      reason?.trim() || `Removed "${row.name}"`,
    );
  },
});

/** Moderator: bring a removed landmark back, if no live one has taken its name since. */
export const restore = mutation({
  args: { landmarkId: v.id('bodyLandmarks') },
  handler: async (ctx, { landmarkId }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(landmarkId);
    if (!row) throw new ConvexError('That landmark no longer exists');
    if (row.removedAt === undefined) return;
    await requireListedBody(ctx, row.waterBodyId);
    const rows = await liveLandmarksForBody(ctx, row.waterBodyId);
    assertNotDuplicate(rows, row, row._id);
    // A landmark retired because it became a bay (D202) stays retired while the bay lives.
    await assertNotABayName(ctx, row.waterBodyId, {
      point: row.point,
      names: [row.name, ...row.aliases],
    });
    if (rows.filter((r) => r.removedAt === undefined).length >= MAX_LANDMARKS_PER_BODY) {
      throw new ConvexError(`This lake already has ${MAX_LANDMARKS_PER_BODY} landmarks`);
    }
    const now = Date.now();
    await ctx.db.patch(landmarkId, {
      removedAt: undefined,
      updatedAt: now,
      // Restored on a moderator's word, so theirs from now on, whatever retired it — a person, a
      // promotion, the catalogs, a merge: a catalog row left catalog-owned would be dropped again by
      // the next complete run that does not place it.
      catalogDroppedAt: undefined,
      moderatorEditedAt: now,
      // A row a merge folded away is a place again once a moderator brings it back.
      mergedIntoId: undefined,
    });
    await auditLandmark(ctx, actor._id, 'restore', landmarkId, `Restored "${row.name}"`);
  },
});
