import {
  CONSENT_REFUSAL_MESSAGES,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_SHA256,
  LOCATE_GIVE_UP_MS,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  TERMS,
  TERMS_OPEN_RETRY_GAP_MS,
  TERMS_SHA256,
} from '@skating/core';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

const m = vi.hoisted(() => ({
  /** The address provider: on, with nothing to suggest unless a test says otherwise. */
  suggest: vi.fn(async (_args: { text: string }) => ({
    status: 'ok',
    suggestions: [] as unknown[],
    attribution: 'Powered by Geoapify',
  })),
  toast: vi.fn(),
  signOut: vi.fn(async () => undefined),
  capture: vi.fn(),
  reload: vi.fn(),
}));
vi.mock('convex/react', () => ({ ...convexReact, useAction: () => m.suggest }));
vi.mock('../../kit/toast', async (original) => ({
  ...(await original<typeof import('../../kit/toast')>()),
  toast: m.toast,
}));
vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ sessionId: 'sess_1' }),
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'kate.donovan@gmail.com' } } }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => m.signOut }));
vi.mock('@/lib/analytics', () => ({ useAnalytics: () => ({ capture: m.capture }) }));
vi.mock('./OutdatedStep', async (original) => ({
  ...(await original<typeof import('./OutdatedStep')>()),
  reloadPage: m.reload,
}));
vi.mock('../settings/useProfilePhoto', () => ({
  useProfilePhoto: () => ({
    imageUrl: undefined,
    busy: null,
    error: null,
    offline: false,
    onChange: async () => {},
    onRemove: async () => true,
  }),
}));

import {
  carryAccount,
  forgetEntry,
  holdForReceipt,
  recordReceipt,
  useEntryStore,
} from '@/lib/entryHold';

import { resetGeocoderSession } from '../settings/geocoder';
import {
  KnowBeforeYouGoPage,
  OnboardingPage,
  profilePatch,
  TermsPage,
  useUsernameAvailability,
  WelcomePage,
} from './EntryPages';

/** Every end marker is on screen the moment it is watched: the reading's end, at once. */
class SeenAtOnce {
  private live = true;
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => {
      if (!this.live) return;
      this.callback(
        [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    });
  }
  disconnect() {
    this.live = false;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

beforeAll(() => {
  // Base UI waits on an element's animations before it unmounts; jsdom has none to wait on.
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [] });
  }
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.scrollTo ??= () => {};
});

/** The fake behind `useMutation` for a function name: the one the component gets. */
const mutation = (name: string) => {
  let fn = fakes.mutations.get(name);
  if (!fn) {
    fn = vi.fn().mockResolvedValue(null);
    fakes.mutations.set(name, fn);
  }
  return fn;
};

const ACCOUNT = {
  displayName: 'Kate Donovan',
  username: 'kdonovan',
  dateOfBirth: Date.UTC(1988, 10, 2),
};
const FIELDS = {
  displayName: 'Kate Donovan',
  username: 'kdonovan',
  month: 11,
  day: '2',
  year: '1988',
};
const LIVE = {
  _id: 'p1',
  displayName: 'Kate Donovan',
  profileVisibility: 'public',
  termsVersion: TERMS.version,
  knowBeforeYouGoAt: Date.UTC(2026, 10, 16),
};

beforeEach(() => {
  resetFakes();
  forgetEntry();
  // A test that turns the provider off latches it for the session: each test is a new one.
  resetGeocoderSession();
  m.toast.mockClear();
  m.capture.mockClear();
  m.signOut.mockClear();
  m.reload.mockClear();
  m.suggest.mockReset();
  m.suggest.mockImplementation(async () => ({
    status: 'ok',
    suggestions: [],
    attribution: 'Powered by Geoapify',
  }));
  vi.stubGlobal('IntersectionObserver', SeenAtOnce);
  fakes.queries.set('consent:watchAnchor', null);
  // The two writes that seal a record answer as the server does when they recorded one.
  mutation('consent:acceptTerms').mockResolvedValue({ recordId: 'cr1', repeat: false });
  mutation('consent:completeKnowBeforeYouGo').mockResolvedValue({ season: null, repeat: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetEntry();
});

/** Reads to the end (the stub sees it at once), ticks the box, and records. */
async function readAndRecord(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-disabled'));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Record acceptance' }));
}

