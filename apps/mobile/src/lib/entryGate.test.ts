import { type EntryProfile, resolveEntryRoute, TERMS } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ENTRY_SESSION,
  type EntrySession,
  entryGroup,
  entrySessionReducer,
  sessionEnded,
} from './entryGate';

// A pinned instant (D243): never the wall clock.
const NOW = Date.UTC(2026, 10, 24, 12);
const WATCH = { openedAt: NOW - 10 * 24 * 60 * 60 * 1000 };
const CURRENT: EntryProfile = {
  displayName: 'Kate Donovan',
  termsVersion: TERMS.version,
  knowBeforeYouGoAt: NOW - 24 * 60 * 60 * 1000,
};

describe('entryGroup', () => {
  it('opens one group per route', () => {
    expect(entryGroup('loading', null)).toBeNull();
    expect(entryGroup('auth', null)).toBe('auth');
    expect(entryGroup('account', null)).toBe('onboarding');
    expect(entryGroup('terms', null)).toBe('terms');
    expect(entryGroup('questions', null)).toBe('know-before-you-go');
    expect(entryGroup('welcome', null)).toBe('welcome');
    expect(entryGroup('app', null)).toBe('app');
  });

  it('keeps the receipt on the screen the acceptance happened on', () => {
    expect(entryGroup('receipt', 'onboarding')).toBe('onboarding');
    expect(entryGroup('receipt', 'terms')).toBe('terms');
    expect(entryGroup('receipt', null)).toBe('terms');
  });
});

describe('the hold, through core’s rule', () => {
  const route = (session: EntrySession, profile: EntryProfile | null) =>
    entryGroup(
      resolveEntryRoute({
        isLoaded: true,
        isSignedIn: true,
        profile,
        watch: WATCH,
        hold: session.hold,
      }),
      session.heldOn,
    );

  it('holds a new account on onboarding after its row is born, until released', () => {
    let session = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accountSeen' });
    expect(route(session, null)).toBe('onboarding');
    session = entrySessionReducer(session, { type: 'accepted', on: 'onboarding' });
    // The profile now exists with fresh terms and no questions answered: without the hold the
    // gate would leave for the questions before the receipt was read.
    const born: EntryProfile = {
      displayName: 'Kate Donovan',
      termsVersion: TERMS.version,
      welcomeStep: 'home',
    };
    expect(route(session, born)).toBe('onboarding');
    session = entrySessionReducer(session, { type: 'released', startQuestions: true });
    expect(route(session, born)).toBe('know-before-you-go');
    expect(session.questionsFromReceipt).toBe(true);
    expect(session.accountSeen).toBe(true);
  });

  it('holds an existing account on terms, then lets the route take over', () => {
    let session = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accepted', on: 'terms' });
    expect(route(session, CURRENT)).toBe('terms');
    session = entrySessionReducer(session, { type: 'released', startQuestions: false });
    expect(route(session, CURRENT)).toBe('app');
    expect(session.questionsFromReceipt).toBe(false);
  });

  it('never holds a signed-out session', () => {
    const held = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accepted', on: 'terms' });
    expect(
      entryGroup(
        resolveEntryRoute({
          isLoaded: true,
          isSignedIn: false,
          profile: undefined,
          watch: undefined,
          hold: held.hold,
        }),
        held.heldOn,
      ),
    ).toBe('auth');
  });
});

describe('entrySessionReducer', () => {
  it('forgets everything on sign-out, and is stable when there is nothing to forget', () => {
    const busy = entrySessionReducer(
      entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accountSeen' }),
      { type: 'accepted', on: 'onboarding' },
    );
    expect(entrySessionReducer(busy, { type: 'signedOut' })).toBe(EMPTY_ENTRY_SESSION);
    expect(entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'signedOut' })).toBe(
      EMPTY_ENTRY_SESSION,
    );
  });

  it('marks the account seen once', () => {
    const seen = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accountSeen' });
    expect(entrySessionReducer(seen, { type: 'accountSeen' })).toBe(seen);
  });
});

describe('sessionEnded', () => {
  it('is true only once Clerk has loaded and nobody is signed in', () => {
    expect(sessionEnded(false, undefined)).toBe(false);
    expect(sessionEnded(true, true)).toBe(false);
    expect(sessionEnded(true, false)).toBe(true);
    expect(sessionEnded(true, undefined)).toBe(true);
  });
});
