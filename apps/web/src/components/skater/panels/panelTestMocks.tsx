import { getFunctionName } from 'convex/server';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

import { convexReact, fakes } from '../testMocks';

/**
 * The panels' test fakes, on top of the shell's (`../testMocks`): Convex actions, and the router
 * pieces a card uses — `useNavigate`, `useCanGoBack`, the location's state, `history.back`, and a
 * `Link` that renders its href. Each test file still calls `vi.mock` itself (mocks hoist per file).
 */
export const panelFakes = {
  navigate: vi.fn(),
  back: vi.fn(),
  canGoBack: false,
  state: undefined as unknown,
  actions: new Map<string, ReturnType<typeof vi.fn>>(),
};

export function resetPanelFakes(): void {
  panelFakes.navigate = vi.fn().mockResolvedValue(undefined);
  panelFakes.back = vi.fn();
  panelFakes.canGoBack = false;
  panelFakes.state = undefined;
  panelFakes.actions.clear();
}

export const convexWithActions = {
  ...convexReact,
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    let fn = panelFakes.actions.get(name);
    if (!fn) {
      fn = vi.fn().mockResolvedValue(null);
      panelFakes.actions.set(name, fn);
    }
    return fn;
  },
};

/** `/report/$id` + `{ id: 'r1' }` → `/report/r1`. */
function fill(to: string, params?: Record<string, string>): string {
  return to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? `$${key}`);
}

export const panelRouter = {
  useNavigate: () => panelFakes.navigate,
  useRouter: () => ({ history: { back: panelFakes.back, push: fakes.push } }),
  useCanGoBack: () => panelFakes.canGoBack,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { ...fakes.location, state: panelFakes.state } }),
  Link: ({
    to,
    params,
    children,
    search: _search,
    state: _state,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: unknown;
    state?: unknown;
    children?: ReactNode;
  }) => (
    <a href={fill(to, params)} {...rest}>
      {children}
    </a>
  ),
};

/** jsdom has no Web Animations; the kit Skeleton's shimmer asks for one. */
export function polyfillAnimate(): void {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
}