describe('/onboarding', () => {
  it('falls back to the Account step when the Terms step has no fields carried', async () => {
    fakes.queries.set('profiles:current', null);
    const onStep = vi.fn();
    render(<OnboardingPage step="terms" onStep={onStep} />);
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    await waitFor(() => expect(onStep).toHaveBeenCalledWith('account', { replace: true }));
  });

  it('carries the Account step’s values to the Terms step, writing nothing', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', null);
    fakes.queries.set('profiles:usernameAvailable', { username: 'kdonovan', available: true });
    const onStep = vi.fn();
    carryAccount(FIELDS, ACCOUNT);
    useEntryStore.setState({ account: null });
    render(<OnboardingPage step="account" onStep={onStep} />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onStep).toHaveBeenCalledWith('terms');
    expect(useEntryStore.getState().account).toEqual(ACCOUNT);
    for (const write of fakes.mutations.values()) expect(write).not.toHaveBeenCalled();
  });

  it('opens the reading, reaches its end, and records the acceptance with the account', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', null);
    carryAccount(FIELDS, ACCOUNT);
    render(<OnboardingPage step="terms" onStep={vi.fn()} />);
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    await waitFor(() =>
      expect(mutation('consent:openTerms')).toHaveBeenCalledWith({
        termsVersion: TERMS.version,
        termsHash: TERMS_SHA256,
        surface: 'web',
      }),
    );
    await readAndRecord(user);
    expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledWith({
      termsVersion: TERMS.version,
      termsHash: TERMS_SHA256,
      via: 'inline',
    });
    expect(m.capture).toHaveBeenCalledWith('terms_read_to_end', { via: 'inline' });
    await waitFor(() =>
      expect(mutation('consent:acceptTerms')).toHaveBeenCalledWith({
        termsVersion: TERMS.version,
        termsHash: TERMS_SHA256,
        privacyVersion: PRIVACY_NOTICE_VERSION,
        privacyHash: PRIVACY_NOTICE_SHA256,
        surface: 'web',
        userAgent: navigator.userAgent,
        clientSessionId: 'sess_1',
        account: ACCOUNT,
      }),
    );
    // The receipt, under the hold; the new profile counts once.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Acceptance recorded' })).toBeInTheDocument(),
    );
    expect(useEntryStore.getState()).toMatchObject({
      hold: 'receipt',
      recorded: true,
      account: null,
    });
    expect(m.capture).toHaveBeenCalledWith('terms_accepted', { context: 'first_run' });
    expect(m.capture).toHaveBeenCalledWith('onboarding_completed');
  });

  it('sends a taken handle back to the Account step, marked, with a toast', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', null);
    carryAccount(FIELDS, ACCOUNT);
    mutation('consent:acceptTerms').mockRejectedValueOnce(
      new ConvexError({ code: 'username_taken', message: 'Someone just took that username.' }),
    );
    const onStep = vi.fn();
    render(<OnboardingPage step="terms" onStep={onStep} />);
    await readAndRecord(user);
    await waitFor(() => expect(onStep).toHaveBeenCalledWith('account'));
    expect(m.toast).toHaveBeenCalledWith({
      title: 'Someone just took that username.',
      tone: 'bad',
    });
    expect(useEntryStore.getState()).toMatchObject({ hold: null, taken: 'kdonovan' });
  });

  it.each([
    'underage',
    'name_invalid',
    'username_invalid',
    'username_cooldown',
    'account_required',
  ])(
    'sends a %s refusal back to the Account step with a toast, as the phone does',
    async (code) => {
      const user = userEvent.setup();
      fakes.queries.set('profiles:current', null);
      carryAccount(FIELDS, ACCOUNT);
      mutation('consent:acceptTerms').mockRejectedValueOnce(
        new ConvexError({ code, message: `Refused: ${code}` }),
      );
      const onStep = vi.fn();
      render(<OnboardingPage step="terms" onStep={onStep} />);
      await readAndRecord(user);
      await waitFor(() => expect(onStep).toHaveBeenCalledWith('account'));
      expect(m.toast).toHaveBeenCalledWith({ title: `Refused: ${code}`, tone: 'bad' });
      // The fields come back as typed; only a taken handle is marked.
      expect(useEntryStore.getState()).toMatchObject({
        hold: null,
        recorded: false,
        account: null,
        fields: FIELDS,
        taken: null,
      });
    },
  );

  it('keeps an existing account on the terms for any refusal: it has no Account step', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:acceptTerms').mockRejectedValueOnce(
      new ConvexError({ code: 'account_required', message: 'Refused.' }),
    );
    render(<TermsPage />);
    await readAndRecord(user);
    await waitFor(() => expect(m.toast).toHaveBeenCalledWith({ title: 'Refused.', tone: 'bad' }));
    expect(useEntryStore.getState().hold).toBeNull();
    expect(screen.getByRole('button', { name: 'Record acceptance' })).toBeInTheDocument();
  });
});

describe('/terms', () => {
  it('records an existing account’s acceptance without an account, and counts its context', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, termsVersion: undefined });
    render(<TermsPage />);
    expect(screen.queryByText('2 of 5')).toBeNull();
    await readAndRecord(user);
    await waitFor(() => expect(mutation('consent:acceptTerms')).toHaveBeenCalled());
    expect(mutation('consent:acceptTerms').mock.calls[0]?.[0]).not.toHaveProperty('account');
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('terms_accepted', { context: 'returning' }),
    );
    expect(m.capture).not.toHaveBeenCalledWith('onboarding_completed');
  });

  it('draws the receipt for a repeat acceptance, but doesn’t count it again', async () => {
    // A second tab, or a retry after a lost answer: the server returns the first acceptance.
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, termsVersion: undefined });
    mutation('consent:acceptTerms').mockResolvedValue({ recordId: 'cr1', repeat: true });
    render(<TermsPage />);
    await readAndRecord(user);
    await waitFor(() => expect(useEntryStore.getState()).toMatchObject({ recorded: true }));
    expect(m.capture).not.toHaveBeenCalledWith('terms_accepted', expect.anything());
    expect(m.capture).not.toHaveBeenCalledWith('onboarding_completed');
  });

  it('re-arms the end when the server says it wasn’t read, and lets the hold go', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:acceptTerms').mockRejectedValueOnce(
      new ConvexError({ code: 'terms_not_read', message: '' }),
    );
    render(<TermsPage />);
    await readAndRecord(user);
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Please read the terms to the end before you accept them.',
        tone: 'bad',
      }),
    );
    expect(useEntryStore.getState().hold).toBeNull();
    // Re-armed: the stub sees the end again, and the server is asked again.
    await waitFor(() => expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledTimes(2));
  });

  it('says a plain-string refusal with core’s fallback, never the raw string', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:acceptTerms').mockRejectedValueOnce(new ConvexError('Not authenticated'));
    render(<TermsPage />);
    await readAndRecord(user);
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Something went wrong. Please try again.',
        tone: 'bad',
      }),
    );
  });

  it('says the profile gate’s own plain-string refusal as it is, as the phone does', async () => {
    const user = userEvent.setup();
    // Lapsed by this tab's clock, which runs ahead of the server's.
    fakes.queries.set('profiles:current', { ...LIVE, status: 'suspended', suspendedUntil: 1 });
    mutation('consent:acceptTerms').mockRejectedValueOnce(new ConvexError('Account is suspended'));
    render(<TermsPage />);
    await readAndRecord(user);
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({ title: 'Account is suspended', tone: 'bad' }),
    );
    expect(useEntryStore.getState().hold).toBeNull();
  });

  it('draws the receipt with Continue when no questions are due, and lets go on it', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', LIVE);
    fakes.queries.set('consent:latestTermsReceipt', { email: null, copy: 'not_sent' });
    holdForReceipt();
    recordReceipt();
    render(<TermsPage />);
    expect(screen.getByText(/We couldn’t email you a copy/)).toBeInTheDocument();
    expect(screen.queryByText('Next: Know Before You Go')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useEntryStore.getState().hold).toBeNull();
  });

  it('says nothing about the copy while it is pending with no address yet', () => {
    fakes.queries.set('profiles:current', { ...LIVE, knowBeforeYouGoAt: undefined });
    fakes.queries.set('consent:latestTermsReceipt', { email: null, copy: 'pending' });
    holdForReceipt();
    recordReceipt();
    render(<TermsPage />);
    expect(screen.queryByText(/email you a copy/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start the questions' })).toBeInTheDocument();
  });
});

