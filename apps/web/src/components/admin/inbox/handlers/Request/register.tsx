import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { RequestHandler } from './RequestHandler';

/**
 * Board 2.3 and the kinds derived from it draw every `request` item: admit (with a catalog match or
 * without), activate, restore, contest access and takedown.
 */
export const registration: InboxHandlerRegistration = {
  keys: ['request'],
  Handler: RequestHandler,
};
