import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cannotActRefusalHolds,
  type EntryProfile,
  type EntryRoute,
  entryCanAct,
  entryRouteRecheckIn,
  MAX_TIMER_DELAY_MS,
  resolveEntryRoute,
  SUSPENSION_CLOCK_MARGIN_MS,
} from './entryRoute';
import { KNOW_BEFORE_YOU_GO_EARLY_MS } from './knowBeforeYouGoSeason';
import { TERMS } from './legal/terms';
import { DELETED_DISPLAY_NAME } from './profile';

// Pinned instants (D243).
const OPENED = Date.UTC(2027, 10, 20, 14);
const watch = { openedAt: OPENED };
const ANSWERED_THIS_SEASON = OPENED - 10 * 24 * 60 * 60 * 1000;
const ANSWERED_LAST_SEASON = OPENED - 300 * 24 * 60 * 60 * 1000;
/** The instant the gate reads the rule at. */
const NOW = OPENED + 5 * 24 * 60 * 60 * 1000;

/** A live account with the current terms and this season's answers: the one that reaches the app. */
const done: EntryProfile = {
  displayName: 'Kate Donovan',
  termsVersion: TERMS.version,
  knowBeforeYouGoAt: ANSWERED_THIS_SEASON,
};

const signedIn = { isLoaded: true, isSignedIn: true, now: NOW } as const;
/** Signed in, against the open watch unless a second argument (even `undefined`) says otherwise. */
const route = (
  profile: EntryProfile | null | undefined,
  ...w: [] | [typeof watch | null | undefined]
) => resolveEntryRoute({ ...signedIn, profile, watch: w.length === 0 ? watch : w[0] });

