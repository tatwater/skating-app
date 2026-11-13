/**
 * The one predicate (B01 §12.7): while the console replaces the old admin pages a mode at a time,
 * a single answer — is this an old page still standing? — decides three things, and this test
 * holds all three to it over every path that matters:
 *
 * 1. **The shell**: `routes/admin.tsx` draws the old gate and sidebar or the console (`AdminRoot`).
 * 2. **The surface**: the before-paint init script states `data-surface="admin"` on the console's
 *    pages, removes it on an old page, and states `skater` everywhere else. The script is a string
 *    constant that can't import the predicate, so its own copy of the list is compared here too.
 * 3. **The old-shell wrap**: `AuthGate` wraps an old page — and only an old page — in the old
 *    `AppShell`.
 *
 * And the `.dark` class sync (D241) stays on every path, the console's included, until the last
 * old page retires.
 */

import { RISK_ACK_VERSION } from '@skating/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));
vi.mock('convex/react', () => ({
  useQuery: () => ({ riskAckVersion: RISK_ACK_VERSION, displayName: 'Teagan' }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: vi.fn() } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname }, matches: [] }),
}));
vi.mock('../../../lib/sheetOwner', () => ({ useSheetOwnerBinding: vi.fn() }));
vi.mock('../../AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="old-app-shell">{children}</div>
  ),
}));
vi.mock('../../skater/OfflineBoundary', () => ({
  FirstLoadSplash: () => <p>splash</p>,
  FirstLoadHold: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../skater/BootScreen', () => ({ BootScreen: () => <p>boot</p> }));
vi.mock('../AdminLayout', () => ({ AdminLayout: () => <p>old gate and sidebar</p> }));
vi.mock('./ConsoleLayout', () => ({ ConsoleLayout: () => <p>console</p> }));

const { THEME_COOKIE, THEME_INIT_SCRIPT } = await import('../../../lib/theme');
const { AuthGate } = await import('../../AuthGate');
const { AdminRoot } = await import('./AdminRoot');
const { isConsolePath, OLD_SHELL_TREES, usesOldShell } = await import('./consoleNav');

/** Runs the init script at `path` with a stored mode, and returns `<html>`. */
function initAt(path: string, mode: 'dark' | 'light'): HTMLElement {
  const before = window.location.pathname;
  window.history.replaceState(null, '', path);
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the init script reads document.cookie
  document.cookie = `${THEME_COOKIE}=${mode}; path=/`;
  try {
    // biome-ignore lint/security/noGlobalEval: executing our own constant is the test's point
    eval(THEME_INIT_SCRIPT);
  } finally {
    window.history.replaceState(null, '', before);
    // biome-ignore lint/suspicious/noDocumentCookie: as above
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0`;
  }
  return document.documentElement;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-surface');
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
});

/** Every old tree, a page under each, the console's pages, near-misses, and skater paths. */
const PATHS = [
  ...OLD_SHELL_TREES,
  ...OLD_SHELL_TREES.map((tree) => `${tree}/abc`),
  '/admin',
  '/admin/',
  '/admin/inbox',
  '/admin/body/abc',
  '/admin/people/abc',
  '/admin/flagsx',
  '/admin/water-bodies',
  '/',
  '/latest',
  '/water/abc',
  '/administer',
  '/u/skater',
];

describe('one predicate decides the shell, the surface and the old-shell wrap', () => {
  it('has the init script carry the same old pages as the predicate', () => {
    const list = THEME_INIT_SCRIPT.match(/var oldTrees = \[([^\]]*)\]/)?.[1];
    const trees = [...(list ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(trees).toEqual([...OLD_SHELL_TREES]);
  });

  it.each(PATHS)('%s', (path) => {
    const old = usesOldShell(path);
    const console = isConsolePath(path) && !old;
    mocks.pathname = path;

    // 2. The surface, before paint — and the `.dark` sync, both ways, on every path.
    const dark = initAt(path, 'dark');
    const surface = dark.getAttribute('data-surface');
    expect(surface).toBe(old ? null : console ? 'admin' : 'skater');
    expect(dark.classList.contains('dark')).toBe(true);
    expect(initAt(path, 'light').classList.contains('dark')).toBe(false);

    // 3. The old-shell wrap.
    const gate = render(<AuthGate>page</AuthGate>);
    expect(screen.queryByTestId('old-app-shell') !== null).toBe(old);
    expect(screen.getByText('page')).toBeInTheDocument();
    gate.unmount();

    // 1. The shell, for every path under the console's tree.
    if (isConsolePath(path)) {
      const layout = render(<AdminRoot />);
      expect(screen.getByText(old ? 'old gate and sidebar' : 'console')).toBeInTheDocument();
      layout.unmount();
    }
  });
});
