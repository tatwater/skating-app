/**
 * The corpus's unplaced names (D202) — a moderator's queue of the places the community's emails
 * name that no landmark took. Loaded by `scripts/etl load-landmark-names`; triaged on
 * `/admin/water/place-names` (pick the lake, or dismiss); placed from the lake editor's Landmarks
 * card (drop the point — `landmarks.create` with `corpusNameId` — or file it as another spelling of
 * a landmark already there).
 */

import {
  CORPUS_NAME_DISMISS_REASONS,
  CORPUS_NAME_STATUSES,
  landmarkNameKey,
  normalizeLandmarkNames,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, type QueryCtx, query } from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
import {
  assertNotABayName,
  assertNotDuplicate,
  auditLandmark,
  landmarksForBody,
} from './lib/landmarkRows';
import { isListed } from './lib/listing';
import { literals } from './lib/validators';

/** How many rows the triage page reads — the whole first load is 237; a backlog past this pages. */
const QUEUE_CAP = 400;

/**
 * The load's upsert key — the name and the parent the *emails* named, never a moderator's choice of
 * lake, so a re-load finds the row whatever has happened to it since.
 */
function askKeyOf(name: string, parentName?: string): string {
  return `${landmarkNameKey(name)}|${parentName ? landmarkNameKey(parentName) : ''}`;
}

/** How a lake reads in the queue: its name and states, stored so the queue reads no polygons. */
function lakeLabel(body: Doc<'waterBodies'>): string {
  const states = body.states ?? [];
  return `${body.name ?? 'Unnamed water'}${states.length > 0 ? ` · ${states.join(', ')}` : ''}`;
}

/** The most lakes a name may offer as choices — a "Long Pond" can meet dozens. */
const MAX_CANDIDATES = 8;

async function audit(
  ctx: Parameters<typeof auditLandmark>[0],
  actorId: Id<'profiles'>,
  action: 'remove' | 'restore',
  row: Doc<'corpusPlaceNames'>,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
    action,
    targetType: 'corpusPlaceName',
    targetId: row._id,
    reason,
    metadata: {
      name: row.name,
      ...(row.waterBodyId ? { waterBodyId: row.waterBodyId } : {}),
      ...extra,
    },
    createdAt: Date.now(),
  });
}

const importedName = v.object({
  name: v.string(),
  aliases: v.array(v.string()),
  messages: v.number(),
  skatedMessages: v.number(),
  states: v.array(v.string()),
  parentName: v.optional(v.string()),
  waterBodyId: v.optional(v.id('waterBodies')),
  candidateBodyIds: v.optional(v.array(v.id('waterBodies'))),
  alreadyNamed: v.optional(v.boolean()),
});

/**
 * Load the landmark pass's leftovers — **dry unless `dryRun: false`**. A new name is inserted open;
 * an open one gets this run's counts and spellings; a placed or dismissed one is left as a moderator
 * left it (a lake it was given since stays given). A lake no longer on the map is dropped; the name
 * still loads, for a person to place. Names are keyed by the corpus, so a re-load finds its row.
 */
