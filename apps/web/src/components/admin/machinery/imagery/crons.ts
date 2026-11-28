/**
 * **Where the Imagery page takes W2's cron card and runs drawer from** — the one line the integrator
 * changes: `from './cronsPlaceholder'` becomes `from '../crons'` once W2's `machinery/crons/*` lands
 * (PLACEHOLDER until then).
 */
export { CronCard, CronRunsDrawer } from './cronsPlaceholder';