describe('/know-before-you-go', () => {
  async function answerAll(user: ReturnType<typeof userEvent.setup>) {
    for (const question of KNOW_BEFORE_YOU_GO.questions) {
      await user.click(screen.getByRole('button', { name: question.right }));
      await user.click(
        screen.getByRole('button', {
          name: question === KNOW_BEFORE_YOU_GO.questions.at(-1) ? 'Finish' : 'Next question',
        }),
      );
    }
  }

  it('asks a first time straight away, then writes the completion from all seven', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', {
      ...LIVE,
      knowBeforeYouGoAt: undefined,
      welcomeStep: 'home',
    });
    render(<KnowBeforeYouGoPage />);
    expect(screen.getByText('3 of 5')).toBeInTheDocument();
    await answerAll(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(mutation('consent:completeKnowBeforeYouGo')).toHaveBeenCalledWith({
        version: KNOW_BEFORE_YOU_GO.version,
        hash: KNOW_BEFORE_YOU_GO_SHA256,
        termsVersion: TERMS.version,
        termsHash: TERMS_SHA256,
        surface: 'web',
        userAgent: navigator.userAgent,
        clientSessionId: 'sess_1',
      }),
    );
    expect(m.capture).toHaveBeenCalledWith('know_before_you_go_completed', { flavor: 'first_run' });
  });

  it('doesn’t count a completion the server says was a repeat', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, knowBeforeYouGoAt: undefined });
    mutation('consent:completeKnowBeforeYouGo').mockResolvedValue({ season: null, repeat: true });
    render(<KnowBeforeYouGoPage />);
    await answerAll(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mutation('consent:completeKnowBeforeYouGo')).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(m.capture).not.toHaveBeenCalledWith('know_before_you_go_completed', expect.anything());
  });

  it('says the server’s own can’t-act refusal of a completion as it is', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, knowBeforeYouGoAt: undefined });
    mutation('consent:completeKnowBeforeYouGo').mockRejectedValueOnce(
      new ConvexError('Account is not active'),
    );
    render(<KnowBeforeYouGoPage />);
    await answerAll(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({ title: 'Account is not active', tone: 'bad' }),
    );
    expect(m.toast).toHaveBeenCalledOnce();
  });

  it('opens a season’s asking on its card; Not now signs out and counts it', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, knowBeforeYouGoAt: Date.UTC(2025, 10, 16) });
    fakes.queries.set('consent:watchAnchor', {
      season: 'winter-2026-27',
      label: 'Winter 2026–27',
      openedAt: Date.UTC(2026, 10, 20),
    });
    render(<KnowBeforeYouGoPage />);
    expect(screen.getByText('Winter 2026–27')).toBeInTheDocument();
    expect(screen.queryByText('3 of 5')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Not now — sign out' }));
    expect(m.capture).toHaveBeenCalledWith('season_check_signed_out');
    expect(m.signOut).toHaveBeenCalledOnce();
  });

  it('stops on a blocking update screen when the server doesn’t know its words, and offers a reload', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, knowBeforeYouGoAt: undefined });
    mutation('consent:completeKnowBeforeYouGo').mockRejectedValue(
      new ConvexError({ code: 'client_outdated', message: 'This version of Gli is out of date.' }),
    );
    render(<KnowBeforeYouGoPage />);
    await answerAll(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Time for an update' })).toBeInTheDocument();
    expect(m.toast).toHaveBeenCalledOnce();
    // Never back to the first question: answering the same words again can't help.
    expect(screen.queryByText(KNOW_BEFORE_YOU_GO.questions[0]?.prompt ?? 'missing')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(m.reload).toHaveBeenCalledOnce();
    expect(mutation('consent:completeKnowBeforeYouGo')).toHaveBeenCalledOnce();
  });

  it('opens on the first question, never the season card, straight from the receipt', async () => {
    const user = userEvent.setup();
    // A returning skater whose terms and questions are both due this season.
    const due = { ...LIVE, termsVersion: undefined, knowBeforeYouGoAt: Date.UTC(2025, 10, 16) };
    fakes.queries.set('profiles:current', due);
    fakes.queries.set('consent:watchAnchor', {
      season: 'winter-2026-27',
      label: 'Winter 2026–27',
      openedAt: Date.UTC(2026, 10, 20),
    });
    fakes.queries.set('consent:latestTermsReceipt', { email: 'k@example.test', copy: 'sent' });
    holdForReceipt();
    recordReceipt();
    const receipt = render(<TermsPage />);
    await user.click(screen.getByRole('button', { name: 'Start the questions' }));
    expect(useEntryStore.getState()).toMatchObject({ hold: null, questionsFromReceipt: true });
    receipt.unmount();

    render(<KnowBeforeYouGoPage />);
    expect(screen.queryByText('Winter 2026–27')).toBeNull();
    expect(
      screen.getByText(KNOW_BEFORE_YOU_GO.questions[0]?.prompt ?? 'missing'),
    ).toBeInTheDocument();
    // Still counted as the season's asking.
    await answerAll(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('know_before_you_go_completed', { flavor: 'season' }),
    );
  });

  it('draws nothing while the profile or the watch is loading', () => {
    fakes.queries.set('consent:watchAnchor', undefined);
    fakes.queries.set('profiles:current', LIVE);
    const { container } = render(<KnowBeforeYouGoPage />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('/welcome', () => {
  it('follows the profile’s own step, whatever the URL asked', async () => {
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
    const onStep = vi.fn();
    render(<WelcomePage step="profile" onStep={onStep} />);
    expect(screen.getByRole('heading', { name: 'Where are you based?' })).toBeInTheDocument();
    await waitFor(() => expect(onStep).toHaveBeenCalledWith('home', { replace: true }));
  });

  it('skips Home by advancing alone, and counts it', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'home' });
    expect(mutation('profiles:setHome')).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('welcome_step_finished', {
        step: 'home',
        outcome: 'skipped',
      }),
    );
  });

  it('saves the profile’s changes, then advances, on Open the map', async () => {
    const user = userEvent.setup();
    useEntryStore.setState({ homeTown: 'Hanover, NH' });
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'profile' });
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    expect(screen.getByDisplayValue('Hanover, NH')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Bio' }), 'Lunchtime skater');
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    await waitFor(() =>
      expect(mutation('profiles:updateProfile')).toHaveBeenCalledWith({
        bio: 'Lunchtime skater',
        homeTownLabel: 'Hanover, NH',
      }),
    );
    expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'profile' });
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('welcome_step_finished', {
        step: 'profile',
        outcome: 'saved',
      }),
    );
  });

  it('says a home the server didn’t take as a toast, and stays', async () => {
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
    mutation('profiles:setHome').mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) =>
          ok({ coords: { latitude: 43.7, longitude: -72.29 } }),
      },
    });
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await act(async () => {
      screen.getByRole('button', { name: 'Use my current location' }).click();
    });
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Your home wasn’t saved. Try again in a moment.',
        tone: 'bad',
      }),
    );
    expect(mutation('consent:advanceWelcome')).not.toHaveBeenCalled();
  });

  it('says the server’s own can’t-act refusal of a home as it is', async () => {
    // Lapsed by this tab's clock, which runs ahead of the server's.
    fakes.queries.set('profiles:current', {
      ...LIVE,
      status: 'suspended',
      suspendedUntil: 1,
      welcomeStep: 'home',
    });
    mutation('profiles:setHome').mockRejectedValueOnce(new ConvexError('Account is suspended'));
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) =>
          ok({ coords: { latitude: 43.7, longitude: -72.29 } }),
      },
    });
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await act(async () => {
      screen.getByRole('button', { name: 'Use my current location' }).click();
    });
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({ title: 'Account is suspended', tone: 'bad' }),
    );
    expect(m.toast).toHaveBeenCalledOnce();
    expect(mutation('consent:advanceWelcome')).not.toHaveBeenCalled();
  });

  it('draws nothing until the profile has loaded', () => {
    fakes.queries.set('profiles:current', undefined);
    const { container } = render(<WelcomePage step="home" onStep={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useUsernameAvailability', () => {
  it('asks once a typed handle holds still, and answers only for the handle on screen', async () => {
    fakes.queries.set('profiles:usernameAvailable', (args: unknown) => {
      const { username } = args as { username: string };
      return username === 'kdonovan'
        ? { username, available: false, reason: 'taken' }
        : { username, available: true };
    });
    const { result, rerender } = renderHook(({ u }) => useUsernameAvailability(u), {
      initialProps: { u: 'kdonovan' as string | null },
    });
    // A handle the step opens with (coming back to it) is asked at once.
    expect(result.current).toBe('taken');
    rerender({ u: 'katedonovan' });
    // The old answer is for another handle: unknown until the new one has held still.
    expect(result.current).toBe('unknown');
    await waitFor(() => expect(result.current).toBe('free'));
    rerender({ u: null });
    expect(result.current).toBe('unknown');
  });

  it('reads an invalid handle as unknown, never as free', async () => {
    fakes.queries.set('profiles:usernameAvailable', {
      username: 'k_',
      available: false,
      reason: 'invalid',
    });
    const { result } = renderHook(() => useUsernameAvailability('k_'));
    await new Promise((r) => setTimeout(r, 350));
    expect(result.current).toBe('unknown');
  });
});

describe('the reading’s start', () => {
  it('says a failed open once, and, reaching the end with none, says why and starts again', async () => {
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:openTerms').mockRejectedValueOnce(new Error('offline'));
    render(<TermsPage />);
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Something went wrong. Please try again.',
        tone: 'bad',
      }),
    );
    // The end was seen, but there was no reading to record it on: why, then a new reading, no
    // reach — never a silent jump back to the top.
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2));
    expect(m.toast).toHaveBeenLastCalledWith({
      title: CONSENT_REFUSAL_MESSAGES.terms_not_opened,
      tone: 'bad',
    });
    expect(m.toast).toHaveBeenCalledTimes(2);
    expect(mutation('consent:reachTermsEnd')).not.toHaveBeenCalled();
  });
});

