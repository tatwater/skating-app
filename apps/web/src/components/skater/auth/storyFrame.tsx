/**
 * Story-only frames for row 8. Nothing in the app imports this.
 *
 * Paired stories use the skater pair (`../storySupport`) with `AUTH_PAIR`: headed quads, two-up
 * from `lg`, the form centered. The region picture and the logo follow the *root's* mode, as they
 * do in the app, so full screens are one story per mode instead (`stageGlobals`).
 */
import type { ThemePairProps } from '../../../../.storybook/theme';
import type { AuthOutcome } from './authFlow';
import type { AuthCodeClient } from './CodeFlow';

/** How the auth forms sit in the skater pair. */
export const AUTH_PAIR = {
  heading: true,
  columns: 'lg',
  className: 'items-center',
} as const satisfies Partial<ThemePairProps>;

/** A full screen at one mode: the root carries it, as the theme cookie does in the app. */
export const stageGlobals = (mode: 'dark' | 'light') => ({ surface: 'skater', mode });

const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Clerk stand-in for stories: any plausible address gets a code, `419207` is the right one, and
 * `nobody@` has no account. Every call takes a beat so the busy states draw.
 */
export function fakeAuthClient(right = '419207'): AuthCodeClient {
  return {
    sendCode: async (email): Promise<AuthOutcome> => {
      await pause();
      return email.startsWith('nobody@') ? { ok: false, failure: 'unknown_email' } : { ok: true };
    },
    resendCode: async () => {
      await pause();
      return { ok: true };
    },
    verifyCode: async (code) => {
      await pause();
      return code === right ? { ok: true } : { ok: false, failure: 'wrong_code' };
    },
    reset: async () => undefined,
  };
}
