/**
 * Content-flag functions (D32/D3). Any active user can flag a report / comment / photo / user for
 * abuse. `unsafe_false_report` is a **first-class** reason: a dangerously false "ice is great" claim
 * is a safety incident, not mere spam (D3) — it lands in the admin flag queue's priority lane later
 * (Phase 7). No queue UI here; rows accrue as `contentFlags` the founder reads via the Convex
 * dashboard for now.
 */

import { accessReportGateMessage } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { FLAG_REASONS, FLAG_TARGET_TYPES } from './lib/enums';
import { literals } from './lib/validators';

/** The table each flag target type refers to — used to validate the target actually exists. */
const TARGET_TABLE: Record<(typeof FLAG_TARGET_TYPES)[number], TableNames> = {
  report: 'reports',
  comment: 'comments',
  photo: 'photos',
  user: 'profiles',
  hazard: 'hazards', // Phase 9 (D51) — mods can hide a bad pin
  // N6d (D73). The one user-supplied free-text surface in the access layer, and the only part of it a
  // flag can reach: a bogus "gate locked" on a lake somebody wants to themselves is exactly the abuse
  // this queue exists for. Access **photos** flag as `photo` like every other image, unchanged.
  accessAlert: 'accessAlerts',
  // N6f — the first target that is a *place*. "There is no lawful way onto this water" is a claim
  // many people can independently make about the same lake, and the per-(flagger, target) dedup below
  // turns that into a free corroboration count: N open rows is N distinct people.
  waterbody: 'waterBodies',
};

/**
 * Flag content for abuse/safety review (D32). `requireProfile`; the target must exist; deduped to
 * **one open flag per (flagger, target)** — a repeat flag returns the existing open row rather than
 * piling up duplicates. Resolution + the priority-lane queue are Phase 7.
 */
export const flag = mutation({
  args: {
    targetType: literals(FLAG_TARGET_TYPES),
    targetId: v.string(),
    reason: literals(FLAG_REASONS),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);

    // Validate the target exists (and that targetId is a real id for its table).
    const table = TARGET_TABLE[args.targetType];
    const targetId = ctx.db.normalizeId(table, args.targetId);
    if (!targetId) throw new ConvexError('Target not found');
    const target = await ctx.db.get(targetId as Id<TableNames>);
    if (!target) throw new ConvexError('Target not found');

    // ── The N6f re-reporting gate ────────────────────────────────────────────────────────────────
    //
    // Once a moderator has ruled that a body *does* have public access, reporting it again takes a
    // note saying what changed. Not a block: land is sold and gates go up, and a body public in 2026
    // may not be in 2029, so a permanent refusal would eventually be wrong and leave the person who
    // just got turned away with nowhere to go. But a settled question that can be re-asked with one
    // tap is a question that never stays settled — one sentence is the whole cost, and it is only
    // charged to the second reporter.
    if (args.targetType === 'waterbody' && args.reason === 'no_public_access') {
      const body = target as Doc<'waterBodies'>;
      if (body.publicAccess?.verdict === 'open' && !args.note?.trim()) {
        throw new ConvexError(accessReportGateMessage(body.publicAccess));
      }
    }

    // Dedupe: one *open* flag per (flagger, target). A repeat flag is a no-op that returns the row.
    const existing = await ctx.db
      .query('contentFlags')
      .withIndex('by_target', (q) =>
        q.eq('targetType', args.targetType).eq('targetId', args.targetId),
      )
      .filter((q) => q.eq(q.field('flaggerId'), profile._id))
      .filter((q) => q.eq(q.field('status'), 'open'))
      .first();
    if (existing) return existing._id;

    const flagId = await ctx.db.insert('contentFlags', {
      flaggerId: profile._id,
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason,
      ...(args.note !== undefined ? { note: args.note } : {}),
      status: 'open',
      createdAt: Date.now(),
    });

    // Safety-priority alert (D38/D3): a dangerously-false "ice is great" flag is a safety incident, not
    // FIFO spam — email the founder to the priority lane. Fire-and-forget; no-ops without Resend keys.
    if (args.reason === 'unsafe_false_report') {
      await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
        subject: 'Safety flag: unsafe false report',
        heading: 'New safety flag · unsafe false report',
        lines: [
          `A ${args.targetType} was flagged as a dangerously false report.`,
          'Review it in the priority lane.',
        ],
        deepLinkPath: '/admin/flags',
      });
    }
    return flagId;
  },
});

/**
 * The bodies *this viewer* has an open `no_public_access` report on (N6f).
 *
 * **What it powers: you see your own claim.** An unconfirmed report changes nothing on anyone else's
 * map — otherwise one account could dim any lake in the corpus until a human got to it — but the
 * person who filed it sees the lake faded immediately, as though it were already confirmed. That is
 * honest rather than merely optimistic: the fade reflects a fact about *their* claim, and it is the
 * only feedback that a report went anywhere.
 *
 * Bounded by how many lakes one person has been turned away from, so it needs no cap. Returns `[]`
 * rather than throwing when signed out — the map renders for anonymous visitors.
 */
export const myAccessFlags = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const rows = await ctx.db
      .query('contentFlags')
      .withIndex('by_flagger', (q) => q.eq('flaggerId', profile._id))
      .collect();
    return rows
      .filter(
        (row) =>
          row.status === 'open' &&
          row.targetType === 'waterbody' &&
          row.reason === 'no_public_access',
      )
      .map((row) => row.targetId);
  },
});
