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
import { auditLandmark } from './lib/landmarkRows';
import { isListed } from './lib/listing';
import { literals } from './lib/validators';

/** How many rows the triage page reads — the whole first load is 237; a backlog past this pages. */
const QUEUE_CAP = 400;

/** The name's key on its lake — the load's upsert key, so a re-load refreshes rather than repeats. */
function askKeyOf(name: string, waterBodyId?: string, parentName?: string): string {
  return `${landmarkNameKey(name)}|${waterBodyId ?? (parentName ? landmarkNameKey(parentName) : '')}`;
}

async function audit(
  ctx: Parameters<typeof auditLandmark>[0],
  actorId: Id<'profiles'>,
  action: 'remove' | 'restore',
  row: Doc<'corpusPlaceNames'>,
  reason: string,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
    action,
    targetType: 'corpusPlaceName',
    targetId: row._id,
    reason,
    metadata: { name: row.name, ...(row.waterBodyId ? { waterBodyId: row.waterBodyId } : {}) },
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
});

/**
 * Load the landmark pass's leftovers — **dry unless `dryRun: false`**. A new name is inserted open;
 * an open one gets this run's counts and spellings; a placed or dismissed one is left as a moderator
 * left it. A lake id that no longer exists is dropped (the name still loads, for a person to place).
 */
export const importBatch = internalMutation({
  args: {
    names: v.array(importedName),
    campaignId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { names, campaignId, dryRun }) => {
    const counts = { created: 0, refreshed: 0, unchanged: 0, decidedHeld: 0 };
    const now = Date.now();
    for (const incoming of names) {
      const cleaned = normalizeLandmarkNames(incoming.name, incoming.aliases);
      if (!cleaned) continue;
      const waterBodyId =
        incoming.waterBodyId && (await ctx.db.get(incoming.waterBodyId))
          ? incoming.waterBodyId
          : undefined;
      const candidateBodyIds = [];
      for (const id of incoming.candidateBodyIds ?? []) {
        if (await ctx.db.get(id)) candidateBodyIds.push(id);
      }
      const askKey = askKeyOf(cleaned.name, waterBodyId, incoming.parentName);
      const fields = {
        name: cleaned.name,
        aliases: cleaned.aliases,
        messages: incoming.messages,
        skatedMessages: incoming.skatedMessages,
        states: incoming.states,
        ...(incoming.parentName !== undefined ? { parentName: incoming.parentName } : {}),
        ...(candidateBodyIds.length > 0 ? { candidateBodyIds } : {}),
        ...(campaignId !== undefined ? { lastCampaignId: campaignId } : {}),
      };
      const existing = await ctx.db
        .query('corpusPlaceNames')
        .withIndex('by_ask_key', (q) => q.eq('askKey', askKey))
        .first();
      if (!existing) {
        counts.created++;
        if (dryRun === false) {
          await ctx.db.insert('corpusPlaceNames', {
            ...fields,
            askKey,
            ...(waterBodyId !== undefined ? { waterBodyId } : {}),
            status: 'open',
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
      const same =
        existing.messages === fields.messages &&
        existing.skatedMessages === fields.skatedMessages &&
        existing.aliases.join('|') === fields.aliases.join('|');
      if (same) {
        counts.unchanged++;
        continue;
      }
      counts.refreshed++;
      if (dryRun === false) await ctx.db.patch(existing._id, { ...fields, updatedAt: now });
    }
    return counts;
  },
});

/** A lake as the queue shows it: enough to recognize and link it. */
async function lakeOf(
  ctx: QueryCtx,
  id: Id<'waterBodies'>,
  cache: Map<string, { _id: Id<'waterBodies'>; name: string; states: string[] } | null>,
) {
  if (cache.has(id)) return cache.get(id) ?? null;
  const body = await ctx.db.get(id);
  const lake = body
    ? { _id: body._id, name: body.name ?? 'Unnamed water', states: body.states ?? [] }
    : null;
  cache.set(id, lake);
  return lake;
}

/**
 * Moderator: the triage page — names in one status, most mentioned first, each with its lake (or
 * the lakes it might be on) by name. `minMessages` hides the long tail of names one email used.
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
    const lakes = new Map<
      string,
      { _id: Id<'waterBodies'>; name: string; states: string[] } | null
    >();
    const out = [];
    for (const row of rows) {
      const lake = row.waterBodyId ? await lakeOf(ctx, row.waterBodyId, lakes) : null;
      const candidates = [];
      for (const id of row.candidateBodyIds ?? []) {
        const candidate = await lakeOf(ctx, id, lakes);
        if (candidate) candidates.push(candidate);
      }
      out.push({
        _id: row._id,
        name: row.name,
        aliases: row.aliases,
        messages: row.messages,
        skatedMessages: row.skatedMessages,
        states: row.states,
        status: row.status,
        ...(row.parentName !== undefined ? { parentName: row.parentName } : {}),
        ...(lake ? { lake } : {}),
        candidates,
        ...(row.landmarkId !== undefined ? { landmarkId: row.landmarkId } : {}),
        ...(row.dismissReason !== undefined ? { dismissReason: row.dismissReason } : {}),
        ...(row.dismissNote !== undefined ? { dismissNote: row.dismissNote } : {}),
      });
    }
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
    await ctx.db.patch(row._id, {
      waterBodyId,
      askKey: askKeyOf(row.name, waterBodyId, row.parentName),
      updatedAt: Date.now(),
    });
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
    await audit(ctx, actor._id, 'remove', row, trimmed || `Dismissed "${row.name}": ${reason}`);
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
    await ctx.db.patch(landmark._id, {
      aliases: names?.aliases ?? landmark.aliases,
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
