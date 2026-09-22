import type { SheetAction, SheetSection } from '@skating/core';
import type { SheetReport } from '../../lib/sheetModel';
import type { SheetBody } from './useSheetBody';

/**
 * `quiet` marks the sheet's own doing — a peer ghost offered, the pinned minute preselected, the
 * bundle candidates arriving — which applies without making the sheet `dirty`: only the author's
 * hand makes it worth parking as a draft or worth a leave prompt.
 */
export interface DispatchOpts {
  quiet?: boolean;
}

/** What every section of one Report sheet is handed. */
export interface SectionProps {
  report: SheetReport;
  body: SheetBody | null;
  /** Advance this Report's reducer. */
  dispatch: (action: SheetAction, opts?: DispatchOpts) => void;
  /** Change what rides beside the reducer (photos, the bundle choice, the track). */
  setReport: (update: (report: SheetReport) => SheetReport, opts?: DispatchOpts) => void;
  /** The sections a *Post* attempt found wanting (D189), to mark. */
  gaps: ReadonlySet<SheetSection>;
  /** Is this an edit of a published Report? A few affordances differ (no bundle, kept photos). */
  editing: boolean;
  timeZone: string;
}
