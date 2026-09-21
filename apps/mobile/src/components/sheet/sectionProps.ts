import type { SheetAction, SheetSection } from '@skating/core';
import type { SheetReport } from '../../lib/sheetModel';
import type { SheetBody } from './useSheetBody';

/** What every section of one Report sheet is handed. */
export interface SectionProps {
  report: SheetReport;
  body: SheetBody | null;
  /** Advance this Report's reducer. */
  dispatch: (action: SheetAction) => void;
  /** Change what rides beside the reducer (photos, the bundle choice, the track). */
  setReport: (update: (report: SheetReport) => SheetReport) => void;
  /** The sections a *Post* attempt found wanting (D189), to mark. */
  gaps: ReadonlySet<SheetSection>;
  /** Is this an edit of a published Report? A few affordances differ (no bundle, kept photos). */
  editing: boolean;
  timeZone: string;
}
