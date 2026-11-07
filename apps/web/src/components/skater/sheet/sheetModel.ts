/**
 * The report sheet's own small rules, pure (B03 §5): what a refused *Post* marks, what the meter
 * shows, how a lake is set and removed, and what the status line says. The Post model itself is
 * core's (`postSheet`); this is only the web sheet's reading of it.
 */

import {
  type MinimumSetTerm,
  type Mint,
  openReport,
  type PostSheet,
  type ReportRefusal,
  removeReport,
  SHEET_SECTION_COUNT,
  type SheetSection,
  sheetReducer,
  updateReport,
} from '@skating/core';

/** Which section a minimum-set term points at, for the *needed* mark (D189). */
export const TERM_SECTION: Record<MinimumSetTerm, SheetSection | null> = {
  body: null,
  endTime: 'endTime',
  howWasIt: 'howWasIt',
  observation: 'iceAndSurface',
};

/** The sections a refusal marks on one Report. */
export function gapsFor(refusals: readonly ReportRefusal[], reportId: string): Set<SheetSection> {
  const set = new Set<SheetSection>();
  for (const r of refusals) {
    if (r.reportId !== reportId) continue;
    for (const term of r.gaps) {
      const section = TERM_SECTION[term];
      if (section !== null) set.add(section);
    }
  }
  return set;
}

/** `report_sheet_refused`'s count: every gap term across the Post, or one for a refusal with none. */
export function missingCount(refusals: readonly ReportRefusal[]): number {
  return refusals.reduce((n, r) => n + Math.max(r.gaps.length, 1), 0);
}

/** The foot's line for a refusal: the first one, naming its lake when the Post has several. */
export function refusalMessage(refusals: readonly ReportRefusal[], reportCount: number): string {
  const first = refusals[0];
  if (first === undefined) return '';
  return first.bodyName !== undefined && reportCount > 1
    ? `${first.bodyName}: ${first.message}`
    : first.message;
}

/**
 * The tab's meter (5.1, 5.23): ten cells, the answered ones lit, then — while a refused *Post* says
 * so — the ones it still needs in amber. It counts; it never says "ready" (D3).
 */
export function meterCells(answered: number, needed: number): Array<'on' | 'need' | 'off'> {
  const on = Math.min(Math.max(answered, 0), SHEET_SECTION_COUNT);
  const need = Math.min(Math.max(needed, 0), SHEET_SECTION_COUNT - on);
  return Array.from({ length: SHEET_SECTION_COUNT }, (_, i) =>
    i < on ? 'on' : i < on + need ? 'need' : 'off',
  );
}

export function meterLabel(answered: number): string {
  return `${answered} of ${SHEET_SECTION_COUNT} questions answered`;
}

/** A lake picked for a Report (Which lake?): through the reducer, so another lake's ghosts go. */
export function setReportBody(
  post: PostSheet,
  reportId: string,
  picked: { waterBodyId: string; name: string },
): PostSheet {
  return updateReport(post, reportId, (r) => ({
    ...r,
    bodyName: picked.name,
    sheet: sheetReducer(r.sheet, { type: 'setBody', waterBodyId: picked.waterBodyId }),
    coord: undefined,
  }));
}

/**
 * Remove a lake (5.4.1): its answers go with it; the Post's words and photos stay. With other lakes
 * the Report goes; as the only one it starts over on *Which lake?*, keeping its photos.
 */
export function removeLake(post: PostSheet, reportId: string, now: number, mint: Mint): PostSheet {
  if (post.reports.length > 1) return removeReport(post, reportId);
  const report = post.reports.find((r) => r.id === reportId);
  if (report === undefined) return post;
  const showPutIn = report.sheet.scalars.showPutIn;
  const fresh = openReport({ ...(showPutIn !== undefined ? { showPutIn } : {}) }, now, mint);
  return { ...post, reports: [{ ...fresh, photos: report.photos }], dirty: true };
}

/** The status line at the sheet's top right (5.1, 5.25–5.27). */
export type SavedState =
  | { tone: 'hollow'; text: string }
  | { tone: 'solid'; text: string }
  | { tone: 'warn'; text: string };

export function savedState(input: {
  editing: boolean;
  persistedAt: number | null;
  online: boolean;
  now: number;
}): SavedState {
  if (input.editing) return { tone: 'hollow', text: 'Editing the published report' };
  if (input.persistedAt === null) return { tone: 'hollow', text: 'Not saved yet' };
  if (!input.online) return { tone: 'warn', text: 'Offline · saved on this device' };
  return { tone: 'solid', text: `Saved on this device · ${ago(input.persistedAt, input.now)}` };
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 30) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h === 1 ? '1 hr ago' : `${h} hr ago`;
}
