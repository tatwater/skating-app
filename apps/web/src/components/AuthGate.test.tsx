import { RISK_ACK_VERSION } from '@skating/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false } as { isLoaded: boolean; isSignedIn: boolean },
  profile: undefined as unknown,
  pathname: '/',
  notFound: false,
  push: vi.fn(),
}));

vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => mocks.auth }));
vi.mock('convex/react', () => ({
  useQuery: (_ref: unknown, args: unknown) => (args === 'skip' ? undefined : mocks.profile),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: mocks.push } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({
      location: { pathname: mocks.pathname },
      matches: [{ _notFound: mocks.notFound }],
    }),
}));
vi.mock('../lib/sheetOwner', () => ({ useSheetOwnerBinding: vi.fn() }));
vi.mock('./AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('./skater/OfflineBoundary', () => ({ FirstLoadSplash: () => <p>splash</p> }));
vi.mock('./skater/BootScreen', () => ({
  BootScreen: ({ pathname }: { pathname: string }) => <p>{`boot ${pathname}`}</p>,
}));

import { BOOT_COOKIE, bootCookieString, readBootZoneFromCookie } from '../lib/boot';
import { AuthGate, usesOldShell } from './AuthGate';

const PROVISIONED = { riskAckVersion: RISK_ACK_VERSION, displayName: 'Skater' };

/** jsdom keeps one document per file, and the gate writes a session cookie into it. */
function clearBootCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
  document.cookie = `${BOOT_COOKIE}=; path=/; max-age=0`;
}

beforeEach(() => {
  mocks.auth = { isLoaded: true, isSignedIn: false };
  mocks.profile = undefined;
  mocks.pathname = '/';
  mocks.notFound = false;
  mocks.push = vi.fn();
  clearBootCookie();
});

afterEach(clearBootCookie);

describe('AuthGate', () => {
  it('holds on the first-load splash while auth loads', () => {
    mocks.auth = { isLoaded: false, isSignedIn: false };
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('splash')).toBeInTheDocument();
    expect(screen.queryByText('page')).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in, on the splash meanwhile', () => {
    mocks.pathname = '/lakes';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('splash')).toBeInTheDocument();
    expect(mocks.push).toHaveBeenCalledWith('/sign-in');
  });

  it('keeps the admin console in the old shell', () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    mocks.pathname = '/admin/water/review';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByTestId('shell')).toHaveTextContent('page');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('renders an old /feed deep link bare, leaving the hop to /latest to its route', () => {
    // `routes/feed.tsx`'s `beforeLoad` redirects to `/latest` (pinned in `-latest.routes.test.tsx`);
    // the gate neither wraps it in the old shell nor redirects it itself.
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    mocks.pathname = '/feed';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each([
    ['Explore', '/'],
    ['a lake', '/water/abc'],
    ['an unknown path (the 404)', '/lakes'],
  ])(
    "renders %s bare for a provisioned skater — the skater chrome is the page's own",
    (_, path) => {
      mocks.auth = { isLoaded: true, isSignedIn: true };
      mocks.profile = PROVISIONED;
      mocks.pathname = path;
      render(<AuthGate>page</AuthGate>);
      expect(screen.getByText('page')).toBeInTheDocument();
      expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    },
  );

  it('leaves a 404 under an old-shell prefix to the 404’s own shell — one header, not two', () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    mocks.pathname = '/admin/nope';
    mocks.notFound = true;
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('renders an auth page bare for a signed-out visitor', () => {
    mocks.pathname = '/sign-in';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  describe('the Google Photos callback renders bare in every auth state', () => {
    beforeEach(() => {
      mocks.pathname = '/google-photos/callback';
    });

    it('while auth loads', () => {
      mocks.auth = { isLoaded: false, isSignedIn: false };
      render(<AuthGate>callback</AuthGate>);
      expect(screen.getByText('callback')).toBeInTheDocument();
      expect(screen.queryByText('splash')).not.toBeInTheDocument();
    });

    it('signed out, with no redirect to sign in', () => {
      render(<AuthGate>callback</AuthGate>);
      expect(screen.getByText('callback')).toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it('signed in without a profile, with no redirect to onboarding', () => {
      mocks.auth = { isLoaded: true, isSignedIn: true };
      mocks.profile = null;
      render(<AuthGate>callback</AuthGate>);
      expect(screen.getByText('callback')).toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it('signed in and provisioned, without the app shell', () => {
      mocks.auth = { isLoaded: true, isSignedIn: true };
      mocks.profile = PROVISIONED;
      render(<AuthGate>callback</AuthGate>);
      expect(screen.getByText('callback')).toBeInTheDocument();
      expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    });
  });
});

/**
 * The hold is the splash only on a cold start; a browser session that has already reached the app
 * gets the page's shape instead, because a full-screen hold on every document load reads as a
 * restart. `lib/boot.ts` carries the knowledge across the load.
 */
describe('the hold while auth resolves', () => {
  it('is the splash on a cold start — nothing is known about where this lands', () => {
    mocks.auth = { isLoaded: false, isSignedIn: false };
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('splash')).toBeInTheDocument();
  });

  it('is the page’s shape once this session has reached the app, pathname and all', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
    document.cookie = bootCookieString('app');
    mocks.auth = { isLoaded: false, isSignedIn: false };
    mocks.pathname = '/water/abc';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('boot /water/abc')).toBeInTheDocument();
    expect(screen.queryByText('splash')).not.toBeInTheDocument();
    expect(screen.queryByText('page')).not.toBeInTheDocument();
  });

  it('holds on the shape mid-redirect too, not only while Clerk loads', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
    document.cookie = bootCookieString('app');
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    mocks.pathname = '/sign-in'; // provisioned: the gate is sending them home
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('boot /sign-in')).toBeInTheDocument();
    expect(mocks.push).toHaveBeenCalledWith('/');
  });

  it.each(['auth', 'onboarding', 'reack'] as const)(
    'stays the splash when the last zone was %s — only the app has a shape to draw',
    (zone) => {
      // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
      document.cookie = bootCookieString(zone);
      mocks.auth = { isLoaded: false, isSignedIn: false };
      render(<AuthGate>page</AuthGate>);
      expect(screen.getByText('splash')).toBeInTheDocument();
    },
  );

  it('stays the splash under the console, which holds its own way', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
    document.cookie = bootCookieString('app');
    mocks.auth = { isLoaded: false, isSignedIn: false };
    mocks.pathname = '/admin/water/review';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('splash')).toBeInTheDocument();
  });

  it('is never drawn over the Google Photos callback, which renders bare in every state', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
    document.cookie = bootCookieString('app');
    mocks.auth = { isLoaded: false, isSignedIn: false };
    mocks.pathname = '/google-photos/callback';
    render(<AuthGate>callback</AuthGate>);
    expect(screen.getByText('callback')).toBeInTheDocument();
  });
});

