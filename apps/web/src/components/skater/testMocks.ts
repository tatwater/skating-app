import { getFunctionName } from 'convex/server';
import { vi } from 'vitest';

/**
 * Shared state for the connected compositions' tests. Each test file still calls `vi.mock` itself
 * (mocks are hoisted per file); this only holds the fakes those mocks hand back, so every file
 * drives Convex, the router and analytics the same way.
 */
export const fakes = {
  /** Answers per Convex function name ("waterBodies:searchByName"); a function gets the args. */
  queries: new Map<string, unknown | ((args: unknown) => unknown)>(),
  /** Every `useQuery` call that wasn't skipped, by function name. */
  calls: [] as Array<{ name: string; args: unknown }>,
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  paginated: { results: [] as unknown[], status: 'LoadingFirstPage', loadMore: vi.fn() },
  paginatedArgs: [] as unknown[],
  isAuthenticated: true,
  push: vi.fn(),
  location: { pathname: '/', searchStr: '' },
  capture: vi.fn(),
  auth: { isLoaded: true, isSignedIn: true, userId: 'user_1' as string | null | undefined },
};

export function resetFakes(): void {
  fakes.queries.clear();
  fakes.calls = [];
  fakes.mutations.clear();
  fakes.paginated = { results: [], status: 'LoadingFirstPage', loadMore: vi.fn() };
  fakes.paginatedArgs = [];
  fakes.isAuthenticated = true;
  fakes.push = vi.fn();
  fakes.location = { pathname: '/', searchStr: '' };
  fakes.capture = vi.fn();
  fakes.auth = { isLoaded: true, isSignedIn: true, userId: 'user_1' };
}

function answer(ref: unknown, args: unknown): unknown {
  const name = getFunctionName(ref as never);
  fakes.calls.push({ name, args });
  const a = fakes.queries.get(name);
  return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a;
}

export const convexReact = {
  useQuery: (ref: unknown, args: unknown) => (args === 'skip' ? undefined : answer(ref, args)),
  useQueries: (spec: Record<string, { query: unknown; args: unknown }>) =>
    Object.fromEntries(Object.entries(spec).map(([k, q]) => [k, answer(q.query, q.args)])),
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    let fn = fakes.mutations.get(name);
    if (!fn) {
      fn = vi.fn().mockResolvedValue(null);
      fakes.mutations.set(name, fn);
    }
    return fn;
  },
  usePaginatedQuery: (_ref: unknown, args: unknown) => {
    fakes.paginatedArgs.push(args);
    return args === 'skip'
      ? { results: [], status: 'LoadingFirstPage', loadMore: fakes.paginated.loadMore }
      : fakes.paginated;
  },
  useConvexAuth: () => ({ isAuthenticated: fakes.isAuthenticated, isLoading: false }),
};

export const router = {
  useRouter: () => ({ history: { push: fakes.push } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: fakes.location }),
};
