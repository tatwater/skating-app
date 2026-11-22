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
  /** Where the console is (`useRouterState`'s `location.href`): a link's way back reads it. */
  here: '/admin/inbox' as string,
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
  harness.here = '/admin/inbox';
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
    useRouterState: (opts?: { select?: (state: unknown) => unknown }) => {
      const state = { location: { href: harness.here } };
      return opts?.select ? opts.select(state) : state;
    },
    // The router's link as an anchor whose `href` is the place it goes: `to` with its `params`
    // filled, and its `search`, so a test reads where a link leads and the way back it carries.
    Link: ({
      children,
      to,
      params,
      search,
      ...p
    }: {
      children?: ReactNode;
      to?: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
    }) => (
      <a {...p} data-to={to} href={hrefOf(to, params, search)}>
        {children}
      </a>
    ),
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

/** A router link's place as a path: `to` with each `$param` filled, then its search. */
export function hrefOf(
  to: string | undefined,
  params: Record<string, string> | undefined,
  search: Record<string, unknown> | undefined,
): string | undefined {
  if (to === undefined) return undefined;
  const path = to
    .split('/')
    .map((part) =>
      part.startsWith('$') ? encodeURIComponent(params?.[part.slice(1)] ?? part) : part,
    )
    .join('/');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(search ?? {})) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const qs = q.toString();
  return qs === '' ? path : `${path}?${qs}`;
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
