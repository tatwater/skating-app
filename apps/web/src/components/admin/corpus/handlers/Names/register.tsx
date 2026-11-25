import type { CorpusHandlerRegistration } from '../../inspector/handlerRegistry';
import { NamesHandler } from './NamesHandler';

/** Board 4.2 draws every `nameConflicts` task. */
export const registration: CorpusHandlerRegistration = {
  keys: ['nameConflicts'],
  Handler: NamesHandler,
};
