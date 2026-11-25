import type { CorpusTaskLane } from '@skating/core';
import type { ComponentType } from 'react';

import type { HandlerProps } from '../taskItem';
import { NamesHandler } from './NamesHandler';

/**
 * Board 4.2 draws every `nameConflicts` task. Written to the Inbox registry's shape (the briefs'
 * `CorpusHandlerRegistration`); W1's registry publishes the type, which this imports once it lands.
 */
export const registration: {
  keys: readonly CorpusTaskLane[];
  Handler: ComponentType<HandlerProps>;
} = { keys: ['nameConflicts'], Handler: NamesHandler };
