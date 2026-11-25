import type { CorpusHandlerRegistration } from '../../inspector/handlerRegistry';
import { ClassesHandler } from './ClassesHandler';

/** Board 4.3 draws every `classConflicts` task. */
export const registration: CorpusHandlerRegistration = {
  keys: ['classConflicts'],
  Handler: ClassesHandler,
};
