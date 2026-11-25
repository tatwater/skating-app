import { CORPUS_TASK_LANES } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { CLASS_ITEM, NAME_ITEM } from '../corpusFixtures';
import {
  buildRegistry,
  CORPUS_HANDLERS,
  type CorpusHandler,
  CorpusHandlerRegistryError,
  registeredHandler,
} from './handlerRegistry';

const A: CorpusHandler = () => null;
const B: CorpusHandler = () => null;

describe('the Corpus handler registry', () => {
  it('takes one registration or several from each module, keyed by lane', () => {
    const registry = buildRegistry({
      '../handlers/Names/register.tsx': { registration: { keys: ['nameConflicts'], Handler: A } },
      '../handlers/Classes/register.ts': {
        registrations: [{ keys: ['classConflicts'], Handler: B }],
      },
      '../handlers/Empty/register.ts': {},
    });
    expect([...registry.keys()].sort()).toEqual(['classConflicts', 'nameConflicts']);
    expect(registeredHandler(NAME_ITEM, registry)).toBe(A);
    expect(registeredHandler(CLASS_ITEM, registry)).toBe(B);
  });

  it('answers nothing for a lane no handler claims (the caller draws the placeholder)', () => {
    const registry = buildRegistry({
      '../handlers/Names/register.tsx': { registration: { keys: ['nameConflicts'], Handler: A } },
    });
    expect(registeredHandler(CLASS_ITEM, registry)).toBeUndefined();
  });

  it('refuses two handlers for one lane, naming both modules', () => {
    expect(() =>
      buildRegistry({
        '../handlers/Names/register.tsx': { registration: { keys: ['nameConflicts'], Handler: A } },
        '../handlers/Other/register.tsx': { registration: { keys: ['nameConflicts'], Handler: B } },
      }),
    ).toThrow(CorpusHandlerRegistryError);
    expect(() =>
      buildRegistry({
        '../handlers/Names/register.tsx': {
          registrations: [
            { keys: ['nameConflicts'], Handler: A },
            { keys: ['nameConflicts'], Handler: B },
          ],
        },
      }),
    ).toThrow(
      /Two Corpus handlers claim "nameConflicts": \.\.\/handlers\/Names\/register\.tsx and \.\.\/handlers\/Names\/register\.tsx/,
    );
  });

  it('builds the real registry from the handlers on disk, each key a lane core knows', () => {
    expect(CORPUS_HANDLERS).toBeInstanceOf(Map);
    for (const key of CORPUS_HANDLERS.keys()) expect(CORPUS_TASK_LANES).toContain(key);
  });
});
