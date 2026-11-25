import type { CorpusTaskLane } from '@skating/core';
import type { ComponentType } from 'react';

import type { DecidedState } from '../../inspector/InspectorFrame';
import type { CorpusTaskItemView } from '../corpusTypes';

/**
 * **Which handler draws a Corpus task** — by its lane (`CorpusTaskLane`: `nameConflicts`,
 * `classConflicts`; 6b–6d add theirs).
 *
 * **The contract for a handler builder**: in your own folder under
 * `components/admin/corpus/handlers/`, add a `register.ts` (or `.tsx`) that exports
 *
 * ```ts
 * export const registration: CorpusHandlerRegistration = { keys: ['nameConflicts'], Handler: NamesHandler };
 * // or, for several: export const registrations: CorpusHandlerRegistration[] = [ … ];
 * ```
 *
 * and nothing else to do: the registry finds every `handlers/**\/register.ts(x)` at build time
 * (`import.meta.glob`), so no shared file is edited to add one. A `Handler` takes
 * {@link CorpusHandlerProps} and draws the whole inspector inside `InspectorFrame` (passing `locked`
 * through, so a decided task drops its bar and shows the lock); its single-letter keys bind to
 * `useInspectorPane()`. Narrow the item by its lane (`item.lane === 'nameConflicts'`, or
 * `CorpusItemOf<'nameConflicts'>` from `corpusTypes`). Two registrations claiming one lane is a build
 * error (the registry throws, and its test fails), never a silent pick. A lane no handler claims draws
 * the placeholder: the task's facts, read only, no actions.
 */

export type CorpusHandlerProps = {
  item: CorpusTaskItemView;
  /** The task's decision when it has one (the frame drops the bar and shows the lock). */
  locked: DecidedState | null;
  /** The clock the inspector reads ages against. */
  now: number;
};

export type CorpusHandler = ComponentType<CorpusHandlerProps>;

export type CorpusHandlerRegistration = {
  keys: readonly CorpusTaskLane[];
  Handler: CorpusHandler;
};

/** A `register.ts` module's exports. */
export type CorpusRegisterModule = {
  registration?: CorpusHandlerRegistration;
  registrations?: readonly CorpusHandlerRegistration[];
};

export class CorpusHandlerRegistryError extends Error {
  override name = 'CorpusHandlerRegistryError';
}

/** Every registration in `modules`, by lane; throws when two claim one lane. */
export function buildRegistry(
  modules: Readonly<Record<string, CorpusRegisterModule>>,
): ReadonlyMap<CorpusTaskLane, CorpusHandler> {
  const out = new Map<CorpusTaskLane, CorpusHandler>();
  const from = new Map<CorpusTaskLane, string>();
  for (const [path, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const regs = [...(mod.registration ? [mod.registration] : []), ...(mod.registrations ?? [])];
    for (const reg of regs) {
      for (const key of reg.keys) {
        const before = from.get(key);
        if (before !== undefined) {
          throw new CorpusHandlerRegistryError(
            `Two Corpus handlers claim "${key}": ${before} and ${path}. One lane, one handler.`,
          );
        }
        out.set(key, reg.Handler);
        from.set(key, path);
      }
    }
  }
  return out;
}

/** Every handler the builders have registered so far. */
export const CORPUS_HANDLERS: ReadonlyMap<CorpusTaskLane, CorpusHandler> = buildRegistry(
  import.meta.glob<CorpusRegisterModule>('../handlers/**/register.{ts,tsx}', { eager: true }),
);

/** The handler registered for `item`'s lane, or `undefined` (the caller draws the placeholder). */
export function registeredHandler(
  item: Pick<CorpusTaskItemView, 'lane'>,
  registry: ReadonlyMap<CorpusTaskLane, CorpusHandler> = CORPUS_HANDLERS,
): CorpusHandler | undefined {
  return registry.get(item.lane);
}