export const importBatch = internalMutation({
  args: {
    names: v.array(importedName),
    campaignId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { names, campaignId, dryRun }) => {
    const counts = { created: 0, refreshed: 0, unchanged: 0, decidedHeld: 0, duplicate: 0 };
    const now = Date.now();
    const write = dryRun === false;
    // Each lake read once per call (a giant's polygon is 300 KB), and only a listed one kept: a lake
    // merged or delisted since the export cannot be placed on, so it is not offered.
    const lakes = new Map<string, Doc<'waterBodies'> | null>();
    const listed = async (id: Id<'waterBodies'>) => {
      if (!lakes.has(id)) {
        const body = await ctx.db.get(id);
        lakes.set(id, body && isListed(body) ? body : null);
      }
      return lakes.get(id) ?? null;
    };
    const seen = new Set<string>();
    for (const incoming of names) {
      const cleaned = normalizeLandmarkNames(incoming.name, incoming.aliases);
      if (!cleaned) continue;
      const askKey = askKeyOf(cleaned.name, incoming.parentName);
      // Two spellings of one name on one lake in one load: the first (the caller sorts by mentions)
      // is the row; the rest are counted, never written over it.
      if (seen.has(askKey)) {
        counts.duplicate++;
        continue;
      }
      seen.add(askKey);
      const lake = incoming.waterBodyId ? await listed(incoming.waterBodyId) : null;
      const candidates: Doc<'waterBodies'>[] = [];
      for (const id of incoming.candidateBodyIds ?? []) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const body = await listed(id);
        if (body) candidates.push(body);
      }
      const fields = {
        name: cleaned.name,
        aliases: cleaned.aliases,
        messages: incoming.messages,
        skatedMessages: incoming.skatedMessages,
        states: incoming.states,
        parentName: incoming.parentName,
        candidateBodyIds: candidates.length > 0 ? candidates.map((b) => b._id) : undefined,
        candidateLabels: candidates.length > 0 ? candidates.map(lakeLabel) : undefined,
        alreadyNamed: incoming.alreadyNamed || undefined,
      };
      const existing = await ctx.db
        .query('corpusPlaceNames')
        .withIndex('by_ask_key', (q) => q.eq('askKey', askKey))
        .first();
      if (!existing) {
        counts.created++;
        if (write) {
          await ctx.db.insert('corpusPlaceNames', {
            ...withoutUndefined(fields),
            askKey,
            ...(lake ? { waterBodyId: lake._id, lakeLabel: lakeLabel(lake) } : {}),
            status: 'open',
            ...(campaignId !== undefined ? { lastCampaignId: campaignId } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        continue;
      }
      if (existing.status !== 'open') {
        counts.decidedHeld++;
        continue;
      }
      // A lake a moderator chose stays chosen; the corpus's own lake fills only an empty one.
      const lakeFields =
        existing.waterBodyId === undefined && lake
          ? { waterBodyId: lake._id, lakeLabel: lakeLabel(lake) }
          : {};
      const same =
        Object.keys(lakeFields).length === 0 &&
        (Object.keys(fields) as (keyof typeof fields)[]).every(
          (key) => JSON.stringify(existing[key]) === JSON.stringify(fields[key]),
        );
      if (same) counts.unchanged++;
      else counts.refreshed++;
      // Stamped even when nothing else moved, so the latest run's names are the ones it carries.
      if (write) {
        await ctx.db.patch(existing._id, {
          ...fields,
          ...lakeFields,
          ...(campaignId !== undefined ? { lastCampaignId: campaignId } : {}),
          ...(same ? {} : { updatedAt: now }),
        });
      }
    }
    return counts;
  },
});

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Moderator: the triage page — names in one status, most mentioned first, each with its lake (or
 * the lakes it might be on) by the label stored with it. `minMessages` hides the long tail of names
 * one email used. Reads no lakes: a giant's polygon on every reactive re-run is the read the labels
 * exist to avoid.
 */
export const listQueue = query({
  args: {
    status: v.optional(literals(CORPUS_NAME_STATUSES)),
    minMessages: v.optional(v.number()),
  },
  handler: async (ctx, { status, minMessages }) => {
    await requireRole(ctx, 'moderator');
    const rows = await ctx.db
      .query('corpusPlaceNames')
      .withIndex('by_status_messages', (q) =>
        q.eq('status', status ?? 'open').gte('messages', minMessages ?? 0),
      )
      .order('desc')
      .take(QUEUE_CAP);
    const out = rows.map((row) => ({
      _id: row._id,
      name: row.name,
      aliases: row.aliases,
      messages: row.messages,
      skatedMessages: row.skatedMessages,
      states: row.states,
      status: row.status,
      ...(row.parentName !== undefined ? { parentName: row.parentName } : {}),
      ...(row.waterBodyId !== undefined
        ? { lake: { _id: row.waterBodyId, label: row.lakeLabel ?? 'A lake' } }
        : {}),
      candidates: (row.candidateBodyIds ?? []).map((id, i) => ({
        _id: id,
        label: row.candidateLabels?.[i] ?? 'A lake',
      })),
      ...(row.alreadyNamed ? { alreadyNamed: true } : {}),
      ...(row.landmarkId !== undefined ? { landmarkId: row.landmarkId } : {}),
      ...(row.dismissReason !== undefined ? { dismissReason: row.dismissReason } : {}),
      ...(row.dismissNote !== undefined ? { dismissNote: row.dismissNote } : {}),
    }));
    return { rows: out, capped: rows.length === QUEUE_CAP };
  },
});

/** Moderator: the open names on one lake — the lake editor's Landmarks card places them. */
export const openForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireRole(ctx, 'moderator');
    const rows = await ctx.db
      .query('corpusPlaceNames')
      .withIndex('by_water_body_status', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('status', 'open'),
      )
      .take(QUEUE_CAP);
    return rows
      .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name))
      .map((row) => ({
        _id: row._id,
        name: row.name,
        aliases: row.aliases,
        messages: row.messages,
        skatedMessages: row.skatedMessages,
        ...(row.alreadyNamed ? { alreadyNamed: true } : {}),
      }));
  },
});

