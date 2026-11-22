import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { PlaceHandler } from './PlaceHandler';

/** Board 2.4 draws every `place` item: an ask to name a landmark or a bay on a body. */
export const registration: InboxHandlerRegistration = { keys: ['place'], Handler: PlaceHandler };