/**
 * The end marker's place on screen, set by the test: every observer hears the state it starts in,
 * and every change after.
 */
class Visibility {
  static visible = true;
  static all: Visibility[] = [];
  private live = true;
  private targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    Visibility.all.push(this);
  }
  private tell() {
    if (!this.live) return;
    const v = Visibility.visible;
    this.callback(
      this.targets.map(
        (target) =>
          ({
            target,
            isIntersecting: v,
            intersectionRatio: v ? 1 : 0,
          }) as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
  observe(target: Element) {
    this.targets.push(target);
    queueMicrotask(() => this.tell());
  }
  disconnect() {
    this.live = false;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  static scroll(visible: boolean) {
    Visibility.visible = visible;
    for (const o of [...Visibility.all]) o.tell();
  }
}

describe('a failing end', () => {
  // Restored here, not on a test's last line: a failing assertion must not leak the spy.
  const spies: Array<{ mockRestore: () => void }> = [];
  const spyOnScrollTo = () => {
    const spy = vi.spyOn(Element.prototype, 'scrollTo');
    spies.push(spy);
    return spy;
  };
  beforeEach(() => {
    Visibility.visible = true;
    Visibility.all = [];
    vi.stubGlobal('IntersectionObserver', Visibility);
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('is said once while the end sits on screen, and tried again only after it leaves and comes back', async () => {
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:reachTermsEnd').mockRejectedValue(new Error('offline'));
    render(<TermsPage />);
    await waitFor(() => expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledOnce());
    // Settled: no retry storm while the marker stays in view.
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledOnce();
    expect(m.toast).toHaveBeenCalledOnce();
    // Scrolled away and back: one more try.
    await act(async () => Visibility.scroll(false));
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledTimes(2);
    expect(m.toast).toHaveBeenCalledTimes(2);
  });

  /** An answer after a round trip: `null`, or the refusal given. */
  const later = (refusal?: Error, ms = 5) =>
    new Promise((resolve, reject) =>
      setTimeout(() => (refusal ? reject(refusal) : resolve(null)), ms),
    );
  /** The skater opens the full-screen reader with its end out of view, then scrolls to it. */
  async function readInFullScreen(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Open in full-screen' }));
    await screen.findByRole('dialog');
    await act(async () => Visibility.scroll(true));
  }
  /** Whether the full-screen reader's body was scrolled to its top. */
  const fullScreenToTop = (scrollTo: { mock: { contexts: unknown[]; calls: unknown[][] } }) =>
    scrollTo.mock.contexts.some(
      (el, i) =>
        (el as HTMLElement).dataset?.slot === 'dialog-body' &&
        (scrollTo.mock.calls[i]?.[0] as { top?: number } | undefined)?.top === 0,
    );

  it('a failing open, reached in full-screen, starts again from its top once, not in a loop', async () => {
    const user = userEvent.setup();
    const scrollTo = spyOnScrollTo();
    Visibility.visible = false;
    fakes.queries.set('profiles:current', LIVE);
    // The first open is still out when the end is reached, then refused: the end waits on it. Every
    // open after it is refused after a round trip.
    let refuseFirst: (e: Error) => void = () => {};
    mutation('consent:openTerms')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            refuseFirst = reject;
          }),
      )
      .mockImplementation(() => later(new Error('offline'), 100));
    render(<TermsPage />);
    await readInFullScreen(user);
    await act(async () => refuseFirst(new Error('offline')));
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2));
    // Settled: the end still sits in view, nothing opens again by itself, and the one thing said is
    // why the reading starts again — the new reading's own failed opening is quiet.
    await new Promise((r) => setTimeout(r, 350));
    expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2);
    expect(m.toast).toHaveBeenCalledExactlyOnceWith({
      title: CONSENT_REFUSAL_MESSAGES.terms_not_opened,
      tone: 'bad',
    });
    expect(mutation('consent:reachTermsEnd')).not.toHaveBeenCalled();
    expect(fullScreenToTop(scrollTo)).toBe(true);
    // Read down to the end again, still unopened: said once more, and one more try.
    await act(async () => Visibility.scroll(false));
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 350));
    expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(3);
    expect(m.toast).toHaveBeenCalledTimes(2);
  });

  it('a lost reading, reached in full-screen, is read again from its top before the end counts', async () => {
    const user = userEvent.setup();
    const scrollTo = spyOnScrollTo();
    Visibility.visible = false;
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:reachTermsEnd').mockImplementationOnce(() =>
      later(new ConvexError({ code: 'terms_not_opened', message: 'Please read them again.' })),
    );
    mutation('consent:openTerms').mockImplementation(() => later());
    render(<TermsPage />);
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledOnce());
    await readInFullScreen(user);
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2));
    // The new reading was not stamped at once: the end must be reached again.
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledOnce();
    expect(fullScreenToTop(scrollTo)).toBe(true);
    await act(async () => Visibility.scroll(false));
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledTimes(2));
    expect(mutation('consent:reachTermsEnd')).toHaveBeenLastCalledWith({
      termsVersion: TERMS.version,
      termsHash: TERMS_SHA256,
      via: 'fullscreen',
    });
  });

  it('tries a failed open again as the skater scrolls, quietly, so the end finds a reading', async () => {
    // The clock the retries are spaced on, pinned (D243) and moved by hand.
    let clock = Date.UTC(2026, 10, 24, 15);
    spies.push(vi.spyOn(Date, 'now').mockImplementation(() => clock));
    Visibility.visible = false;
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:openTerms').mockRejectedValueOnce(new Error('offline'));
    const { container } = render(<TermsPage />);
    await waitFor(() => expect(m.toast).toHaveBeenCalledOnce());
    const reader = () =>
      container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') as HTMLElement;
    // Scrolling inside the gap: no new try.
    clock += TERMS_OPEN_RETRY_GAP_MS - 1;
    fireEvent.scroll(reader());
    expect(mutation('consent:openTerms')).toHaveBeenCalledOnce();
    // Past it: one quiet try, which opens the reading.
    clock += 1;
    fireEvent.scroll(reader());
    fireEvent.scroll(reader());
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2));
    // The end, reached later, is stamped on that reading: no restart, nothing more said.
    clock += 60_000;
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-disabled'));
    expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2);
    expect(m.toast).toHaveBeenCalledOnce();
  });

  it('a retry that fails too says nothing; the end, still unopened, says why', async () => {
    let clock = Date.UTC(2026, 10, 24, 15);
    spies.push(vi.spyOn(Date, 'now').mockImplementation(() => clock));
    Visibility.visible = false;
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:openTerms')
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'));
    const { container } = render(<TermsPage />);
    await waitFor(() => expect(m.toast).toHaveBeenCalledOnce());
    clock += TERMS_OPEN_RETRY_GAP_MS;
    fireEvent.scroll(
      container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') as HTMLElement,
    );
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.toast).toHaveBeenCalledOnce();
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(3));
    expect(m.toast).toHaveBeenLastCalledWith({
      title: CONSENT_REFUSAL_MESSAGES.terms_not_opened,
      tone: 'bad',
    });
    expect(m.toast).toHaveBeenCalledTimes(2);
    expect(mutation('consent:reachTermsEnd')).not.toHaveBeenCalled();
  });

  it('a retry whose answer changes where the skater goes is said: out of date, or can’t act', async () => {
    let clock = Date.UTC(2026, 10, 24, 15);
    spies.push(vi.spyOn(Date, 'now').mockImplementation(() => clock));
    Visibility.visible = false;
    fakes.queries.set('profiles:current', { ...LIVE, status: 'suspended', suspendedUntil: 1 });
    mutation('consent:openTerms')
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new ConvexError('Account is suspended'))
      .mockRejectedValueOnce(
        new ConvexError({
          code: 'client_outdated',
          message: 'This version of Gli is out of date.',
        }),
      );
    const { container } = render(<TermsPage />);
    await waitFor(() => expect(m.toast).toHaveBeenCalledOnce());
    const scroll = () =>
      fireEvent.scroll(
        container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') as HTMLElement,
      );
    clock += TERMS_OPEN_RETRY_GAP_MS;
    scroll();
    await waitFor(() =>
      expect(m.toast).toHaveBeenLastCalledWith({ title: 'Account is suspended', tone: 'bad' }),
    );
    clock += TERMS_OPEN_RETRY_GAP_MS;
    scroll();
    expect(await screen.findByRole('heading', { name: 'Time for an update' })).toBeInTheDocument();
    expect(m.toast).toHaveBeenCalledTimes(3);
    expect(mutation('consent:openTerms')).toHaveBeenCalledTimes(3);
  });

  it('records on the way back once the server answers', async () => {
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:reachTermsEnd').mockRejectedValueOnce(new Error('offline'));
    render(<TermsPage />);
    await waitFor(() => expect(m.toast).toHaveBeenCalledOnce());
    await act(async () => Visibility.scroll(false));
    await act(async () => Visibility.scroll(true));
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-disabled'));
    expect(m.capture).toHaveBeenCalledWith('terms_read_to_end', { via: 'inline' });
  });
});

