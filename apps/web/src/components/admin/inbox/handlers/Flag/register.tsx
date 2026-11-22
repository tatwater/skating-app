import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { FlagHandler } from './FlagHandler';

/**
 * The flag handler claims every flag subject but a photo (2.7 is the Photo builder's; until it lands
 * the frame's placeholder draws it). `flag:waterbody` — a flag on a body that isn't an access report
 * — draws the body and its flags with *Dismiss* only.
 */
export const registrations: InboxHandlerRegistration[] = [
  {
    keys: [
      'flag:report',
      'flag:post',
      'flag:comment',
      'flag:hazard',
      'flag:accessAlert',
      'flag:waterbody',
      'flag:user',
    ],
    Handler: FlagHandler,
  },
];
