import { render } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ComponentType, ReactNode } from 'react';
import { vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider } from '@/lib/keys';

import { UndoProvider } from '../../shell/undo';
import { CLASS_ROWS, LANES, NAME_ROWS, page } from '../corpusFixtures';

/**
 * **Corpus's route and view together, for a test** (the Inbox's harness shape): the real
 * `BodiesRoute` — the component `routes/admin.corpus.tsx` mounts — around the real views (a task
 * lane's `CorpusTaskRoute` and `CorpusTaskView`, the library's `BodiesView`), with only the router,
 * the role, the read layer and Convex's mutation hook underneath them stood in. Every read the page
 * asks for is recorded by name with its arguments and answered from `harness.answers`; every write
 * a handler calls is recorded in `harness.writes` and answered from `harness.writeAnswers`. The
 * mount carries the shell's toasts and undo, so a refusal's toast and a receipt can be read.
 *
 * Each handler's builder writes their own wiring test beside their handler:
 *
 * ```ts
 * const { mount } = await installCorpusRouteMocks();
 * beforeEach(resetHarness);
 * // …
 * harness.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
 * harness.answers['corpusTasks:item'] = () => ({ item: NAME_ITEM, pending: false });
 * mount();
 * // …press a lever, then:
 * expect(harness.writes).toEqual([{ name: 'corpusWrites:decideName', args: { taskId, pick } }]);
 * // a refusal: harness.writeAnswers['corpusWrites:decideName'] = () => { throw new ConvexError('…') };
 * ```
 *
 * Stand in anything else a handler needs (the theme, a map's canvas) with your own `vi.doMock`
 * *before* `installCorpusRouteMocks()`; don't mock `convex/react`, `@tanstack/react-router`,
 * `@/lib/useRole` or `reads/consoleReads` again — the harness owns those.
 *
 * Test support only (`vi`): never imported by the app.
 */

export type Asked = { name: string; args: Record<string, unknown> };

export const harness = {
  /** The page's place, as the router would hand it (`useSearch`), already validated. */
  search: {} as Record<string, unknown>,
  /** Heard on every navigation; a test that follows the place sets `search` from it and rerenders. */
  navigate: (() => {}) as (opts: { to?: string; search: Record<string, unknown> }) => void,
  /** Where the console is (`useRouterState`'s `location.href`). */
  here: '/admin/corpus' as string,
  /** The viewer's capabilities (`useRole().can`); every one by default. */
  can: (() => true) as (capability: string) => boolean,
  /** Every read asked, in order, by its function's name (`corpusTasks:lanes`, `corpusTasks:item`, …). */
  asked: [] as Asked[],
  /**
   * A read's answer by its function's name; a name with none falls back to the defaults (the lanes
   * as `harness.lanes`, one page of the lane's fixture rows, an empty decided tail, no such task),
   * else loading (`undefined`).
   */
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  /** The lanes' answer when `answers['corpusTasks:lanes']` isn't set. */
  lanes: LANES as unknown,
  /** Every write called, in order, by its function's name (`corpusWrites:decideName`) with its args. */
  writes: [] as Asked[],
  /**
   * A write's answer by its function's name (throw a `ConvexError` for a refusal); a name with none
   * answers as the server answers a decision: the task, its audit row `ma_wired`, undoable.
   */
  writeAnswers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
};

/**
 * The library's list, on its way — one object, so a render sees the same array it saw last time (a
 * fresh `results` each render restarts the list's effects forever).
 */
const LIBRARY_LOADING = {
  results: [],
  status: 'LoadingFirstPage',
  isLoading: true,
  loadMore: () => {},
} as const;

/** The audit row a write answers with by default (the receipt's Undo). */
export const WIRED_ACTION_ID = 'ma_wired';

const DEFAULTS: Record<string, (args: Record<string, unknown>) => unknown> = {
  'corpusTasks:lanes': () => harness.lanes,
  'corpusTasks:listPage': (args) =>
    args.tab === 'decided'
      ? page([])
      : page(args.lane === 'classConflicts' ? CLASS_ROWS : NAME_ROWS),
  'corpusTasks:item': () => ({ item: null, pending: false }),
};

/** Back to an empty harness: no place, every capability, nothing asked or written, the defaults. */
export function resetHarness(): void {
  harness.search = {};
  harness.navigate = () => {};
  harness.here = '/admin/corpus';
  harness.can = () => true;
  harness.asked = [];
  harness.answers = {};
  harness.lanes = LANES;
  harness.writes = [];
  harness.writeAnswers = {};
}

/**
 * Stand in the router, the role, the read layer and the mutation hook, then load the route under
 * them. Call once per test file, at its top level, before anything imports the route. `mount`
 * renders the route in the keyboard layer, the toasts and the undo provider.
 */
export async function installCorpusRouteMocks(): Promise<{
  Route: ComponentType;
  mount: () => Mounted;
}> {
  vi.doMock('@tanstack/react-router', () => ({
    useSearch: () => harness.search,
    useNavigate: () => harness.navigate,
    useRouterState: (opts?: { select?: (state: unknown) => unknown }) => {
      const state = { location: { href: harness.here } };
      return opts?.select ? opts.select(state) : state;
    },
    // The router's link as an anchor whose `href` is the place it goes, so a test reads it.
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
  vi.doMock('convex/react', async (orig) => ({
    ...(await orig<typeof import('convex/react')>()),
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      return async (args: Record<string, unknown>) => {
        harness.writes.push({ name, args });
        const answer = harness.writeAnswers[name];
        if (answer !== undefined) return answer(args);
        return {
          taskId: args.taskId,
          actionId: WIRED_ACTION_ID,
          undoable: true,
          undoNeedsReason: false,
        };
      };
    },
    // The library's list (a library lane): recorded, and on its way.
    usePaginatedQuery: (ref: never, args: Record<string, unknown>) => {
      harness.asked.push({ name: getFunctionName(ref), args });
      return LIBRARY_LOADING;
    },
  }));
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
          const answer = harness.answers[name] ?? DEFAULTS[name];
          reads[k] = answer?.(spec.args);
        }
        return { reads, retry: () => {}, live: true, failed: false, pending: false };
      },
    };
  });
  const { BodiesRoute } = await import('../../bodies/BodiesRoute');
  const tree = () => (
    <Toaster>
      <UndoProvider server={{ latestOwn: async () => null, run: async () => {} }}>
        <BodiesRoute />
      </UndoProvider>
    </Toaster>
  );
  return {
    Route: BodiesRoute,
    mount: () => {
      const view = render(tree(), { wrapper: KeysProvider });
      return { ...view, refresh: () => view.rerender(tree()) };
    },
  };
}

/** What `mount` answers: the render, and `refresh` — the same page drawn again, its reads asked anew. */
export type Mounted = ReturnType<typeof render> & {
  /** Draw again (a live read's new answer: set `harness.answers`, then refresh). */
  refresh: () => void;
};

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

/** The writes called by `name`, in order. */
export const writesTo = (name: string): Asked[] => harness.writes.filter((w) => w.name === name);

/** The value, or a failed test saying what was missing. */
export const must = <T,>(x: T | null | undefined, what: string): T => {
  if (x == null) throw new Error(`missing: ${what}`);
  return x;
};
