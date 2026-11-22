import type { ComponentType } from 'react';

import type { InboxItemView } from '../list/inboxTypes';
import type { DecidedState } from './InspectorFrame';

/**
 * **Which handler draws an item** — by its kind, and for a flag by what it is on (the subject):
 * `flag:report`, `flag:post`, `flag:comment`, `flag:hazard`, `flag:photo`, `flag:accessAlert`,
 * `flag:waterbody`, `flag:user`, then `access`, `request`, `place`, `drawn`, `ticket`.
 *
 * **The contract for a handler builder** (W2, W3, W5–W8): in your own folder under
 * `components/admin/inbox/handlers/`, add a `register.ts` (or `.tsx`) that exports
 *
 * ```ts
 * export const registration: InboxHandlerRegistration = { keys: ['access'], Handler: AccessHandler };
 * // or, for several: export const registrations: InboxHandlerRegistration[] = [ … ];
 * ```
 *
 * and nothing else to do: the registry finds every `handlers/**\/register.ts(x)` at build time, so
 * no shared file is edited to add one. A `Handler` takes {@link InboxHandlerProps} and draws the
 * whole inspector inside `InspectorFrame` (passing `locked` through); its single-letter keys bind to
 * `useInspectorPane()`. Two registrations claiming one key is a build error (the registry throws,
 * and its test fails), never a silent pick. A kind no handler claims yet draws the placeholder: the
 * item's facts, read only, no actions.
 */

/** What a flag can be on — the `flag:` keys' second half. */
export type FlagSubject = Extract<InboxItemView, { kind: 'flag' }>['target']['targetType'];

export type HandlerKey = `flag:${FlagSubject}` | Exclude<InboxItemView['kind'], 'flag'>;

export type InboxHandlerProps = {
  item: InboxItemView;
  /** The item's decision when it has one (the frame drops the bar and shows the lock). */
  locked: DecidedState | null;
  /** The clock the inspector reads ages against. */
  now: number;
};

export type InboxHandler = ComponentType<InboxHandlerProps>;

export type InboxHandlerRegistration = {
  keys: readonly HandlerKey[];
  Handler: InboxHandler;
};

/** A `register.ts` module's exports. */
export type RegisterModule = {
  registration?: InboxHandlerRegistration;
  registrations?: readonly InboxHandlerRegistration[];
};

export class HandlerRegistryError extends Error {
  override name = 'HandlerRegistryError';
}

/** The key an item's handler is registered under. */
export function handlerKeyOf(item: InboxItemView): HandlerKey {
  return item.kind === 'flag' ? `flag:${item.target.targetType}` : item.kind;
}

/** Every registration in `modules`, by key; throws when two claim one key. */
export function buildRegistry(
  modules: Readonly<Record<string, RegisterModule>>,
): ReadonlyMap<HandlerKey, InboxHandler> {
  const out = new Map<HandlerKey, InboxHandler>();
  const from = new Map<HandlerKey, string>();
  for (const [path, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const regs = [...(mod.registration ? [mod.registration] : []), ...(mod.registrations ?? [])];
    for (const reg of regs) {
      for (const key of reg.keys) {
        const before = from.get(key);
        if (before !== undefined) {
          throw new HandlerRegistryError(
            `Two Inbox handlers claim "${key}": ${before} and ${path}. One key, one handler.`,
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
export const HANDLERS: ReadonlyMap<HandlerKey, InboxHandler> = buildRegistry(
  import.meta.glob<RegisterModule>('../handlers/**/register.{ts,tsx}', { eager: true }),
);

/** The handler registered for `item`, or `undefined` (the caller draws the placeholder). */
export function registeredHandler(
  item: InboxItemView,
  registry: ReadonlyMap<HandlerKey, InboxHandler> = HANDLERS,
): InboxHandler | undefined {
  return registry.get(handlerKeyOf(item));
}
