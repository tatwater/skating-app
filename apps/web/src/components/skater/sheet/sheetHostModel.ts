/**
 * The report sheet's host, as pure rules (B03 §5, D242): which door a `?post=` link opens, what the
 * URL becomes when the sheet closes, which `report_sheet_opened` entry an open counts as, when
 * leaving asks first, and the abandonment marker a closed tab leaves for the next open.
 *
 * Nothing here touches React, the router or storage directly, so every rule is a unit test.
 */

import type { PostDraft, PostSheet } from '@skating/core';
import { postCreateSent } from '@skating/core';
import type { ReportSheetEntry } from '@/lib/analytics';
import { POST_NEW, type SkaterRootSearch } from '@/lib/skaterSearch';

/** What the root params ask for: nothing, a new report (perhaps on a lake), or an edit. */
export type SheetDoor =
  | { kind: 'none' }
  | { kind: 'new'; waterBodyId?: string }
  | { kind: 'edit'; reportId: string };

export function sheetDoorOf(search: SkaterRootSearch): SheetDoor {
  if (search.post === undefined) return { kind: 'none' };
  if (search.post === POST_NEW) {
    return search.postBody !== undefined
      ? { kind: 'new', waterBodyId: search.postBody }
      : { kind: 'new' };
  }
  return { kind: 'edit', reportId: search.post };
}

/** The door's identity, so an open answers it once (and a second door is a second open). */
export function doorKey(door: SheetDoor): string {
  if (door.kind === 'none') return '';
  if (door.kind === 'edit') return `edit:${door.reportId}`;
  return `new:${door.waterBodyId ?? ''}`;
}

/** `sheetDoors`' params for the door — the console's old `?body=` / `?edit=` shape. */
export function webDoorParams(door: SheetDoor): { body?: string; edit?: string } {
  if (door.kind === 'edit') return { edit: door.reportId };
  if (door.kind === 'new' && door.waterBodyId !== undefined) return { body: door.waterBodyId };
  return {};
}

/** The old console's `/post?body=&edit=` as the root params it redirects to (D242). */
export function postRedirectSearch(old: { body?: string; edit?: string }): SkaterRootSearch {
  if (old.edit !== undefined) return { post: old.edit };
  return old.body !== undefined ? { post: POST_NEW, postBody: old.body } : { post: POST_NEW };
}

/** The URL's search with the sheet's params removed — closing the sheet, whatever the page. */
export function closedSearch<T extends Record<string, unknown>>(
  search: T,
): Omit<T, 'post' | 'postBody'> {
  const { post: _post, postBody: _body, ...rest } = search;
  return rest;
}

/**
 * The navigation-state flag a door sets when it has already recorded `report_sheet_opened` itself
 * (the top bar, a lake's "Add a report"): the host then records nothing for that open. Spread
 * `reportSheetLinkState()` into a link's or a push's `state`.
 */
export const SHEET_ENTRY_RECORDED = 'reportSheetEntryRecorded';

export function reportSheetLinkState(): Record<typeof SHEET_ENTRY_RECORDED, true> {
  return { [SHEET_ENTRY_RECORDED]: true };
}

export function entryRecorded(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[SHEET_ENTRY_RECORDED] === true
  );
}

/**
 * Which `report_sheet_opened` entry the host records for an open, or `null` for none.
 *
 * - A door that recorded itself (navigation state) records nothing more — no double count.
 * - In-app, a new sheet is always a door's (the top bar and the lake page each record their own and
 *   say so in the state), so the host records only an edit.
 * - Landed (a page load, a reload, the `/post` redirect): an edit is `edit`, a lake-seeded sheet is
 *   `water_body` (the old `/post?body=` links all came from a lake), and a bare one `deep_link`.
 */
export function sheetOpenEntry(input: {
  door: SheetDoor;
  landed: boolean;
  recorded: boolean;
}): ReportSheetEntry | null {
  const { door, landed, recorded } = input;
  if (door.kind === 'none' || recorded) return null;
  if (door.kind === 'edit') return 'edit';
  if (!landed) return null;
  return door.waterBodyId !== undefined ? 'water_body' : 'deep_link';
}

/**
 * Does leaving the sheet this way lose work, and so ask first (5.31)?
 *
 * - **Discard** (Cancel) throws the draft away: it asks whenever there is anything to lose — a
 *   touched sheet, or a Post that went out and may be live.
 * - **Close** (×, Esc, back, forward, a link) keeps the draft — "Close instead keeps the draft on
 *   this device" — so it asks only when the draft would *not* be kept: an edit (never stored, the
 *   published Report is the durable copy) the author has touched, or a touched create sheet the
 *   browser refused to store.
 */
export function leaveAsks(input: {
  how: 'discard' | 'close';
  sheet: PostSheet | null;
  attempt: PostDraft | null;
  persistedAt: number | null;
}): boolean {
  const { how, sheet, attempt, persistedAt } = input;
  if (sheet === null) return false;
  const sent = postCreateSent(attempt);
  if (how === 'discard') return sheet.dirty || sent;
  if (!sheet.dirty) return false;
  return sheet.mode.kind === 'edit' || persistedAt === null;
}

// ── Abandonment (`report_sheet_abandoned`, D240) ────────────────────────────────────────────────

/** What a page hidden over an unsent, touched draft leaves behind for the next open to settle. */
export interface AbandonMarker {
  draftId: string;
  sectionsAnswered: number;
}

export const ABANDON_KEY = 'skating.reportSheet.abandon.v1';

/** The marker as stored, or `null` when there is none (or it is not one). */
export function parseAbandonMarker(raw: string | null): AbandonMarker | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AbandonMarker> | null;
    if (typeof value?.draftId !== 'string' || typeof value.sectionsAnswered !== 'number') {
      return null;
    }
    return { draftId: value.draftId, sectionsAnswered: value.sectionsAnswered };
  } catch {
    return null;
  }
}

/**
 * Settle a marker against what the next open found: the draft came back (a reload, a return) — it
 * was never abandoned; anything else — it was, and the count it left is the event's.
 */
export function settleAbandonMarker(
  marker: AbandonMarker | null,
  reopenedDraftId: string | null,
): { sectionsAnswered: number } | null {
  if (marker === null || marker.draftId === reopenedDraftId) return null;
  return { sectionsAnswered: marker.sectionsAnswered };
}