describe('an out-of-date tab (client_outdated)', () => {
  const OUTDATED = new ConvexError({
    code: 'client_outdated',
    message: 'This version of Gli is out of date.',
  });

  it('stops on the update screen when the open is refused, and never opens again by itself', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:openTerms').mockRejectedValue(OUTDATED);
    render(<TermsPage />);
    expect(await screen.findByRole('heading', { name: 'Time for an update' })).toBeInTheDocument();
    expect(screen.getByText(/Reload the page to get the latest version/)).toBeInTheDocument();
    // Settled: no restart, no reach, one toast.
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation('consent:openTerms')).toHaveBeenCalledOnce();
    expect(mutation('consent:reachTermsEnd')).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(m.reload).toHaveBeenCalledOnce();
  });

  it('stops when the end is refused, without starting the reading again', async () => {
    fakes.queries.set('profiles:current', LIVE);
    mutation('consent:reachTermsEnd').mockRejectedValue(OUTDATED);
    render(<TermsPage />);
    expect(await screen.findByRole('heading', { name: 'Time for an update' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation('consent:openTerms')).toHaveBeenCalledOnce();
    expect(mutation('consent:reachTermsEnd')).toHaveBeenCalledOnce();
  });

  it('stops when the acceptance is refused (the notice alone out of step), and lets the hold go', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', null);
    carryAccount(FIELDS, ACCOUNT);
    mutation('consent:acceptTerms').mockRejectedValue(OUTDATED);
    const onStep = vi.fn();
    render(<OnboardingPage step="terms" onStep={onStep} />);
    await readAndRecord(user);
    expect(await screen.findByRole('heading', { name: 'Time for an update' })).toBeInTheDocument();
    expect(useEntryStore.getState().hold).toBeNull();
    // Not an Account refusal, and never described as new terms (core's words hold that).
    expect(onStep).not.toHaveBeenCalledWith('account');
    expect(m.toast).toHaveBeenCalledWith({
      title: 'This version of Gli is out of date.',
      tone: 'bad',
    });
    expect(mutation('consent:acceptTerms')).toHaveBeenCalledOnce();
    expect(mutation('consent:openTerms')).toHaveBeenCalledOnce();
  });
});

