import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type EntryProfile, type EntryRoute, resolveEntryRoute } from './entryRoute';
import { KNOW_BEFORE_YOU_GO_EARLY_MS } from './knowBeforeYouGoSeason';
import { TERMS } from './legal/terms';
import { DELETED_DISPLAY_NAME } from './profile';

// Pinned instants (D243).
const OPENED = Date.UTC(2027, 10, 20, 14);
const watch = { openedAt: OPENED };
const ANSWERED_THIS_SEASON = OPENED - 10 * 24 * 60 * 60 * 1000;
const ANSWERED_LAST_SEASON = OPENED - 300 * 24 * 60 * 60 * 1000;

/** A live account with the current terms and this season's answers: the one that reaches the app. */
const done: EntryProfile = {
  displayName: 'Kate Donovan',
  termsVersion: TERMS.version,
  knowBeforeYouGoAt: ANSWERED_THIS_SEASON,
};

const signedIn = { isLoaded: true, isSignedIn: true } as const;
/** Signed in, against the open watch unless a second argument (even `undefined`) says otherwise. */
const route = (
  profile: EntryProfile | null | undefined,
  ...w: [] | [typeof watch | null | undefined]
) => resolveEntryRoute({ ...signedIn, profile, watch: w.length === 0 ? watch : w[0] });

describe('resolveEntryRoute, row by row', () => {
  it('1: holds on loading until Clerk is ready, whatever else is known', () => {
    expect(resolveEntryRoute({ isLoaded: false, isSignedIn: true, profile: done, watch })).toBe(
      'loading',
    );
    expect(
      resolveEntryRoute({ isLoaded: false, isSignedIn: undefined, profile: undefined, watch }),
    ).toBe('loading');
  });

  it('2: sends a signed-out caller to auth', () => {
    expect(resolveEntryRoute({ isLoaded: true, isSignedIn: false, profile: done, watch })).toBe(
      'auth',
    );
    expect(
      resolveEntryRoute({ isLoaded: true, isSignedIn: undefined, profile: undefined, watch }),
    ).toBe('auth');
  });

  it('1: holds on loading while the profile query resolves', () => {
    expect(route(undefined)).toBe('loading');
  });

  it('3: sends a signed-in caller with no row to the Account step', () => {
    expect(route(null)).toBe('account');
    expect(route(null, undefined)).toBe('account');
  });

  it('4: lets a pending deletion into the (read-only) app before any consent check', () => {
    const leaving: EntryProfile = {
      displayName: DELETED_DISPLAY_NAME,
      deletionRequestedAt: Date.UTC(2027, 11, 1),
    };
    expect(route(leaving)).toBe('app');
    expect(route(leaving, undefined)).toBe('app');
    expect(route({ ...leaving, welcomeStep: 'home' }, null)).toBe('app');
  });

  it('5: sends a canceled deletion’s emptied row back to the Account step', () => {
    expect(route({ ...done, displayName: DELETED_DISPLAY_NAME })).toBe('account');
    expect(route({ displayName: DELETED_DISPLAY_NAME }, undefined)).toBe('account');
  });

  it('1: holds on loading past row 5 while the watch query resolves', () => {
    expect(route(done, undefined)).toBe('loading');
    expect(route({ displayName: 'Kate' }, undefined)).toBe('loading');
  });

  it('6: sends missing or stale terms to the terms', () => {
    expect(route({ displayName: 'Kate' })).toBe('terms');
    expect(route({ ...done, termsVersion: '2026-01-01' })).toBe('terms');
  });

  it('7: sends never-answered or last-season answers to the questions', () => {
    expect(route({ ...done, knowBeforeYouGoAt: undefined })).toBe('questions');
    expect(route({ ...done, knowBeforeYouGoAt: undefined }, null)).toBe('questions');
    expect(route({ ...done, knowBeforeYouGoAt: ANSWERED_LAST_SEASON })).toBe('questions');
    expect(route({ ...done, knowBeforeYouGoAt: OPENED - KNOW_BEFORE_YOU_GO_EARLY_MS })).toBe('app');
    expect(route({ ...done, knowBeforeYouGoAt: ANSWERED_LAST_SEASON }, null)).toBe('app');
  });

  it('8: sends a new account with Home or Profile ahead to the welcome steps', () => {
    expect(route({ ...done, welcomeStep: 'home' })).toBe('welcome');
    expect(route({ ...done, welcomeStep: 'profile' })).toBe('welcome');
  });

  it('9: lets everyone else into the app', () => {
    expect(route(done)).toBe('app');
    expect(route(done, null)).toBe('app');
  });

  it('holds the receipt for a signed-in caller, whatever the queries say, until it is cleared', () => {
    for (const profile of [undefined, null, done, { displayName: 'Kate' }]) {
      for (const w of [undefined, null, watch]) {
        expect(resolveEntryRoute({ ...signedIn, profile, watch: w, hold: 'receipt' })).toBe(
          'receipt',
        );
      }
    }
    expect(resolveEntryRoute({ ...signedIn, profile: done, watch, hold: null })).toBe('app');
    expect(
      resolveEntryRoute({
        isLoaded: true,
        isSignedIn: false,
        profile: done,
        watch,
        hold: 'receipt',
      }),
    ).toBe('auth');
    expect(
      resolveEntryRoute({
        isLoaded: false,
        isSignedIn: true,
        profile: done,
        watch,
        hold: 'receipt',
      }),
    ).toBe('loading');
  });
});

