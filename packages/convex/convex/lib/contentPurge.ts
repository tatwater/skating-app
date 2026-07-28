/**
 * Redacting a departed skater's aged content (D62 second amendment / N5a decision 5).
 *
 * **The rule, and the one it replaces.** The first amendment said a departed user's content is
 * *erased* at 30 days. That was wrong in a way that only showed up once its consequences were
 * followed through, and the founder's correction (2026-07-27, round three) is what this file now
 * implements:
 *
 * > A departed skater's **private artifacts are erased**. Their **published observations are kept**,
 * > anonymized, with every free-text field cleared at `DEPARTED_CONTENT_MAX_AGE_MS`.
 *
 * The distinction the erasure rule missed is between **what a person typed** and **what they
 * observed**. A name, a home coordinate, a bio, `reports.notes`, `hazards.description`, a photo
 * caption, a raw unpublished trace — those are theirs, and erasing them is the respectful default. A
 * coordinate, an ice type, a thickness reading, a hazard geometry and a date are not facts about a
 * person at all once the author pointer is a tombstone. They are the ice record, and deleting them
 * takes something from the next skater without giving anything back to the one who left.
 *
 * Three things fall out of this that are worth knowing before reading the code:
 *
 * **1. There is no report cascade any more.** The old file's centrepiece was `deleteReport`, which had
 * to answer for seven tables pointing at one report — comments, activities, bounty arrays, flags,
 * derived hazards, put-ins, point events. None of that exists here, because nothing is deleted. The
 * hardest part of the old design was a consequence of a decision that has been reversed.
 *
 * **2. Put-in preservation is gone, and that is the fix rather than a regression.** The previous pass
 * discovered that *"put-ins survive"* was false in the code — derived markers are recomputed from live
 * reports, so erasing the reports erased the access points — and fixed it by materializing a `putIns`
 * row before deleting the report. With reports kept, the report *is* the preservation: `listForBody`
 * keeps deriving the marker the way it does for everybody else. The stored-row reader in `putIns` is
 * deliberately left in place; rows written by the old path still exist on dev.
 *
 * **3. Everything here paginates, and exactly one category runs per call.** Redaction *keeps* the row
 * it touches, so — unlike a pure delete — the query does not shrink under a repeated first-page read.
 * Re-`take()`ing would re-read the same page forever and never reach row N+1. The previous
 * implementation had exactly this bug for hazards, where the index orders by water body rather than by
 * time, so a prolific reporter's hazards past the first page were never swept at all.
 *
 * So every category carries a cursor — and Convex allows **one `.paginate()` per function execution**,
 * which is what makes "one category per call" a hard requirement rather than a style choice. Each pass
 * picks the first unfinished category, advances it by one page, and hands back a token saying where
 * everything stands. The callers stay single-cursor and just keep re-running until `more` is false.
 *
 * **4. The age cutoff is for the ghost window only. Finalization ignores it** (`final: true`, added
 * 2026-07-27 after a walkthrough found three bugs sharing one cause). While an account is pending, the
 * cutoff is the promise being kept: your words come off as they age past the line, and the sweep re-runs
 * so that keeps being true. At finalization the cutoff becomes actively wrong, because **the finalize
 * pass is the last one that will ever run** — `writeTombstone` clears `deletionRequestedAt`, which drops
 * the row out of `by_deletion_requested_at`, and no cron can reach it again. Anything the age gate skips
 * on that pass is kept forever.
 *
 * Three ways that bit, all fixed by the same flag:
 *
 * - **Hazards.** Aged on `lastConfirmedAt`, which *other people* keep moving. A ridge confirmed by
 *   somebody else last week is not due, so its description survived the tombstone permanently — and
 *   that's the common case, not the corner: a hazard the community is actively maintaining is exactly
 *   the one whose clock keeps getting pushed forward.
 * - **`finalizeNow`.** The operator escape hatch stamps and finalizes in the same instant, so the
 *   cutoff sat 30 days in the past and *nothing* was due. The one path meaning "remove me right now"
 *   redacted the least.
 * - **Future skate times.** `SKATE_TIME_FUTURE_TOLERANCE_MS` lets a report be filed up to an hour
 *   ahead, so "a ghost's newest `skateEndTime` can't postdate their request" was true ±1h, and the
 *   overhang was never due.
 *
 * In `final` mode the reports query also drops its range bound rather than widening it — `authorId` is
 * an equality read and is the bound that matters. There is no `Infinity` to pass and no unbounded scan
 * introduced; the query is exactly "this author's rows", which is what a finalization means.
 */