describe('Home’s picked address', () => {
  it('saves its point, carries its town to Profile, and counts it saved', async () => {
    const user = userEvent.setup();
    m.suggest.mockImplementation(async ({ text }: { text: string }) => ({
      status: 'ok',
      suggestions:
        text.length >= 3
          ? [
              {
                label: '14 School Street, Hanover, NH 03755, USA',
                lat: 43.7,
                lng: -72.29,
                town: 'Hanover, NH',
              },
            ]
          : [],
      attribution: 'Powered by Geoapify',
    }));
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.type(await screen.findByRole('combobox'), '14 School');
    await user.click(await screen.findByRole('option', { name: /14 School Street/ }));
    expect(useEntryStore.getState().homeTown).toBe('Hanover, NH');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() =>
      expect(mutation('profiles:setHome')).toHaveBeenCalledWith({
        homeCoord: { lat: 43.7, lng: -72.29 },
      }),
    );
    expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'home' });
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('welcome_step_finished', {
        step: 'home',
        outcome: 'saved',
      }),
    );
  });

  it('says a location the browser won’t share in the field, and saves nothing', async () => {
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('denied')),
      },
    });
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await act(async () => {
      screen.getByRole('button', { name: 'Use my current location' }).click();
    });
    expect(await screen.findByText(/We couldn’t get your location/)).toBeInTheDocument();
    expect(mutation('profiles:setHome')).not.toHaveBeenCalled();
  });
});

