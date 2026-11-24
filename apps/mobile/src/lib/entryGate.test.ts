import {
  type EntryProfile,
  resolveEntryRoute,
  SUSPENSION_CLOCK_MARGIN_MS,
  TERMS,
} from '@skating/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_ENTRY_SESSION,
  type EntrySession,
  entryGroup,
  entrySessionReducer,
  scheduleEntryRecheck,
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
        now: NOW,
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
          now: NOW,
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

  it('drops the hold when the acceptance is refused, and only the hold', () => {
    const seen = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'accountSeen' });
    const held = entrySessionReducer(seen, { type: 'accepted', on: 'onboarding' });
    expect(entrySessionReducer(held, { type: 'acceptFailed' })).toEqual(seen);
    expect(entrySessionReducer(seen, { type: 'acceptFailed' })).toBe(seen);
  });

  it('remembers the server’s last can’t-act refusal, until sign-out', () => {
    const refused = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'cannotAct', at: NOW });
    expect(refused.cannotActAt).toBe(NOW);
    expect(entrySessionReducer(refused, { type: 'cannotAct', at: NOW + 1 }).cannotActAt).toBe(
      NOW + 1,
    );
    expect(entrySessionReducer(refused, { type: 'signedOut' })).toBe(EMPTY_ENTRY_SESSION);
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

describe('scheduleEntryRecheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes the gate just past a suspension’s end and its margin, where the route moves to the terms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const suspended: EntryProfile = {
      displayName: 'Kate Donovan',
      status: 'suspended',
      suspendedUntil: NOW + 60_000,
    };
    const routeAt = (now: number) =>
      resolveEntryRoute({
        isLoaded: true,
        isSignedIn: true,
        profile: suspended,
        watch: WATCH,
        now,
      });
    expect(routeAt(NOW)).toBe('app');
    const wake = vi.fn();
    scheduleEntryRecheck(suspended, NOW, wake);
    vi.advanceTimersByTime(60_000 + SUSPENSION_CLOCK_MARGIN_MS);
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(routeAt(Date.now())).toBe('terms');
  });

  it('keeps a skater the server just refused in the tabs, and wakes the gate when that ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // By this device's clock the suspension lapsed long ago; the server disagreed a moment ago.
    const lapsed: EntryProfile = {
      displayName: 'Kate Donovan',
      status: 'suspended',
      suspendedUntil: 0,
    };
    const session = entrySessionReducer(EMPTY_ENTRY_SESSION, { type: 'cannotAct', at: NOW });
    const routeAt = (now: number) =>
      resolveEntryRoute({
        isLoaded: true,
        isSignedIn: true,
        profile: lapsed,
        watch: WATCH,
        now,
        cannotActAt: session.cannotActAt,
      });
    expect(entryGroup(routeAt(NOW), null)).toBe('app');
    const wake = vi.fn();
    scheduleEntryRecheck(lapsed, NOW, wake, session.cannotActAt);
    vi.advanceTimersByTime(SUSPENSION_CLOCK_MARGIN_MS - 1);
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(entryGroup(routeAt(Date.now()), null)).toBe('terms');
  });

  it('schedules nothing when nothing moves with the clock, and cancels what it scheduled', () => {
    vi.useFakeTimers();
    const wake = vi.fn();
    scheduleEntryRecheck(CURRENT, NOW, wake)();
    scheduleEntryRecheck(null, NOW, wake)();
    expect(vi.getTimerCount()).toBe(0);
    const cancel = scheduleEntryRecheck(
      { ...CURRENT, status: 'suspended', suspendedUntil: NOW + 1 },
      NOW,
      wake,
    );
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
});
