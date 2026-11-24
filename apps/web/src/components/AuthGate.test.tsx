import { DELETED_DISPLAY_NAME, KNOW_BEFORE_YOU_GO_EARLY_MS, TERMS } from '@skating/core';
import { act, render, screen } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false } as { isLoaded: boolean; isSignedIn: boolean },
  profile: undefined as unknown,
  watch: null as unknown,
  pathname: '/',
  notFound: false,
  push: vi.fn(),
}));

vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => mocks.auth }));
vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === 'skip') return undefined;
    return getFunctionName(ref) === 'consent:watchAnchor' ? mocks.watch : mocks.profile;
  },
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
vi.mock('./skater/OfflineBoundary', () => ({
  FirstLoadSplash: () => <p>splash</p>,
  // Kept visible in the tree: the hold has to sit *inside* it, or a returning load with no socket
  // holds on skeletons forever (`OfflineBoundary.test.tsx` owns the escalation itself).
  FirstLoadHold: ({ children }: { children: ReactNode }) => (
    <div data-testid="first-load-hold">{children}</div>
  ),
}));
vi.mock('./skater/BootScreen', () => ({
  BootScreen: ({ pathname }: { pathname: string }) => <p>{`boot ${pathname}`}</p>,
}));

import { BOOT_COOKIE, bootCookieString, readBootZoneFromCookie } from '../lib/boot';
import { finishReceipt, forgetEntry, holdForReceipt, recordReceipt } from '../lib/entryHold';
import { AuthGate, usesOldShell } from './AuthGate';

/** The Ice Watch opened this season (the instant pinned, D243). */
const OPENED_AT = Date.UTC(2026, 10, 20, 12);
const WATCH = { season: 'winter-2026-27', label: 'Winter 2026–27', openedAt: OPENED_AT };

/** Through the way in: the current terms, this season's questions, no welcome step left. */
const PROVISIONED = {
  displayName: 'Skater',
  termsVersion: TERMS.version,
  knowBeforeYouGoAt: OPENED_AT - 1000,
};

/** jsdom keeps one document per file, and the gate writes a session cookie into it. */
function clearBootCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
  document.cookie = `${BOOT_COOKIE}=; path=/; max-age=0`;
}

beforeEach(() => {
  mocks.auth = { isLoaded: true, isSignedIn: false };
  mocks.profile = undefined;
  mocks.watch = null;
  mocks.pathname = '/';
  mocks.notFound = false;
  mocks.push = vi.fn();
  clearBootCookie();
  forgetEntry();
});

afterEach(() => {
  clearBootCookie();
  forgetEntry();
});

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
    // And it escalates like the splash does: a socket that never opens must reach the skater.
    expect(screen.getByTestId('first-load-hold')).toContainElement(
      screen.getByText('boot /water/abc'),
    );
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

  it.each(['auth', 'account', 'terms', 'questions', 'welcome', 'receipt'] as const)(
    'stays the splash when the last zone was %s — only the app has a shape to draw',
    (zone) => {
      // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
      document.cookie = bootCookieString(zone);
      mocks.auth = { isLoaded: false, isSignedIn: false };
      render(<AuthGate>page</AuthGate>);
      expect(screen.getByText('splash')).toBeInTheDocument();
    },
  );

  // An old page and the new console alike: neither is the skater shell, so neither gets its
  // skeletons — the narrowed old-shell predicate must not leak the console into the boot screen.
  it.each(['/admin/water/review', '/admin'])(
    'stays the splash under the console (%s), which holds its own way',
    (path) => {
      // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the gate reads and writes document.cookie
      document.cookie = bootCookieString('app');
      mocks.auth = { isLoaded: false, isSignedIn: false };
      mocks.pathname = path;
      render(<AuthGate>page</AuthGate>);
      expect(screen.getByText('splash')).toBeInTheDocument();
    },
  );

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
    ['with no profile row', { isLoaded: true, isSignedIn: true }, null, 'account'],
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

/**
 * The way in (B03 §9.3): the gate reads the profile, the Ice Watch and the receipt hold through
 * core's `resolveEntryRoute`, and sends each state to its one path.
 */