async function openRow(ctx: QueryCtx, id: Id<'corpusPlaceNames'>) {
  const row = await ctx.db.get(id);
  if (!row) throw new ConvexError('That name is no longer in the queue');
  if (row.status !== 'open') throw new ConvexError(`"${row.name}" has already been decided`);
  return row;
}

/** Moderator: say which lake a name is on — it then waits on that lake's editor to be placed. */
export const setLake = mutation({
  args: { id: v.id('corpusPlaceNames'), waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { id, waterBodyId }) => {
    await requireContributorRole(ctx, 'moderator');
    const row = await openRow(ctx, id);
    const body = await ctx.db.get(waterBodyId);
    if (!body || !isListed(body)) throw new ConvexError('That lake is not on the map');
    await ctx.db.patch(row._id, { waterBodyId, lakeLabel: lakeLabel(body), updatedAt: Date.now() });
  },
});

/** Moderator: this name is not a landmark — with a reason, so the next person sees why. */
export const dismiss = mutation({
  args: {
    id: v.id('corpusPlaceNames'),
    reason: literals(CORPUS_NAME_DISMISS_REASONS),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, reason, note }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await openRow(ctx, id);
    const trimmed = note?.trim();
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: 'dismissed',
      dismissReason: reason,
      ...(trimmed ? { dismissNote: trimmed.slice(0, 280) } : {}),
      decidedByUserId: actor._id,
      decidedAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      actor._id,
      'remove',
      row,
      `Dismissed "${row.name}": ${reason}${trimmed ? ` — ${trimmed}` : ''}`.slice(0, 400),
      { reason },
    );
  },
});

/** Moderator: put a dismissed name back in the queue. */
export const reopen = mutation({
  args: { id: v.id('corpusPlaceNames') },
  handler: async (ctx, { id }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError('That name is no longer in the queue');
    if (row.status !== 'dismissed') throw new ConvexError('Only a dismissed name can be reopened');
    await ctx.db.patch(row._id, {
      status: 'open',
      dismissReason: undefined,
      dismissNote: undefined,
      decidedByUserId: undefined,
      decidedAt: undefined,
      updatedAt: Date.now(),
    });
    await audit(ctx, actor._id, 'restore', row, `Reopened "${row.name}"`);
  },
});

/**
 * Moderator: the name is a landmark already on the map, spelled differently ("Isle LaMotte" for
 * Isle La Motte). Its spellings join the landmark's, its count joins the prominence, and it is placed.
 */
export const fileAsSpelling = mutation({
  args: { id: v.id('corpusPlaceNames'), landmarkId: v.id('bodyLandmarks') },
  handler: async (ctx, { id, landmarkId }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const row = await openRow(ctx, id);
    const landmark = await ctx.db.get(landmarkId);
    if (!landmark || landmark.removedAt !== undefined) {
      throw new ConvexError('That landmark is no longer on the map');
    }
    if (row.waterBodyId !== undefined && row.waterBodyId !== landmark.waterBodyId) {
      throw new ConvexError('That landmark is on another lake');
    }
    const now = Date.now();
    const names = normalizeLandmarkNames(landmark.name, [
      ...landmark.aliases,
      row.name,
      ...row.aliases,
    ]);
    const aliases = names?.aliases ?? landmark.aliases;
    // The spelling must land: a landmark already at its spelling cap would drop it silently, and
    // the name would leave the queue with nothing to show for it.
    const carries = [landmark.name, ...aliases].some(
      (n) => landmarkNameKey(n) === landmarkNameKey(row.name),
    );
    if (!carries) {
      throw new ConvexError(
        `"${landmark.name}" already carries as many spellings as a landmark keeps — edit it to make room`,
      );
    }
    // The checks an edit runs: never a bay's name, never the same place as another landmark.
    await assertNotABayName(ctx, landmark.waterBodyId, [row.name, ...row.aliases]);
    assertNotDuplicate(
      await landmarksForBody(ctx, landmark.waterBodyId),
      { ...landmark, aliases },
      landmark._id,
    );
    await ctx.db.patch(landmark._id, {
      aliases,
      corpusMessages: Math.max(landmark.corpusMessages ?? 0, row.messages),
      moderatorEditedAt: now,
      updatedAt: now,
    });
    await auditLandmark(ctx, actor._id, 'edit_landmark', landmark._id, `Spelled "${row.name}"`, {
      corpusName: row.name,
    });
    await ctx.db.patch(row._id, {
      status: 'placed',
      waterBodyId: landmark.waterBodyId,
      landmarkId: landmark._id,
      decidedByUserId: actor._id,
      decidedAt: now,
      updatedAt: now,
    });
  },
});
