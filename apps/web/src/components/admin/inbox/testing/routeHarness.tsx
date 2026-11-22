import { render } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ComponentType, ReactNode } from 'react';
import { vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';

import { ALL_OPEN_ROWS, page } from '../list/inboxFixtures';

/**
 * **The Inbox's route and view together, for a test** (Greptile on #171, round 1): the real
 * `InboxRoute` around the real `InboxView`, with only the router, the role and the read layer
 * underneath them stood in. Every read the page asks for is recorded by name with its arguments, so
 * a test reads what the server would have been asked, and answers each read from `harness.answers`.
 *
 * Each handler's builder writes their own wiring test beside their handler and never edits another's:
 *
 * ```ts
 * const { mount, Route } = await installInboxRouteMocks();
 * beforeEach(resetHarness);
 * // …harness.search = { item: '…' }; harness.answers['inbox:item'] = () => ({ item, pending: false });
 * ```
 *
 * Test support only (`vi`): never imported by the app.
 */

export type Asked = { name: string; args: Record<string, unknown> };

export const harness = {
  /** The page's place, as the router would hand it (`useSearch`). */
  search: {} as Record<string, unknown>,
  /** Heard on every navigation; a test that follows the place sets `search` from it and rerenders. */
  navigate: (() => {}) as (opts: { search: Record<string, unknown> }) => void,
  /** The viewer's capabilities (`useRole().can`); every one by default. */
  can: (() => true) as (capability: string) => boolean,
  /** Every read asked, in order, by its function's name (`inbox:lanes`, `inbox:item`, …). */
  asked: [] as Asked[],
  /**
   * A read's answer by its function's name; a name with none falls back to `DEFAULTS` (the lanes as
   * `harness.lanes`, one page of the fixture rows, no such item), else loading (`undefined`).
   */
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  /** The lanes' answer when `answers['inbox:lanes']` isn't set. */
  lanes: undefined as unknown,
};

const DEFAULTS: Record<string, () => unknown> = {
  'inbox:lanes': () => harness.lanes,
  'inbox:listPage': () => page(ALL_OPEN_ROWS),
  'inbox:item': () => ({ item: null, pending: false }),
};

/** Back to an empty harness: no place, every capability, nothing asked, the default answers. */
export function resetHarness(): void {
  harness.search = {};
  harness.navigate = () => {};
  harness.can = () => true;
  harness.asked = [];
  harness.answers = {};
  harness.lanes = undefined;
}

/**
 * Stand in the router, the role and the read layer, then load the route under them. Call once per
 * test file, at its top level, before anything imports the route.
 */
export async function installInboxRouteMocks(): Promise<{
  Route: ComponentType;
  mount: () => ReturnType<typeof render>;
}> {
  vi.doMock('@tanstack/react-router', () => ({
    useSearch: () => harness.search,
    useNavigate: () => harness.navigate,
    Link: ({ children, ...p }: { children?: ReactNode }) => <a {...p}>{children}</a>,
  }));
  vi.doMock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => harness.can(c) }) }));
  vi.doMock('@/components/admin/reads/consoleReads', async (orig) => {
    const actual = await orig<typeof import('@/components/admin/reads/consoleReads')>();
    return {
      ...actual,
      useConsoleReadSet: (specs: Record<string, { query: never; args: never } | null>) => {
        const reads: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(specs)) {
          if (spec === null) continue;
          const name = getFunctionName(spec.query);
          harness.asked.push({ name, args: spec.args });
          const answer = harness.answers[name];
          reads[k] = answer !== undefined ? answer(spec.args) : DEFAULTS[name]?.();
        }
        return { reads, retry: () => {}, live: true, failed: false, pending: false };
      },
    };
  });
  const { InboxRoute } = await import('../InboxRoute');
  return { Route: InboxRoute, mount: () => render(<InboxRoute />, { wrapper: KeysProvider }) };
}

/** The arguments the newest read of `name` was asked with. */
export const lastArgs = (name: string): Record<string, unknown> | undefined =>
  [...harness.asked].reverse().find((a) => a.name === name)?.args;

/** Every distinct argument set `name` was asked with, in order. */
export const argSets = (name: string): string[] => [
  ...new Set(harness.asked.filter((a) => a.name === name).map((a) => JSON.stringify(a.args))),
];

/** The value, or a failed test saying what was missing. */
export const must = <T,>(x: T | null | undefined, what: string): T => {
  if (x == null) throw new Error(`missing: ${what}`);
  return x;
};
