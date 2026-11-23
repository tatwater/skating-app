import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { FlagHandler } from './FlagHandler';

/**
 * The flag handler claims every flag subject. A photo (board 2.7) draws its stage through
 * `PhotoSubject` inside the same handler, so the flag, the author, the bar and the writes are one
 * path for every subject. `flag:waterbody` — a flag on a body that isn't an access report — draws the
 * body and its flags with *Dismiss* only.
 */
export const registrations: InboxHandlerRegistration[] = [
  {
    keys: [
      'flag:report',
      'flag:post',
      'flag:comment',
      'flag:hazard',
      'flag:photo',
      'flag:accessAlert',
      'flag:waterbody',
      'flag:user',
    ],
    Handler: FlagHandler,
  },
];