describe('resolveEntryRoute, row by row', () => {
  it('1: holds on loading until Clerk is ready, whatever else is known', () => {
    expect(
      resolveEntryRoute({ isLoaded: false, isSignedIn: true, profile: done, watch, now: NOW }),
    ).toBe('loading');
    expect(
      resolveEntryRoute({
        isLoaded: false,
        isSignedIn: undefined,
        profile: undefined,
        watch,
        now: NOW,
      }),
    ).toBe('loading');
  });

  it('2: sends a signed-out caller to auth', () => {
    expect(
      resolveEntryRoute({ isLoaded: true, isSignedIn: false, profile: done, watch, now: NOW }),
    ).toBe('auth');
    expect(
      resolveEntryRoute({
        isLoaded: true,
        isSignedIn: undefined,
        profile: undefined,
        watch,
        now: NOW,
      }),
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

  it('4: lets an account the profile gate refuses into the (read-only) app, never the consent steps', () => {
    // Each would be refused by acceptTerms or completeKnowBeforeYouGo (`requireProfile`), so the
    // consent steps would trap it; the app holds its read-only view and the support screen.
    const stale: EntryProfile = { displayName: 'Kate', knowBeforeYouGoAt: undefined };
    for (const status of ['banned', 'deleting', 'deleted'] as const) {
      expect(route({ ...stale, status })).toBe('app');
      expect(route({ ...stale, status }, undefined)).toBe('app');
      expect(route({ ...stale, status, displayName: DELETED_DISPLAY_NAME })).toBe('app');
    }
    expect(route({ ...stale, status: 'suspended' })).toBe('app');
    expect(route({ ...stale, status: 'suspended', suspendedUntil: NOW + 1 })).toBe('app');
    expect(route({ ...done, status: 'suspended', welcomeStep: 'home' })).toBe('app');
  });

  it('4: puts a lapsed suspension through the consent checks again', () => {
    const lapsed: EntryProfile = {
      displayName: 'Kate',
      status: 'suspended',
      suspendedUntil: NOW - SUSPENSION_CLOCK_MARGIN_MS,
    };
    expect(route(lapsed)).toBe('terms');
    expect(route({ ...lapsed, termsVersion: TERMS.version })).toBe('questions');
    expect(route({ ...done, status: 'suspended', suspendedUntil: NOW - 1 })).toBe('app');
    expect(route({ ...done, status: 'active' })).toBe('app');
    expect(route({ ...done, status: 'active', termsVersion: undefined })).toBe('terms');
  });

  it('4: holds a suspension a margin past its end, for a device clock running ahead', () => {
    // The device reads NOW; the server, a few minutes behind, still has the account suspended.
    const ended = (ago: number): EntryProfile => ({
      displayName: 'Kate',
      status: 'suspended',
      suspendedUntil: NOW - ago,
    });
    expect(SUSPENSION_CLOCK_MARGIN_MS).toBe(5 * 60 * 1000);
    expect(route(ended(0))).toBe('app');
    expect(route(ended(SUSPENSION_CLOCK_MARGIN_MS - 1))).toBe('app');
    expect(route(ended(SUSPENSION_CLOCK_MARGIN_MS))).toBe('terms');
    // Only the suspension's end is given the margin: a banned account is out at once, and an
    // active one is in.
    expect(entryCanAct({ status: 'banned' }, NOW)).toBe(false);
    expect(entryCanAct({ status: 'active', suspendedUntil: NOW + 1 }, NOW)).toBe(true);
  });

  it('4: sends an account the server just refused as unable to act to the app, for the margin', () => {
    // A clock further ahead than the margin: the rule says the suspension lapsed, the server says
    // it hasn't, and its refusal (moments ago) is what the rule hears.
    const lapsed: EntryProfile = { displayName: 'Kate', status: 'suspended', suspendedUntil: 0 };
    const at = (now: number, cannotActAt: number | null) =>
      resolveEntryRoute({ ...signedIn, now, profile: lapsed, watch, cannotActAt });
    expect(at(NOW, null)).toBe('terms');
    expect(at(NOW, NOW)).toBe('app');
    expect(at(NOW + SUSPENSION_CLOCK_MARGIN_MS - 1, NOW)).toBe('app');
    // Then the steps again: a refusal there sets it again; an account that can act goes on.
    expect(at(NOW + SUSPENSION_CLOCK_MARGIN_MS, NOW)).toBe('terms');
    // A clock stepped back past the refusal doesn't keep the skater out.
    expect(at(NOW - 1, NOW)).toBe('terms');
    expect(cannotActRefusalHolds(undefined, NOW)).toBe(false);
    // Never past the hold or for a caller without a row.
    expect(
      resolveEntryRoute({ ...signedIn, profile: done, watch, hold: 'receipt', cannotActAt: NOW }),
    ).toBe('receipt');
    expect(resolveEntryRoute({ ...signedIn, profile: null, watch, cannotActAt: NOW })).toBe(
      'account',
    );
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
        now: NOW,
      }),
    ).toBe('auth');
    expect(
      resolveEntryRoute({
        isLoaded: false,
        isSignedIn: true,
        profile: done,
        watch,
        hold: 'receipt',
        now: NOW,
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
    status: fc.constantFrom(
      'active' as const,
      'suspended' as const,
      'banned' as const,
      'deleting' as const,
      'deleted' as const,
    ),
    suspendedUntil: instant,
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
  now: instant,
  cannotActAt: fc.option(instant),
});

describe('resolveEntryRoute, properties', () => {
  it('never lets stale terms into the app unless a deletion is pending or the account can’t act', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute(i);
        if (r !== 'app' || !i.profile) return true;
        return (
          i.profile.termsVersion === TERMS.version ||
          i.profile.deletionRequestedAt !== undefined ||
          !entryCanAct(i.profile, i.now) ||
          cannotActRefusalHolds(i.cannotActAt, i.now)
        );
      }),
    );
  });

  it('never sends an account the server just refused as unable to act back to a step, for the margin', () => {
    fc.assert(
      fc.property(input, fc.integer({ min: 0, max: SUSPENSION_CLOCK_MARGIN_MS - 1 }), (i, ago) => {
        const r = resolveEntryRoute({ ...i, hold: null, cannotActAt: i.now - ago });
        return r !== 'terms' && r !== 'questions' && r !== 'welcome';
      }),
    );
  });

  it('never sends an account the profile gate refuses to a step it would be refused at', () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = resolveEntryRoute(i);
        if (!i.profile || entryCanAct(i.profile, i.now)) return true;
        return r !== 'terms' && r !== 'questions' && r !== 'welcome' && r !== 'account';
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

  it('is total and ordered: Clerk, then sign-in, then the hold, then a deletion or the gate', () => {
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
        if (i.profile && !entryCanAct(i.profile, i.now)) return r === 'app';
        if (i.profile && cannotActRefusalHolds(i.cannotActAt, i.now)) return r === 'app';
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
            entryCanAct(i.profile, i.now) &&
            !cannotActRefusalHolds(i.cannotActAt, i.now) &&
            i.profile.displayName !== DELETED_DISPLAY_NAME)
        );
      }),
    );
  });
});