describe('who sees what (§9.3)', () => {
  it('walks a new account through every step, in order', () => {
    const steps: EntryRoute[] = [
      route(null),
      route({ displayName: 'Kate', termsVersion: TERMS.version, welcomeStep: 'home' }),
      route({ ...done, welcomeStep: 'home' }),
      route({ ...done, welcomeStep: 'profile' }),
      route(done),
    ];
    expect(steps).toEqual(['account', 'questions', 'welcome', 'welcome', 'app']);
  });

  it('takes an existing account from before the merge through terms then questions, never welcome', () => {
    const before: EntryProfile = { displayName: 'Kate' };
    expect(route(before)).toBe('terms');
    expect(route({ ...before, termsVersion: TERMS.version })).toBe('questions');
    expect(route({ ...before, termsVersion: TERMS.version, knowBeforeYouGoAt: OPENED })).toBe(
      'app',
    );
  });
});

// ── properties ──────────────────────────────────────────────────────────────────────────────────

const instant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) });
const profileArb: fc.Arbitrary<EntryProfile> = fc.record(
  {
    displayName: fc.constantFrom('Kate Donovan', DELETED_DISPLAY_NAME, ''),
    deletionRequestedAt: instant,
    termsVersion: fc.constantFrom(TERMS.version, '2025-01-01'),
    knowBeforeYouGoAt: instant,
    welcomeStep: fc.constantFrom('home' as const, 'profile' as const),
  },
  { requiredKeys: [] },
);
const watchArb = fc.option(instant.map((openedAt) => ({ openedAt })));
const input = fc.record({
  isLoaded: fc.boolean(),
  isSignedIn: fc.constantFrom(true, false, undefined),
  profile: fc.oneof(fc.constant(undefined), fc.constant(null), profileArb),
  watch: fc.oneof(fc.constant(undefined), watchArb),
  hold: fc.constantFrom('receipt' as const, null),
});

describe('resolveEntryRoute, properties', () => {
  it('never lets stale terms into the app unless a deletion is pending', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute(i);
        if (r !== 'app' || !i.profile) return true;
        return (
          i.profile.termsVersion === TERMS.version || i.profile.deletionRequestedAt !== undefined
        );
      }),
    );
  });

  it('never sends a live, complete row to the Account step', () => {
    fc.assert(
      fc.property(input, (i) => {
        if (!i.profile || i.profile.displayName === DELETED_DISPLAY_NAME) return true;
        return resolveEntryRoute(i) !== 'account';
      }),
    );
  });

  it('is total and ordered: Clerk, then sign-in, then the hold, then a pending deletion', () => {
    const routes = new Set<EntryRoute>([
      'loading',
      'auth',
      'receipt',
      'account',
      'terms',
      'questions',
      'welcome',
      'app',
    ]);
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute(i);
        if (!routes.has(r)) return false;
        if (!i.isLoaded) return r === 'loading';
        if (!i.isSignedIn) return r === 'auth';
        if (i.hold === 'receipt') return r === 'receipt';
        if (i.profile?.deletionRequestedAt !== undefined) return r === 'app';
        return r !== 'auth' && r !== 'receipt';
      }),
    );
  });

  it('puts terms before the questions, and both before the welcome steps', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute(i);
        const p = i.profile;
        if (r === 'questions') return p?.termsVersion === TERMS.version;
        if (r === 'welcome') {
          return p?.termsVersion === TERMS.version && p.welcomeStep !== undefined;
        }
        return true;
      }),
    );
  });

  it('only waits on the watch once it matters', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute({ ...i, watch: undefined });
        if (r !== 'loading') return true;
        // Loading on an undefined watch only for a signed-in, unheld caller with a live, set-up row.
        return (
          !i.isLoaded ||
          i.profile === undefined ||
          (i.isSignedIn === true &&
            i.hold === null &&
            i.profile !== null &&
            i.profile.deletionRequestedAt === undefined &&
            i.profile.displayName !== DELETED_DISPLAY_NAME)
        );
      }),
    );
  });
});
