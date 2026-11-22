import type { InboxHandlerRegistration } from '../../inspector/handlerRegistry';
import { AccessHandler } from './AccessHandler';

/** Board 2.2 draws every `access` item: one body's open no-public-access reports. */
export const registration: InboxHandlerRegistration = { keys: ['access'], Handler: AccessHandler };