describe('entryRouteRecheckIn', () => {
  it('wakes a gate just past a suspension’s end and its margin, and for nothing else', () => {
    const until = NOW + 60_000;
    const wake = 60_000 + SUSPENSION_CLOCK_MARGIN_MS + 1;
    expect(entryRouteRecheckIn({ status: 'suspended', suspendedUntil: until }, NOW)).toBe(wake);
    const suspended: EntryProfile = {
      displayName: 'Kate',
      status: 'suspended',
      suspendedUntil: until,
    };
    expect(
      resolveEntryRoute({
        ...signedIn,
        now: until + SUSPENSION_CLOCK_MARGIN_MS - 1,
        profile: suspended,
        watch,
      }),
    ).toBe('app');
    expect(resolveEntryRoute({ ...signedIn, now: NOW + wake, profile: suspended, watch })).toBe(
      'terms',
    );
    // Inside the margin, the wake is still ahead.
    expect(entryRouteRecheckIn({ status: 'suspended', suspendedUntil: NOW - 1_000 }, NOW)).toBe(
      SUSPENSION_CLOCK_MARGIN_MS - 1_000 + 1,
    );
    // An open-ended suspension, one lapsed past its margin, an active or banned account, no
    // profile: nothing due.
    expect(entryRouteRecheckIn({ status: 'suspended' }, NOW)).toBeNull();
    expect(
      entryRouteRecheckIn(
        { status: 'suspended', suspendedUntil: NOW - SUSPENSION_CLOCK_MARGIN_MS },
        NOW,
      ),
    ).toBeNull();
    expect(entryRouteRecheckIn({ status: 'active', suspendedUntil: until }, NOW)).toBeNull();
    expect(entryRouteRecheckIn({ status: 'banned' }, NOW)).toBeNull();
    expect(entryRouteRecheckIn(null, NOW)).toBeNull();
    expect(entryRouteRecheckIn(undefined, NOW)).toBeNull();
  });

  it('wakes a gate when a can’t-act refusal stops holding, whichever comes first', () => {
    const refused = NOW - 60_000;
    expect(entryRouteRecheckIn(null, NOW, refused)).toBe(SUSPENSION_CLOCK_MARGIN_MS - 60_000);
    expect(
      resolveEntryRoute({
        ...signedIn,
        now: NOW + SUSPENSION_CLOCK_MARGIN_MS - 60_000,
        profile: { displayName: 'Kate' },
        watch,
        cannotActAt: refused,
      }),
    ).toBe('terms');
    // With a suspension ending later, the refusal's end comes first; with one ending sooner, it.
    expect(
      entryRouteRecheckIn({ status: 'suspended', suspendedUntil: NOW + 60_000 }, NOW, refused),
    ).toBe(SUSPENSION_CLOCK_MARGIN_MS - 60_000);
    expect(entryRouteRecheckIn({ status: 'suspended' }, NOW, NOW - 1)).toBe(
      SUSPENSION_CLOCK_MARGIN_MS - 1,
    );
    // Spent, or from a clock that has since stepped back: nothing due.
    expect(entryRouteRecheckIn(null, NOW, NOW - SUSPENSION_CLOCK_MARGIN_MS)).toBeNull();
    expect(entryRouteRecheckIn(null, NOW, NOW + 1)).toBeNull();
  });

  it('never asks a timer for more than it keeps', () => {
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(entryRouteRecheckIn({ status: 'suspended', suspendedUntil: NOW + year }, NOW)).toBe(
      MAX_TIMER_DELAY_MS,
    );
  });
});