/** The address provider, offering one Hanover address for anything three characters long. */
function offerHanover() {
  m.suggest.mockImplementation(async ({ text }: { text: string }) => ({
    status: 'ok',
    suggestions:
      text.length >= 3
        ? [
            {
              label: '14 School Street, Hanover, NH 03755, USA',
              lat: 43.7,
              lng: -72.29,
              town: 'Hanover, NH',
            },
          ]
        : [],
    attribution: 'Powered by Geoapify',
  }));
}

/** A browser whose location answers when the test says (`fix`), or never. */
function slowGeolocation() {
  const pending: Array<(p: unknown) => void> = [];
  vi.stubGlobal('navigator', {
    ...navigator,
    geolocation: {
      getCurrentPosition: (ok: (p: unknown) => void) => {
        pending.push(ok);
      },
    },
  });
  return {
    fix: (lat: number, lng: number) => {
      for (const ok of pending.splice(0)) ok({ coords: { latitude: lat, longitude: lng } });
    },
  };
}

describe('Home’s town for the Profile step', () => {
  async function pick(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByRole('combobox'), '14 School');
    await user.click(await screen.findByRole('option', { name: /14 School Street/ }));
    expect(useEntryStore.getState().homeTown).toBe('Hanover, NH');
  }

  beforeEach(() => {
    offerHanover();
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
  });

  it('is forgotten when the picked address is edited', async () => {
    const user = userEvent.setup();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await pick(user);
    await user.type(screen.getByRole('combobox'), 'x');
    expect(useEntryStore.getState().homeTown).toBeNull();
  });

  it('is forgotten when the step is skipped', async () => {
    const user = userEvent.setup();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await pick(user);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(useEntryStore.getState().homeTown).toBeNull();
    expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'home' });
  });

  it('is forgotten when the current location saves a different place', async () => {
    const user = userEvent.setup();
    const geo = slowGeolocation();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await pick(user);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    await act(async () => geo.fix(44.1, -71.5));
    await waitFor(() =>
      expect(mutation('profiles:setHome')).toHaveBeenCalledWith({
        homeCoord: { lat: 44.1, lng: -71.5 },
      }),
    );
    expect(useEntryStore.getState().homeTown).toBeNull();
  });

  it('goes with the picked address when the location’s save fails: the field and the town agree', async () => {
    const user = userEvent.setup();
    const geo = slowGeolocation();
    mutation('profiles:setHome').mockRejectedValueOnce(new Error('offline'));
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await pick(user);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    await act(async () => geo.fix(44.1, -71.5));
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Your home wasn’t saved. Try again in a moment.',
        tone: 'bad',
      }),
    );
    // No town without its address, and no address left on the field without its town.
    expect(useEntryStore.getState().homeTown).toBeNull();
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  });

  it('goes with the picked address when the skip fails: the field and the town agree', async () => {
    const user = userEvent.setup();
    mutation('consent:advanceWelcome').mockRejectedValueOnce(new Error('offline'));
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await pick(user);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(m.toast).toHaveBeenCalledOnce());
    expect(useEntryStore.getState().homeTown).toBeNull();
    expect(screen.getByRole('combobox')).toHaveValue('');
  });
});

