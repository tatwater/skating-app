/**
 * `erasure.test.ts` re-run with its cron mutations through the dispatcher's path (B01-8b, D347):
 * see `cronHeadroom.harness.ts`.
 */

import { rerunThroughDispatcher } from './cronHeadroom.harness';
import './erasure.test';

rerunThroughDispatcher(['erasure:eraseDue']);
