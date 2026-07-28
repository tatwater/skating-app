import { describe, expect, it } from 'vitest';
import { resolveAuthRoute } from './authRoute';
import { DELETED_DISPLAY_NAME } from './profile';
import { RISK_ACK_VERSION } from './riskAck';

const current = { riskAckVersion: RISK_ACK_VERSION };
const stale = { riskAckVersion: '1970-01-01' };

describe('resolveAuthRoute', () => {
  it('holds on loading until Clerk is ready, regardless of sign-in state', () => {
    expect(resolveAuthRoute({ isLoaded: false, isSignedIn: false, profile: undefined })).toBe(
      'loading',
    );
    expect(resolveAuthRoute({ isLoaded: false, isSignedIn: true, profile: current })).toBe(
      'loading',
    );
  });

  it('sends signed-out users to the auth flow', () => {
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: false, profile: undefined })).toBe(
      'auth',
    );
  });

  it('holds on loading while the profile query is still resolving', () => {
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: undefined })).toBe(
      'loading',
    );
  });

  it('routes a signed-in user with no profile row to onboarding', () => {
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: null })).toBe(
      'onboarding',
    );
  });

  it('admits a fully provisioned (current-ack) profile to the app', () => {
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: current })).toBe('app');
  });

  /**
   * A cancelled deletion (D62 amendment). The row survived, but its identity was really scrubbed at
   * request time and the cancel does not restore it — so the account has to be introduced again
   * before it can be used, and the alternative is a nameless account posting as "Deleted skater".
   */
  describe('after a cancelled deletion', () => {
    it('routes an emptied profile back through onboarding', () => {
      expect(
        resolveAuthRoute({
          isLoaded: true,
          isSignedIn: true,
          profile: { ...current, displayName: DELETED_DISPLAY_NAME },
        }),
      ).toBe('onboarding');
    });

    it('leaves a ghost alone — an empty profile is the correct state while still leaving', () => {
      expect(
        resolveAuthRoute({
          isLoaded: true,
          isSignedIn: true,
          profile: {
            ...current,
            displayName: DELETED_DISPLAY_NAME,
            deletionRequestedAt: 1_700_000_000_000,
          },
        }),
      ).toBe('app');
    });

    it('takes precedence over a stale acknowledgment — onboarding re-collects it anyway', () => {
      expect(
        resolveAuthRoute({
          isLoaded: true,
          isSignedIn: true,
          profile: { riskAckVersion: 'ancient', displayName: DELETED_DISPLAY_NAME },
        }),
      ).toBe('onboarding');
    });
  });

  it('routes a stale or missing acknowledgment to re-ack', () => {
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: stale })).toBe('reack');
    expect(resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: {} })).toBe('reack');
    expect(
      resolveAuthRoute({ isLoaded: true, isSignedIn: true, profile: { riskAckVersion: null } }),
    ).toBe('reack');
  });
});
