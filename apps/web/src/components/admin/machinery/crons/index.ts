/**
 * **The cron pieces** (B01-8b): a cron's card, its tick strip and its runs drawer — what Imagery
 * mounts now and Weather and Health reuse. Generic on purpose: nothing here names a pipeline; a page
 * passes its own words (labels, count columns, headlines, the foot's action).
 */

export { CronCard, type CronCardProps } from './CronCard';
export { CronRunsDrawer, type CronRunsDrawerProps, defaultStripRange } from './CronRunsDrawer';
export {
  type CronRunsColumn,
  type CronRunsFilterView,
  CronRunsView,
  type CronRunsViewProps,
} from './CronRunsView';
export { CronTickStrip, type CronTickStripProps } from './CronTickStrip';
export {
  type CronCardState,
  type CronReading,
  cronCardState,
  cronLivenessAt,
  cronReading,
} from './cronModel';
export type { CronJobView, CronRunView, CronTickView } from './cronViews';
export { CRON_STATE_WORDS } from './cronWords';
