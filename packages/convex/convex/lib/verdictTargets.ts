/**
 * **Each kind a verdict can be on, with its table** — the one map every record read and write resolves
 * a verdict's target through (a leaf module, so the record's reads and writes import it without a
 * cycle). Not the erasure map (`lib/eraseClock.ERASABLE`): a photo (B01-5e, D222) carries verdicts but
 * no erasure clock — a removed photo's bytes go on its own purge clock (`photoPurge`), and its row stays
 * as the tombstone the verdict names.
 */
import type { Doc } from '../_generated/dataModel';

export const VERDICT_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
  accessAlert: 'accessAlerts',
  photo: 'photos',
} as const satisfies Record<Doc<'contentVerdicts'>['targetType'], string>;
