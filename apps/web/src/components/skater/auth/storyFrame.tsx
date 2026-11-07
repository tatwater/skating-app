/**
 * Story-only frames for row 8. Nothing in the app imports this.
 *
 * The bench's `fourUp` renders all four maps; a skater composition has no admin map (the kit owns
 * those), so `SkaterPair` renders the same two scoped sections — skater dark, skater light — side by
 * side, on the bench's own scoped token copy. The region picture and the logo follow the *root's*
 * mode, as they do in the app, so full screens are one story per mode instead (`stageGlobals`).
 */
import tokensCss from '@skating/design/tokens.css?raw';
import type { ReactNode } from 'react';
import { SCOPE_ATTR, scopedTokensCss } from '../../../../.storybook/theme';
import type { AuthOutcome } from './authFlow';
import type { AuthCodeClient } from './CodeFlow';

function ensureScopedTokens(): void {
  if (document.querySelector('style[data-kit-scoped-tokens]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-kit-scoped-tokens', '');
  style.textContent = scopedTokensCss(tokensCss);
  document.head.append(style);
}

export function SkaterPair({ children }: { children: () => ReactNode }) {
  ensureScopedTokens();
  return (
    <div className="grid grid-cols-1 gap-px bg-line lg:grid-cols-2" data-skater-pair="">
      {(['dark', 'light'] as const).map((mode) => (
        <section
          key={mode}
          {...{ [SCOPE_ATTR]: '' }}
          data-surface="skater"
          data-mode={mode}
          aria-label={`Skater ${mode}`}
          className="flex min-w-0 flex-col items-center gap-heading bg-bg p-gutter font-(family-name:--family-sans) text-fg"
        >
          <h2 className="self-start font-semibold text-fg3 text-kick uppercase leading-none tracking-kick">
            Skater · {mode === 'dark' ? 'Dark' : 'Light'}
          </h2>
          {children()}
        </section>
      ))}
    </div>
  );
}

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