describe('the boot cookie the gate writes', () => {
  it('records the app once a provisioned skater is through', () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    render(<AuthGate>page</AuthGate>);
    expect(readBootZoneFromCookie(document.cookie)).toBe('app');
  });

  it.each([
    ['signed out', { isLoaded: true, isSignedIn: false }, undefined, 'auth'],
    ['with no profile row', { isLoaded: true, isSignedIn: true }, null, 'onboarding'],
  ])('records %s', (_, auth, profile, zone) => {
    mocks.auth = auth;
    mocks.profile = profile;
    mocks.pathname = '/sign-in';
    render(<AuthGate>page</AuthGate>);
    expect(readBootZoneFromCookie(document.cookie)).toBe(zone);
  });

  it('writes nothing while the answer is still loading', () => {
    mocks.auth = { isLoaded: false, isSignedIn: false };
    render(<AuthGate>page</AuthGate>);
    expect(readBootZoneFromCookie(document.cookie)).toBeNull();
  });

  it('overwrites a stale app, so signing out stops drawing the skater shell', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
    document.cookie = bootCookieString('app');
    mocks.auth = { isLoaded: true, isSignedIn: false };
    mocks.pathname = '/sign-in';
    render(<AuthGate>page</AuthGate>);
    expect(readBootZoneFromCookie(document.cookie)).toBe('auth');
  });
});

describe('usesOldShell', () => {
  it.each(['/admin', '/admin/water/review'])('keeps %s in the old shell', (path) => {
    expect(usesOldShell(path)).toBe(true);
  });

  it.each([
    '/',
    '/water/abc',
    '/lakes',
    '/administer',
    '/feed',
    '/latest',
    '/feedback',
    '/u/',
    '/u/skater',
    '/settings',
    '/settings/notifications',
    '/notifications',
    '/about',
    '/post',
    '/report',
    '/report/r1',
    '/hazard/h1',
    '/bounty/b1',
    '/about/team',
  ])('renders %s bare', (path) => {
    expect(usesOldShell(path)).toBe(false);
  });
});
