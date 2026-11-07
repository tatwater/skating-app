import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostHogIdentity } from './PostHogIdentity';

const mocks = vi.hoisted(() => ({
  configured: { posthog: true },
  identify: vi.fn(),
  reset: vi.fn(),
  /** What PostHog itself says about its persisted distinct id, which outlives any one mount. */
  isIdentified: vi.fn(() => false),
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
}));

vi.mock('../lib/env', () => ({
  env: { posthogKey: 'phc_test_token' },
  isConfigured: mocks.configured,
}));

vi.mock('@posthog/react', () => ({
  usePostHog: () => ({
    identify: mocks.identify,
    reset: mocks.reset,
    _isIdentified: mocks.isIdentified,
  }),
}));

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => mocks.auth,
}));

function signedIn(userId: string) {
  mocks.auth = { isLoaded: true, isSignedIn: true, userId };
}

function signedOut() {
  mocks.auth = { isLoaded: true, isSignedIn: false, userId: null };
}

beforeEach(() => {
  mocks.configured.posthog = true;
  mocks.identify.mockClear();
  mocks.reset.mockClear();
  mocks.isIdentified.mockClear();
  mocks.isIdentified.mockReturnValue(false);
  signedOut();
});

describe('PostHogIdentity', () => {
  it('renders its children untouched', () => {
    render(
      <PostHogIdentity>
        <p>the app</p>
      </PostHogIdentity>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  /**
   * **The privacy assertion this file exists for.** `identify` is called with the Clerk user id and
   * *nothing else* — no email, no name, no person properties of any kind. The founder's call, on an
   * app whose population includes 16- and 17-year-olds (D41) and whose minor-data posture is still
   * waiting on the legal pass (Q10). `/admin` already resolves a user id to a person, so an
   * analysis that wants a name never needed PostHog to hold one.
   *
   * A second argument appearing here is a privacy change, and should be read as one.
   */
  it('identifies with the Clerk user id and no person properties', () => {
    signedIn('user_abc');

    render(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.identify).toHaveBeenCalledTimes(1);
    expect(mocks.identify).toHaveBeenCalledWith('user_abc');
    expect(mocks.identify.mock.calls[0]).toHaveLength(1);
  });

  /**
   * Clerk reports `isLoaded: false` before it has resolved, which is indistinguishable from signed
   * out. Acting on it would reset a perfectly good identity on every page load.
   */
  it('does nothing while Clerk is still resolving', () => {
    mocks.auth = { isLoaded: false, isSignedIn: false, userId: null };

    render(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  /**
   * A visitor who has not signed in yet is mid-funnel: their anonymous id is what ties the
   * pageviews before sign-up to the `onboarding_completed` at the end of it. Resetting here would
   * throw that away on every mount and break the one funnel the dashboard most wants.
   */
  it('does not reset a signed-out visitor who was never identified', () => {
    render(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.identify).not.toHaveBeenCalled();
  });

  /**
   * The shared-device case that a per-mount ref alone cannot see: the sign-out did not happen in
   * this page's lifetime. A Clerk session that expired between visits, or one revoked from another
   * device, loads signed out with the ref at `null` while PostHog's persisted distinct id is still
   * the account that left — so everything the next person does before signing in would be filed
   * under that account. PostHog's own view of its identity is the only thing that knows.
   */
  it('resets a persisted identity on a fresh load that finds no session', () => {
    mocks.isIdentified.mockReturnValue(true);

    render(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.identify).not.toHaveBeenCalled();
  });

  /** A shared device must not attribute the next person's session to the account that left. */
  it('resets on sign-out after an identified session', () => {
    signedIn('user_abc');
    const { rerender } = render(<PostHogIdentity>app</PostHogIdentity>);
    expect(mocks.identify).toHaveBeenCalledWith('user_abc');

    signedOut();
    rerender(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  /**
   * Switching accounts in the same browser without a sign-out in between. Identifying straight over
   * the top would alias the two accounts into one person in PostHog, which is not reversible from
   * the app's side.
   */
  it('resets before identifying when the account changes directly', () => {
    signedIn('user_abc');
    const { rerender } = render(<PostHogIdentity>app</PostHogIdentity>);
    mocks.identify.mockClear();

    signedIn('user_xyz');
    rerender(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.identify).toHaveBeenCalledWith('user_xyz');
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.identify.mock.invocationCallOrder[0] as number,
    );
  });

  /** A returning session is the same person, so it re-identifies without a reset in between. */
  it('does not re-identify or reset an unchanged user across re-renders', () => {
    signedIn('user_abc');
    const { rerender } = render(<PostHogIdentity>app</PostHogIdentity>);

    rerender(<PostHogIdentity>app</PostHogIdentity>);
    rerender(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.identify).toHaveBeenCalledTimes(1);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('touches nothing when PostHog is unconfigured', () => {
    mocks.configured.posthog = false;
    signedIn('user_abc');

    render(<PostHogIdentity>app</PostHogIdentity>);

    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
