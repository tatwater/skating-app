/**
 * Photos shared to Gli from another app (A10-8 §8.7, founder call 2026-09-28): where they land. A
 * share is the person choosing photos, like a pick, so it opens a report — and if the open sheet
 * already has something in it, one question first: *add them to this report*, or *start a new
 * one*. Pure, so the phone's glue only reads files and asks.
 *
 * On a new report the photos say what they can and decide nothing: the latest capture time is a
 * **ghost** end-time chip (D188 — a suggestion, never selected, never serialized until tapped),
 * and a photo taken on a lake the device knows names the lake, as the tab's own GPS fix does.
 * Added to an open sheet, a photo goes to the Report its time says, else to the one on screen: the
 * phone has no pool (A10-7 delta 3), so every photo has a lake the moment it lands.
 */

import { assignPhoto } from './photoAssignment';
import { assignCandidates, type PostSheet } from './postSheet';
import type { ReportSheetState } from './reportSheet';
import { sheetReducer } from './reportSheet';

/** Open a new report, or ask first because the open sheet has something in it? */
export function shareLanding(open: PostSheet | null): 'new' | 'ask' {
  if (open === null) return 'new';
  return open.dirty || open.door === 'draft' || open.mode.kind === 'edit' ? 'ask' : 'new';
}

/**
 * The Report a shared photo joins on the open sheet: the one whose window its time falls in, else
 * the one on screen, else the first.
 */
export function shareReportFor(
  post: PostSheet,
  photo: { takenAtMs?: number },
  onScreenReportId: string | undefined,
): string | undefined {
  // Time only: a lake's box is not at hand here, and a wrong lake by place is worse than the tab.
  const byTime =
    photo.takenAtMs !== undefined
      ? assignPhoto({ takenAtMs: photo.takenAtMs }, assignCandidates(post, {}))
      : null;
  if (byTime) return byTime.reportId;
  if (onScreenReportId !== undefined && post.reports.some((r) => r.id === onScreenReportId)) {
    return onScreenReportId;
  }
  return post.reports[0]?.id;
}

/** The end time the photos suggest: the latest capture, never in the future. */
export function photosEndSuggestion(
  photos: readonly { takenAtMs?: number }[],
  nowMs: number,
): number | undefined {
  const times = photos
    .map((p) => p.takenAtMs)
    .filter((t): t is number => t !== undefined && Number.isFinite(t) && t <= nowMs);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/** The photos' end time on a Report's sheet, as a ghost the author may tap (D188). */
export function suggestEndFromPhotos(sheet: ReportSheetState, ms: number): ReportSheetState {
  return sheetReducer(sheet, {
    type: 'suggest',
    field: 'endTime',
    source: 'photos',
    values: [{ key: 'photos', value: { ms, precision: 'minute' } }],
  });
}
