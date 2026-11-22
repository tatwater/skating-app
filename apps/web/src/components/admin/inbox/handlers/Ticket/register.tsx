import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { TicketHandler } from './TicketHandler';

/** Board 2.8 draws every `ticket` item: a support ticket, its thread, and the reply and note dock. */
export const registration: InboxHandlerRegistration = { keys: ['ticket'], Handler: TicketHandler };
