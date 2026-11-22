import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { DrawnHandler } from './DrawnHandler';

/** Board 2.5 draws every `drawn` item: a body a skater drew, waiting for review. */
export const registration: InboxHandlerRegistration = { keys: ['drawn'], Handler: DrawnHandler };