describe('Home’s location, arriving late', () => {
  beforeEach(() => {
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'home' });
  });

  it('never holds Skip while it is read, and a fix after the skip is dropped', async () => {
    const user = userEvent.setup();
    // No address provider, and a permission prompt nobody answers: Skip is the only way on.
    m.suggest.mockImplementation(
      async () => ({ status: 'unavailable', reason: 'off', suggestions: [] }) as never,
    );
    const geo = slowGeolocation();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() =>
      expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'home' }),
    );
    await act(async () => geo.fix(44.1, -71.5));
    await new Promise((r) => setTimeout(r, 20));
    expect(mutation('profiles:setHome')).not.toHaveBeenCalled();
  });

  it('keeps Save usable for a picked address while it is read, and drops the late fix', async () => {
    const user = userEvent.setup();
    offerHanover();
    const geo = slowGeolocation();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.type(await screen.findByRole('combobox'), '14 School');
    await user.click(await screen.findByRole('option', { name: /14 School Street/ }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
    // The save fails: the late fix must still not save in its place.
    mutation('profiles:setHome').mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(mutation('profiles:setHome')).toHaveBeenCalledOnce());
    await act(async () => geo.fix(44.1, -71.5));
    await new Promise((r) => setTimeout(r, 20));
    expect(mutation('profiles:setHome')).toHaveBeenCalledOnce();
    expect(mutation('profiles:setHome')).toHaveBeenCalledWith({
      homeCoord: { lat: 43.7, lng: -72.29 },
    });
  });

  it('is dropped when the step has moved on before it lands', async () => {
    const user = userEvent.setup();
    const geo = slowGeolocation();
    const page = render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    // Another tab finished Home meanwhile: the profile says Profile now.
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'profile' });
    page.rerender(<WelcomePage step="home" onStep={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Complete your profile' })).toBeInTheDocument();
    await act(async () => geo.fix(44.1, -71.5));
    await new Promise((r) => setTimeout(r, 20));
    expect(mutation('profiles:setHome')).not.toHaveBeenCalled();
    expect(mutation('consent:advanceWelcome')).not.toHaveBeenCalled();
  });

  it('stops looking busy after a while, and still saves a fix nobody superseded', async () => {
    // A permission prompt answered slowly: the button came back, the skater chose nothing else, and
    // the fix is still the home.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const geo = slowGeolocation();
      render(<WelcomePage step="home" onStep={vi.fn()} />);
      const locate = () => screen.getByRole('button', { name: 'Use my current location' });
      await act(async () => locate().click());
      expect(locate()).toHaveAttribute('aria-busy', 'true');
      await act(() => vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS));
      expect(locate()).not.toHaveAttribute('aria-busy');
      await act(async () => geo.fix(44.1, -71.5));
      expect(mutation('profiles:setHome')).toHaveBeenCalledWith({
        homeCoord: { lat: 44.1, lng: -71.5 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is dropped when the skater turned to a typed address, which then saves', async () => {
    const user = userEvent.setup();
    offerHanover();
    const geo = slowGeolocation();
    render(<WelcomePage step="home" onStep={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    await user.type(await screen.findByRole('combobox'), '14 School');
    await user.click(await screen.findByRole('option', { name: /14 School Street/ }));
    await act(async () => geo.fix(44.1, -71.5));
    await new Promise((r) => setTimeout(r, 20));
    expect(mutation('profiles:setHome')).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() =>
      expect(mutation('profiles:setHome')).toHaveBeenCalledWith({
        homeCoord: { lat: 43.7, lng: -72.29 },
      }),
    );
    expect(mutation('profiles:setHome')).toHaveBeenCalledOnce();
  });
});

describe('Profile’s visibility', () => {
  it('shows a re-introduced account’s private profile off, and leaves it so unless switched', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', {
      ...LIVE,
      profileVisibility: 'private',
      welcomeStep: 'profile',
    });
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: /Public profile/ });
    expect(toggle).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    await waitFor(() =>
      expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'profile' }),
    );
    // No town to save, nothing changed: no write at all.
    expect(mutation('profiles:updateProfile')).not.toHaveBeenCalled();
  });

  it('writes public only when a private account’s switch is turned on', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', {
      ...LIVE,
      profileVisibility: 'private',
      welcomeStep: 'profile',
    });
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    await user.click(screen.getByRole('switch', { name: /Public profile/ }));
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    await waitFor(() =>
      expect(mutation('profiles:updateProfile')).toHaveBeenCalledWith({
        profileVisibility: 'public',
      }),
    );
  });

  it('shows a new account’s public profile on', () => {
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'profile' });
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    expect(screen.getByRole('switch', { name: /Public profile/ })).toBeChecked();
  });
});

describe('Profile’s save', () => {
  it('says the server’s own can’t-act refusal as it is', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, status: 'banned', welcomeStep: 'profile' });
    mutation('profiles:updateProfile').mockRejectedValueOnce(
      new ConvexError('Account is not active'),
    );
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Bio' }), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({ title: 'Account is not active', tone: 'bad' }),
    );
    expect(m.toast).toHaveBeenCalledOnce();
    expect(mutation('consent:advanceWelcome')).not.toHaveBeenCalled();
  });

  it('says a profile the server didn’t take as a toast, and doesn’t advance', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'profile' });
    mutation('profiles:updateProfile').mockRejectedValueOnce(new Error('offline'));
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Bio' }), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Open the map' }));
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith({
        title: 'Your profile wasn’t saved. Try again in a moment.',
        tone: 'bad',
      }),
    );
    expect(mutation('consent:advanceWelcome')).not.toHaveBeenCalled();
  });

  it('skips by advancing alone, saving nothing typed', async () => {
    const user = userEvent.setup();
    fakes.queries.set('profiles:current', { ...LIVE, welcomeStep: 'profile' });
    render(<WelcomePage step="profile" onStep={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Bio' }), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(mutation('consent:advanceWelcome')).toHaveBeenCalledWith({ from: 'profile' }),
    );
    expect(mutation('profiles:updateProfile')).not.toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalledWith('welcome_step_finished', {
      step: 'profile',
      outcome: 'skipped',
    });
  });
});

describe('profilePatch', () => {
  const saved = { bio: '', town: '', isPublic: true };
  const draft = { bio: '', town: 'Hanover, NH', isPublic: true, showTown: true };

  it('saves the town only while Show my town is on', () => {
    expect(profilePatch(draft, saved)).toEqual({ homeTownLabel: 'Hanover, NH' });
    expect(profilePatch({ ...draft, showTown: false }, saved)).toEqual({});
  });

  it('writes visibility only when the switch differs from the row', () => {
    const quiet = { ...draft, showTown: false };
    expect(profilePatch({ ...quiet, isPublic: false }, saved)).toEqual({
      profileVisibility: 'private',
    });
    expect(profilePatch(quiet, saved)).toEqual({});
    const reintroduced = { ...saved, isPublic: false };
    expect(profilePatch({ ...quiet, isPublic: false }, reintroduced)).toEqual({});
    expect(profilePatch(quiet, reintroduced)).toEqual({ profileVisibility: 'public' });
  });

  it('sends nothing that didn’t change, and trims what did', () => {
    expect(
      profilePatch({ ...draft, bio: ' Hi ' }, { bio: 'Hi', town: 'Hanover, NH', isPublic: true }),
    ).toEqual({});
    expect(profilePatch({ ...draft, bio: ' Hello ' }, { ...saved, bio: 'Hi' })).toEqual({
      bio: 'Hello',
      homeTownLabel: 'Hanover, NH',
    });
  });
});