import { DEPARTED_CONTENT_MAX_AGE_MS } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { deletePhotoAndBlobs, referencedPhotoIds } from './photoOrphans';

/** Rows of any one kind touched per pass. Small: every caller re-runs until `more` is false. */
export const REDACT_PAGE = 100;

/** The cutoff: free text written before this is cleared, and private leftovers before it are erased. */
export function redactCutoff(now: number): number {
  return now - DEPARTED_CONTENT_MAX_AGE_MS;
}

/**
 * What a pass can work on, **in the order it works on them**. One category advances per call, and the
 * first unfinished one wins — so this order is the priority order, not decoration. Free text first,
 * because that's the part with a promise attached to it; the private leftovers can wait a tick.
 */
const CATEGORIES = [
  'reports',
  'hazards',
  'comments',
  'flags',
  'photos',
  'recordings',
  'bounties',
] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * Where each category got to, bundled into one token.
 *
 * Three states, encoded in the JSON rather than in a parallel flag set, because a resumed job has to
 * tell "not started" from "finished" and a bare string can't:
 *
 * - **absent** — this category hasn't run yet;
 * - **a string** — resume from here;
 * - **`null`** — done, skip it.
 *
 * `JSON.stringify` drops `undefined` keys and keeps `null`, which is exactly that encoding for free.
 */
type RedactCursors = Partial<Record<Category, string | null>>;

/** What `bounties` parks in its slot: it pages by shrinking `.take()`, so it has no real cursor. */
const MORE = 'more';

function decodeCursors(blob: string | undefined): RedactCursors {
  if (blob === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(blob);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RedactCursors) : {};
  } catch {
    // An unreadable token means starting over, which is safe: every operation here is idempotent.
    return {};
  }
}

export interface RedactionResult {
  /** Another pass is needed — at least one category has more rows. */
  more: boolean;
  /** The continuation token for the next pass; absent when there is nothing left to do. */
  cursor?: string;
  /** Rows whose free text was cleared — kept, anonymized, still part of the ice record. */
  redacted: {
    reports: number;
    hazards: number;
    comments: number;
    flags: number;
    photos: number;
  };
  /** Rows removed outright — private, unpublished, or a standing ask nobody is making any more. */
  erased: { bounties: number; recordings: number; photos: number };
}

const EMPTY: Omit<RedactionResult, 'more' | 'cursor'> = {
  redacted: { reports: 0, hazards: 0, comments: 0, flags: 0, photos: 0 },
  erased: { bounties: 0, recordings: 0, photos: 0 },
};

/** How one pass is scoped. See the `final` note in the file header — it is the load-bearing one. */
export interface RedactOptions {
  /** Rows of any one kind touched per pass; defaults to {@link REDACT_PAGE}. */
  pageSize?: number;
  /** Continuation token handed back by the previous pass. */
  cursor?: string;
  /**
   * **Finalization: ignore the age cutoff and clear everything.** Set only by the finalize chain's
   * `redact` stage, which is the last pass that will ever run for this account — see the file header
   * for the three bugs the age gate caused there. During the ghost window this stays false, because
   * the cutoff is the promise being kept rather than an obstacle.
   */
  final?: boolean;
}

/** `page.isDone ? null : page.continueCursor` — the cursor encoding, in one place. */
function nextCursor(page: { isDone: boolean; continueCursor: string }): string | null {
  return page.isDone ? null : page.continueCursor;
}

