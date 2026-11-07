import { RISK_ACK_VERSION } from '@skating/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false } as { isLoaded: boolean; isSignedIn: boolean },
  profile: undefined as unknown,
  pathname: '/',
  push: vi.fn(),
}));

vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => mocks.auth }));
vi.mock('convex/react', () => ({
  useQuery: (_ref: unknown, args: unknown) => (args === 'skip' ? undefined : mocks.profile),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: mocks.push } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
}));
vi.mock('../lib/sheetOwner', () => ({ useSheetOwnerBinding: vi.fn() }));
vi.mock('./AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('./skater/OfflineBoundary', () => ({ FirstLoadSplash: () => <p>splash</p> }));

import { AuthGate } from './AuthGate';

const PROVISIONED = { riskAckVersion: RISK_ACK_VERSION, displayName: 'Skater' };

beforeEach(() => {
  mocks.auth = { isLoaded: true, isSignedIn: false };
  mocks.profile = undefined;
  mocks.pathname = '/';
  mocks.push = vi.fn();
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

  it("wraps a provisioned skater's page in the app shell", () => {
    mocks.auth = { isLoaded: true, isSignedIn: true };
    mocks.profile = PROVISIONED;
    mocks.pathname = '/lakes';
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByTestId('shell')).toHaveTextContent('page');
    expect(mocks.push).not.toHaveBeenCalled();
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