describe('the way in', () => {
  beforeEach(() => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
  });

  it('sends a new account (no profile row) to the Account step', () => {
    mocks.profile = null;
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/onboarding');
  });

  it('sends a canceled deletion’s emptied row to the Account step', () => {
    mocks.profile = { ...PROVISIONED, displayName: DELETED_DISPLAY_NAME };
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/onboarding');
  });

  it('sends an account under the old acknowledgment to the terms', () => {
    mocks.profile = { displayName: 'Skater' };
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/terms');
  });

  it('sends an account on an older terms version to the terms', () => {
    mocks.profile = { ...PROVISIONED, termsVersion: '2020-01-01' };
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/terms');
  });

  it('sends a never-answered account to the questions, even before any season opens', () => {
    mocks.profile = { ...PROVISIONED, knowBeforeYouGoAt: undefined };
    mocks.watch = null;
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/know-before-you-go');
  });

  it('sends last season’s answers to the questions once the watch opens a new one', () => {
    mocks.profile = {
      ...PROVISIONED,
      knowBeforeYouGoAt: OPENED_AT - KNOW_BEFORE_YOU_GO_EARLY_MS - 1,
    };
    mocks.watch = WATCH;
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/know-before-you-go');
  });

  it('counts answers from the 30 days before the opening toward it', () => {
    mocks.profile = { ...PROVISIONED, knowBeforeYouGoAt: OPENED_AT - KNOW_BEFORE_YOU_GO_EARLY_MS };
    mocks.watch = WATCH;
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('sends a welcome step still ahead to /welcome', () => {
    mocks.profile = { ...PROVISIONED, welcomeStep: 'profile' };
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/welcome');
  });

  it('lets a pending deletion into the app before any consent check', () => {
    mocks.profile = { displayName: DELETED_DISPLAY_NAME, deletionRequestedAt: OPENED_AT };
    mocks.pathname = '/settings/data';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('lets an account the server refuses right now into the app, where its support screen is', () => {
    // Banned, or suspended with stale terms: the acceptance would refuse it, so the terms would trap
    // it with nothing to do. Neither leaves for a consent step.
    mocks.pathname = '/settings/data';
    for (const profile of [
      { displayName: 'Skater', status: 'banned' },
      { displayName: 'Skater', status: 'suspended', suspendedUntil: Date.UTC(2099, 0, 1) },
      { displayName: 'Skater', status: 'suspended' },
    ]) {
      mocks.profile = profile;
      const { unmount } = render(<AuthGate>page</AuthGate>);
      expect(screen.getByText('page')).toBeInTheDocument();
      unmount();
    }
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('sends a lapsed suspension through the terms again', () => {
    mocks.profile = {
      displayName: 'Skater',
      status: 'suspended',
      suspendedUntil: Date.UTC(2000, 0, 1),
    };
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/terms');
  });

  it('holds on the splash while the watch is still loading, past the profile’s own rows', () => {
    mocks.profile = PROVISIONED;
    mocks.watch = undefined;
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('splash')).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('never asks a signed-out visitor’s browser for the watch', () => {
    mocks.auth = { isLoaded: true, isSignedIn: false };
    mocks.watch = undefined; // would hold forever if it were asked
    mocks.pathname = '/sign-in';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
  });
});

/**
 * The receipt hold: *Record acceptance* changes the profile at once, which would route past the
 * receipt. The hold keeps the gate where it is until the receipt's own button lets go.
 */
describe('the receipt hold', () => {
  beforeEach(() => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
  });

  it('keeps a new account on the Terms step though the profile now says questions are due', () => {
    holdForReceipt();
    recordReceipt();
    mocks.profile = { ...PROVISIONED, knowBeforeYouGoAt: undefined, welcomeStep: 'home' };
    mocks.pathname = '/onboarding';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('holds while the acceptance is still on its way, so its writes can’t win the race', () => {
    holdForReceipt();
    mocks.profile = PROVISIONED; // through, as the profile reads the moment the write lands
    mocks.pathname = '/terms';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('holds even while the profile query is reloading', () => {
    holdForReceipt();
    mocks.profile = undefined;
    mocks.pathname = '/terms';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByText('page')).toBeInTheDocument();
  });

  it('lets go when the receipt’s button is pressed, and the route takes over', () => {
    holdForReceipt();
    recordReceipt();
    mocks.profile = { ...PROVISIONED, knowBeforeYouGoAt: undefined };
    mocks.pathname = '/terms';
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).not.toHaveBeenCalled();
    act(() => finishReceipt(true));
    expect(mocks.push).toHaveBeenCalledWith('/know-before-you-go');
  });

  it('is ignored once signed out', () => {
    holdForReceipt();
    mocks.auth = { isLoaded: true, isSignedIn: false };
    mocks.pathname = '/terms';
    render(<AuthGate>page</AuthGate>);
    expect(mocks.push).toHaveBeenCalledWith('/sign-in');
  });

  it('records the receipt as its own zone, never the app’s shape', () => {
    holdForReceipt();
    mocks.pathname = '/terms';
    mocks.profile = PROVISIONED;
    render(<AuthGate>page</AuthGate>);
    expect(readBootZoneFromCookie(document.cookie)).toBe('receipt');
  });
});

describe('usesOldShell', () => {
  it.each(['/admin/water', '/admin/water/review'])('keeps %s in the old shell', (path) => {
    expect(usesOldShell(path)).toBe(true);
  });

  it.each([
    '/admin',
    '/admin/',
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