/**
 * One bounded pass over everything a ghost owns.
 *
 * Re-run until `more` is false, threading `cursor` back in. Called at the deletion request, on every
 * sweep tick while the account is pending — content that was three days old at the request is
 * thirty-three days old three weeks later, so "the words are gone" has to keep being true rather than
 * describing one instant — and as a stage of the finalize chain, where it necessarily catches the rest.
 */
export async function redactAgedContent(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  now: number,
  opts: RedactOptions = {},
): Promise<RedactionResult> {
  const { pageSize = REDACT_PAGE, cursor: cursorBlob, final = false } = opts;
  const cutoff = redactCutoff(now);
  const cursors = decodeCursors(cursorBlob);
  const result = { ...EMPTY, redacted: { ...EMPTY.redacted }, erased: { ...EMPTY.erased } };

  /**
   * Is a row old enough to act on? The one place the `final` flag is read, so that "finalization
   * ignores the cutoff" is a single fact rather than a condition repeated in six loops — the shape of
   * bug that let hazards keep their descriptions forever while every other category looked correct.
   */
  const isDue = (timestamp: number): boolean => final || timestamp < cutoff;

  // The first category that hasn't finished. `null` means done; absent means never started, which is
  // why this reads `!== null` rather than truthiness — an empty-string cursor is a legal resume point.
  const category = CATEGORIES.find((c) => cursors[c] !== null);
  if (category === undefined) return { ...result, more: false };

  const cursor = cursors[category] ?? null;
  const next: RedactCursors = { [category]: await runCategory(category) };
  const merged = { ...cursors, ...next };
  const more = CATEGORIES.some((c) => merged[c] !== null);
  return { ...result, more, ...(more ? { cursor: JSON.stringify(merged) } : {}) };

  /**
   * Advance the chosen category by one page, returning where it got to.
   *
   * A closure rather than six free functions purely so the counters and the cutoff stay in scope
   * without threading a mutable result object through every signature; the switch is exhaustive over
   * `Category`, so adding one is a type error until it's handled here.
   */
  async function runCategory(which: Category): Promise<string | null> {
    switch (which) {
      case 'reports':
        return redactReports();
      case 'hazards':
        return redactHazards();
      case 'comments':
        return redactComments();
      case 'flags':
        return redactFlagNotes();
      case 'photos':
        return sweepPhotos();
      case 'recordings':
        return eraseRecordings();
      case 'bounties':
        return eraseBounties();
    }
  }

  // ── Reports: kept whole, minus the words ───────────────────────────────────────────────────────
  //
  // Bounded on **both** sides during the ghost window. The lower bound isn't decoration even though
  // `skateEndTime` is required here: the N3/N4 postmortem was exactly a bare upper bound on an
  // optional field, and a sweep over a departed account is the last query in this codebase that should
  // be one row-class wider than it means.
  //
  // In `final` mode the range goes away entirely rather than widening to some sentinel. That is not the
  // same shape of risk: `authorId` is an **equality** read, so the query is bounded to one account
  // either way, and "every row this author holds" is exactly what a finalization means. Widening the
  // range with a far-future number would be the version to worry about, because it would read like an
  // age bound while being none.
  async function redactReports(): Promise<string | null> {
    const page = await ctx.db
      .query('reports')
      .withIndex('by_author_skate_end_time', (q) => {
        const authored = q.eq('authorId', userId);
        return final ? authored : authored.lt('skateEndTime', cutoff);
      })
      .paginate({ cursor, numItems: pageSize });
    for (const report of page.page) {
      const patch = reportRedaction(report);
      if (patch === null) continue; // already clean — an idempotent re-run, or a report with no prose
      await ctx.db.patch(report._id, patch);
      result.redacted.reports++;
    }
    return nextCursor(page);
  }

  // ── Hazards: aged on `lastConfirmedAt`, not `firstReportedAt` ──────────────────────────────────
  //
  // The field matters more than it looks. A pressure ridge first reported forty days ago and
  // confirmed by six other skaters yesterday is the most current thing on that shore, and measuring
  // it from the *first* sighting would have stripped its description — and, under the old rule,
  // deleted it outright — while the community was still actively maintaining it. The clock a hazard
  // is judged by everywhere else in the app is the one it's judged by here.
  //
  // **And it is the one clock other people can push forward, which is why `final` exists.** During the
  // window, "kept while the community maintains it" is a real promise. At finalization it would have
  // become "kept forever, if anyone happened to confirm it recently" — no later pass can reach the row
  // once the tombstone drops it out of the pending index. `isDue` is unconditional there.
  //
  // Nothing about a hazard is erased. A hazard row is a point, a type and two dates; with the author
  // pointer tombstoned and the description gone there is no person left in it, and it is exactly the
  // multi-season record N5a's recurrence detection and `bodyFeatures` promotion are built on.
  async function redactHazards(): Promise<string | null> {
    const page = await ctx.db
      .query('hazards')
      .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', userId))
      .paginate({ cursor, numItems: pageSize });
    for (const hazard of page.page) {
      if (!isDue(hazard.lastConfirmedAt)) continue;
      if (hazard.description === undefined) continue;
      await ctx.db.patch(hazard._id, { description: undefined });
      result.redacted.hazards++;
    }
    return nextCursor(page);
  }

  // ── Comments: the shell stays, the words go ────────────────────────────────────────────────────
  //
  // Deleting the row would leave a hole in a conversation that isn't theirs — the thread UI is keyed
  // by `reportId` and a reply to a vanished parent is unreachable. So the row survives as a marked
  // shell rendered as "this comment was deleted" under the tombstone, which is honest about *why* it
  // is empty. `createdAt` is the clock, since a comment has no skate of its own.
  async function redactComments(): Promise<string | null> {
    const page = await ctx.db
      .query('comments')
      .withIndex('by_author', (q) => q.eq('authorId', userId))
      .paginate({ cursor, numItems: pageSize });
    for (const comment of page.page) {
      if (!isDue(comment.createdAt)) continue;
      if (comment.redactedAt !== undefined) continue; // idempotent re-run
      await ctx.db.patch(comment._id, { body: '', redactedAt: now });
      result.redacted.comments++;
    }
    return nextCursor(page);
  }

  // ── Flags: the row survives, the note doesn't ──────────────────────────────────────────────────
  //
  // A flag is about **content**, so it outlives its filer — that's the D62 seam, and it's why a
  // departed skater's block set is erased while their flags are kept. But `note` is free text *they
  // typed*, on the same side of the seam as `reports.notes`, and it was the one field the second
  // amendment's own rule missed. It is also the most likely place in the schema for one user's prose to
  // name **another** user ("this is the third time @someone has posted a fake reading"), which makes
  // retaining it after its author is gone the worst version of the oversight.
  //
  // What survives is everything a moderator needs: target, reason, status, counts, dates. The
  // structured `reason` is what the queue sorts and the 7b rollup counts; the prose was context.
  // `moderationActions.reason` — the operator's own words, on the audit trail — is a separate table and
  // is deliberately untouched.
  //
  // Aged on `createdAt`, like comments: a flag has no skate of its own.
  async function redactFlagNotes(): Promise<string | null> {
    const page = await ctx.db
      .query('contentFlags')
      .withIndex('by_flagger', (q) => q.eq('flaggerId', userId))
      .paginate({ cursor, numItems: pageSize });
    for (const flag of page.page) {
      if (!isDue(flag.createdAt)) continue;
      if (flag.note === undefined) continue; // already clean, or a flag filed without one
      await ctx.db.patch(flag._id, { note: undefined });
      result.redacted.flags++;
    }
    return nextCursor(page);
  }

  // ── Photos: published ones lose their caption, abandoned ones go ───────────────────────────────
  //
  // Whether a photo is referenced is decided by `lib/photoOrphans`, shared with the orphan-GC cron so
  // the two destructive paths can't drift apart on the definition — which they had, until this pass:
  // this sweep used to delete by age alone, so a photo uploaded before the 30-day line but attached to
  // a report inside it left a permanent hole in a public report. A `null` answer means the reference
  // scan hit its cap, and the page is kept whole: an orphan the cron sweeps later is cheaper than a
  // hole in the record.
  //
  // The caption is the only thing cleared. `coord` stays — where on the lake a photo was taken is ice
  // record, and it's what places the pin.
  async function sweepPhotos(): Promise<string | null> {
    const page = await ctx.db
      .query('photos')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', userId))
      .paginate({ cursor, numItems: pageSize });
    const referenced =
      page.page.length > 0 ? await referencedPhotoIds(ctx, userId) : new Set<string>();
    if (referenced === null) {
      console.warn(
        `contentPurge: reference scan for ${userId} hit its cap — keeping this page of photos for the orphan GC cron rather than guessing`,
      );
      return nextCursor(page);
    }
    for (const photo of page.page) {
      if (!isDue(photo.createdAt)) continue;
      if (!referenced.has(photo._id)) {
        if (await deletePhotoAndBlobs(ctx, photo)) result.erased.photos++;
        continue;
      }
      if (photo.caption === undefined) continue;
      await ctx.db.patch(photo._id, { caption: undefined });
      result.redacted.photos++;
    }
    return nextCursor(page);
  }

  // ── Unpublished recordings: erased ─────────────────────────────────────────────────────────────
  //
  // D58 gate (1), *publish-is-consent*, reused: an activity with no linked report is a recording the
  // person never shared, so it goes with the private bucket. A linked one is already drawn on the lake
  // and is kept — severed from their identity by the finalize `tracks` stage.
  async function eraseRecordings(): Promise<string | null> {
    const page = await ctx.db
      .query('gpsActivities')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .paginate({ cursor, numItems: pageSize });
    for (const activity of page.page) {
      if (activity.linkedReportId !== undefined) continue; // published — its report owns its lifetime
      if (!isDue(activity.endTime ?? activity.startTime)) continue;
      await ctx.db.delete(activity._id);
      result.erased.recordings++;
    }
    return nextCursor(page);
  }

  // ── Bounties: erased, all of them, regardless of age ───────────────────────────────────────────
  //
  // The one category that isn't a record of anything. A bounty is a *standing ask* — "has anyone been
  // on this lake?" — and there is no longer anybody asking, so leaving it open would collect answers
  // for nobody. Erased at the **request** rather than at finalize for the same reason: a ghost stops
  // asking the moment they leave.
  //
  // The only pure delete left, so it needs no real cursor: the query shrinks under it, and a repeated
  // first-page read walks forward on its own. Its slot carries a flag instead — `MORE` while a page
  // came back full, `null` once one didn't.
  async function eraseBounties(): Promise<string | null> {
    const bounties = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) => q.eq('requesterId', userId))
      .take(pageSize);
    for (const bounty of bounties) await ctx.db.delete(bounty._id);
    result.erased.bounties = bounties.length;
    return bounties.length >= pageSize ? MORE : null;
  }
}

/**
 * The free text on one report, or `null` if there is none left to clear.
 *
 * Two fields, and the second is the easy one to miss: every thickness reading carries its own `note`
 * ("through the ridge, water in the hole"), which is prose in a nested array rather than a column.
 * The readings themselves stay — a measurement is the single most valuable thing in a report.
 */
function reportRedaction(report: Doc<'reports'>): Partial<Doc<'reports'>> | null {
  const readings = report.iceThickness?.readings ?? [];
  const hasReadingNotes = readings.some((r) => r.note !== undefined);
  if (report.notes === undefined && !hasReadingNotes) return null;
  return {
    notes: undefined,
    ...(hasReadingNotes
      ? {
          iceThickness: {
            ...report.iceThickness,
            readings: readings.map(({ note: _dropped, ...rest }) => rest),
          },
        }
      : {}),
  };
}
