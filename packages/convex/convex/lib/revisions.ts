/**
 * Author edits keep their history (A10-3, founder call 2026-09-21): before `posts.update` or
 * `reports.update` patches a row, the content block as it stood is written to `contentRevisions`.
 * The live row is always the latest; the rows here are what it used to say, for a moderator who
 * wants to know whether an edit changed a claim. The card only ever shows *Edited* (off
 * `editedAt`); nothing here is rendered to a skater.
 *
 * The snapshot is the **content** fields only — what the author can change through the sheet —
 * never the stamps (`authorId`, `postId`, `moderationStatus`, the place label, the bay join), which
 * are the server's and are not what an edit is about.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** The words of a Post, as they stood. */
export interface PostSnapshot {
  title?: string;
  body?: string;
}

/** The content block of a Report, as it stood — the same fields `reports.update` overwrites. */
export type ReportSnapshot = Pick<
  Doc<'reports'>,
  | 'point'
  | 'putInId'
  | 'skateEndTime'
  | 'skateStartTime'
  | 'skateEndPrecision'
  | 'observedFrom'
  | 'sighting'
  | 'iceTypes'
  | 'surfaceTags'
  | 'skateQuality'
  | 'suitability'
  | 'iceThickness'
  | 'snow'
  | 'conditions'
  | 'notes'
  | 'showPutIn'
  | 'photoIds'
>;

const REPORT_CONTENT_KEYS = [
  'point',
  'putInId',
  'skateEndTime',
  'skateStartTime',
  'skateEndPrecision',
  'observedFrom',
  'sighting',
  'iceTypes',
  'surfaceTags',
  'skateQuality',
  'suitability',
  'iceThickness',
  'snow',
  'conditions',
  'notes',
  'showPutIn',
  'photoIds',
] as const satisfies readonly (keyof ReportSnapshot)[];

/** The content block of a Report row, `undefined` fields dropped so the snapshot is exactly what was set. */
export function reportSnapshotOf(report: Doc<'reports'>): ReportSnapshot {
  const out: Partial<ReportSnapshot> = {};
  for (const key of REPORT_CONTENT_KEYS) {
    const value = report[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out as ReportSnapshot;
}

export function postSnapshotOf(post: Doc<'posts'>): PostSnapshot {
  return {
    ...(post.title !== undefined ? { title: post.title } : {}),
    ...(post.body !== undefined ? { body: post.body } : {}),
  };
}

/** Record what a row said before this edit. Called before the patch, in the same transaction. */
export async function recordRevision(
  ctx: MutationCtx,
  target:
    | { targetType: 'post'; targetId: Id<'posts'>; snapshot: PostSnapshot }
    | { targetType: 'report'; targetId: Id<'reports'>; snapshot: ReportSnapshot },
  authorId: Id<'profiles'>,
  now: number,
): Promise<Id<'contentRevisions'>> {
  return ctx.db.insert('contentRevisions', {
    targetType: target.targetType,
    targetId: target.targetId,
    authorId,
    snapshot: target.snapshot,
    replacedAt: now,
  });
}
