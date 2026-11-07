import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

const m = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  suggest: vi.fn(),
  user: null as unknown,
  draft: false,
}));

vi.mock('convex/react', () => ({ ...convexReact, useAction: () => m.suggest }));
vi.mock('@clerk/tanstack-react-start', () => ({ useUser: () => ({ user: m.user }) }));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => m.signOut }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => null,
  useSheetAttempt: () => null,
  readStoredSheet: () => ({
    sheet: {
      draftId: 'd',
      idempotencyKey: 'k',
      title: '',
      body: '',
      reports: [{ bodyName: 'Mascoma Lake' }],
      mode: { kind: 'create' },
      door: 'body',
      openedAtMs: Date.now(),
      dirty: m.draft,
    },
    attempt: null,
  }),
}));

import { resetGeocoderSession } from './geocoder';
import { SettingsPage } from './SettingsPage';

const PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: false,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: true,
  greatReportNearby: true,
};

function me(over: Record<string, unknown> = {}) {
  return {
    _id: 'p1',
    displayName: 'Kate Donovan',
    username: 'kdonovan',
    role: 'member',
    homeTownLabel: 'Hanover, NH',
    bio: 'Lunchtime skater.',
    profileVisibility: 'public',
    dateOfBirth: new Date(1990, 0, 1).getTime(),
    notificationPrefs: PREFS,
    channelPrefs: { push: true, email: false },
    allRadiusMinutes: 30,
    greatRadiusMinutes: 90,
    homeCoord: { lat: 43.7, lng: -72.29 },
    ...over,
  };
}

const navigate = vi.fn();
function page(section: Parameters<typeof SettingsPage>[0]['section'], homeView?: 'edit') {
  return render(
    <SettingsPage section={section} {...(homeView ? { homeView } : {})} onNavigate={navigate} />,
  );
}
const mutation = (name: string) => {
  let fn = fakes.mutations.get(name);
  if (!fn) {
    fn = vi.fn().mockResolvedValue(null);
    fakes.mutations.set(name, fn);
  }
  return fn;
};

// jsdom has no Web Animations; the kit Skeleton's shimmer asks for one.
beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

beforeEach(() => {
  resetFakes();
  resetGeocoderSession();
  navigate.mockClear();
  m.signOut.mockClear();
  m.suggest.mockReset();
  m.suggest.mockResolvedValue({ status: 'ok', attribution: 'A', suggestions: [] });
  m.draft = false;
  m.user = {
    primaryEmailAddress: { emailAddress: 'kate@donovan.net' },
    createEmailAddress: vi.fn(),
  };
  fakes.queries.set('profiles:current', me());
  fakes.queries.set('strava:connectionStatus', {
    configured: true,
    connected: true,
    connectedAt: new Date(2026, 11, 3).getTime(),
  });
});
afterEach(() => vi.useRealTimers());

describe('the frame', () => {
  it('lists the sections as links, marks the open one, and moves with the arrows', () => {
    page('account');
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const account = within(nav).getByRole('link', { name: 'Account' });
    expect(account).toHaveAttribute('aria-current', 'page');
    expect(account).toHaveAttribute('href', '/settings/account');
    account.focus();
    fireEvent.keyDown(account, { key: 'ArrowDown' });
    expect(within(nav).getByRole('link', { name: 'Your profile' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(within(nav).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(account).toHaveFocus();
    fireEvent.keyDown(account, { key: 'End' });
    expect(within(nav).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Notifications' }));
    expect(navigate).toHaveBeenCalledWith('/settings/notifications');
  });

  it('shows a skeleton until the profile lands', () => {
    fakes.queries.set('profiles:current', undefined);
    page('account');
    expect(screen.getByRole('status', { name: 'Loading settings' })).toBeInTheDocument();
  });

  it('signs straight out with no draft', async () => {
    page('account');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })));
    expect(m.signOut).toHaveBeenCalled();
  });

  it('asks before signing out over a draft, and can open the draft instead', async () => {
    m.draft = true;
    page('account');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(m.signOut).not.toHaveBeenCalled();
    expect(screen.getByText('Sign out and discard your draft?')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out', pressed: true, hidden: true }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the draft' }));
    expect(navigate).toHaveBeenCalledWith('/settings/account?post=new');
  });

  it('while leaving: no profile section, the data section marked, the profile page falls back', () => {
    fakes.queries.set('profiles:current', me({ deletionRequestedAt: Date.now() }));
    page('profile');
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryByRole('link', { name: 'Your profile' })).toBeNull();
    expect(within(nav).getByText('Pending')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });
});

describe('account', () => {
  it('shows who you are and where each row goes', () => {
    page('account');
    expect(screen.getByText('@kdonovan', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('kate@donovan.net')).toBeInTheDocument();
    expect(screen.getByText('Connected · Garmin coming soon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View profile' }));
    expect(navigate).toHaveBeenCalledWith('/u/kdonovan');
    fireEvent.click(screen.getByRole('button', { name: 'Manage connected accounts' }));
    expect(navigate).toHaveBeenCalledWith('/settings/reporting');
  });

  it('changes the email by code', async () => {
    const address = {
      id: 'e2',
      emailAddress: 'kdonovan@fastmail.com',
      verification: { status: 'unverified' },
      prepareVerification: vi.fn().mockResolvedValue(null),
      attemptVerification: vi.fn().mockResolvedValue(null),
      destroy: vi.fn().mockResolvedValue(null),
    };
    const old = {
      id: 'e1',
      emailAddress: 'kate@donovan.net',
      verification: { status: 'verified' },
      linkedTo: [],
      prepareVerification: vi.fn(),
      destroy: vi.fn().mockResolvedValue(null),
    };
    m.user = {
      primaryEmailAddress: old,
      emailAddresses: [old],
      createEmailAddress: vi.fn().mockResolvedValue(address),
      update: vi.fn().mockResolvedValue(null),
      reload: vi.fn().mockResolvedValue(null),
    };
    page('account');
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    expect(screen.queryByRole('button', { name: 'Change email' })).toBeNull();
    fireEvent.change(screen.getByLabelText('New email'), {
      target: { value: 'kdonovan@fastmail.com' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Email me a code' })));
    expect(
      screen.getByText(/We sent a six-digit code to kdonovan@fastmail.com/),
    ).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send a new code' })));
    expect(address.prepareVerification).toHaveBeenCalledWith({ strategy: 'email_code' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Change email' })).toBeInTheDocument();
  });

  it('says so when the code can’t be sent', async () => {
    m.user = {
      primaryEmailAddress: { emailAddress: 'kate@donovan.net' },
      emailAddresses: [],
      createEmailAddress: vi.fn().mockRejectedValue(new Error('That address is taken.')),
    };
    page('account');
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'x@y.z' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Email me a code' })));
    expect(screen.getByRole('alert')).toHaveTextContent('That address is taken.');
  });

  it('summarizes an unconnected or unconfigured Strava', () => {
    fakes.queries.set('strava:connectionStatus', { configured: true, connected: false });
    const { unmount } = page('account');
    expect(screen.getByText('Strava · Garmin coming soon')).toBeInTheDocument();
    unmount();
    fakes.queries.set('strava:connectionStatus', { configured: false, connected: false });
    page('account');
    expect(screen.getByText('Garmin coming soon')).toBeInTheDocument();
  });
});

describe('your profile', () => {
  it('saves the town on a pause and the switch on a flip', async () => {
    vi.useFakeTimers();
    const update = mutation('profiles:updateProfile');
    page('profile');
    fireEvent.change(screen.getByDisplayValue('Hanover, NH'), {
      target: { value: 'Norwich, VT' },
    });
    expect(screen.getAllByText('Typing').length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(update).toHaveBeenCalledWith({ homeTownLabel: 'Norwich, VT' });
    fireEvent.change(screen.getByDisplayValue('Lunchtime skater.'), {
      target: { value: 'Mornings.' },
    });
    fireEvent.blur(screen.getByDisplayValue('Mornings.'));
    expect(update).toHaveBeenCalledWith({ bio: 'Mornings.' });
    fireEvent.click(screen.getByRole('switch', { name: 'Public profile' }));
    expect(update).toHaveBeenCalledWith({ profileVisibility: 'private' });
  });

  it('draws the photo from Clerk’s user, first, inside the masked region', () => {
    m.user = {
      primaryEmailAddress: { emailAddress: 'kate@donovan.net' },
      hasImage: true,
      imageUrl: 'https://img.clerk.com/kate.jpg',
      setProfileImage: vi.fn(),
    };
    page('profile');
    const circle = screen.getByRole('img', { name: 'Your photo' });
    expect(circle.closest('.ph-no-capture')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
  });

  it('keeps an under-18 profile private, with the switch held', () => {
    fakes.queries.set(
      'profiles:current',
      me({ dateOfBirth: Date.now() - 15 * 365 * 86_400_000, profileVisibility: 'private' }),
    );
    page('profile');
    const sw = screen.getByRole('switch', { name: 'Public profile' });
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/Under-18 profiles stay private/)).toBeInTheDocument();
  });
});

describe('home and drive time', () => {
  it('with no provider on, offers only the current location — and saves it', async () => {
    m.suggest.mockResolvedValue({ status: 'unavailable', reason: 'off', suggestions: [] });
    const setHome = mutation('profiles:setHome');
    const geo = {
      getCurrentPosition: vi.fn((ok: (p: unknown) => void) =>
        ok({ coords: { latitude: 43.7, longitude: -72.29 } }),
      ),
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    page('home', 'edit');
    await waitFor(() => expect(m.suggest).toHaveBeenCalledWith({ text: '' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use my current location' })),
    );
    expect(setHome).toHaveBeenCalledWith({ homeCoord: { lat: 43.7, lng: -72.29 } });
    expect(navigate).toHaveBeenCalledWith('/settings/home', { replace: true });
  });

  it('types an address, picks a suggestion, and saves it', async () => {
    m.suggest.mockImplementation(async ({ text }: { text: string }) => ({
      status: 'ok',
      attribution: 'Powered by Geoapify | © OpenStreetMap contributors',
      suggestions: text
        ? [{ label: '14 School Street, Hanover, NH 03755, USA', lat: 43.701, lng: -72.289 }]
        : [],
    }));
    const setHome = mutation('profiles:setHome');
    page('home', 'edit');
    const input = await screen.findByRole('combobox');
    expect(screen.getByRole('button', { name: 'Save home' })).toHaveAttribute('data-disabled');
    fireEvent.change(input, { target: { value: '14 School' } });
    await screen.findByRole('option', {}, { timeout: 2000 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('14 School Street, Hanover, NH 03755, USA');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save home' })));
    expect(setHome).toHaveBeenCalledWith({ homeCoord: { lat: 43.701, lng: -72.289 } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('says so when the location is refused or the save fails', async () => {
    m.suggest.mockResolvedValue({ status: 'unavailable', reason: 'quota', suggestions: [] });
    mutation('profiles:setHome').mockRejectedValueOnce(new Error('no'));
    const geo = {
      getCurrentPosition: vi.fn((_ok: unknown, no: (e: unknown) => void) => no(new Error('x'))),
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    fakes.queries.set('profiles:current', me({ homeCoord: undefined }));
    page('home');
    expect(screen.getByText('Not set')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/suggestions are paused/)).toBeInTheDocument());
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use my current location' })),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn’t get your location/);
    geo.getCurrentPosition.mockImplementation(((ok: (p: unknown) => void) =>
      ok({ coords: { latitude: 1, longitude: 2 } })) as never);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use my current location' })),
    );
    expect(screen.getByText(/wasn’t saved/)).toBeInTheDocument();
  });

  it('summarizes a set home, clears it, and opens the change view', async () => {
    const setHome = mutation('profiles:setHome');
    page('home');
    expect(screen.getByText('30 · 60 · 90 min')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change home' }));
    expect(navigate).toHaveBeenCalledWith('/settings/home?edit=true');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear' })));
    expect(setHome).toHaveBeenCalledWith({});
    // No server for a temporary base yet: no Traveling block.
    expect(screen.queryByText('Traveling')).toBeNull();
  });

  it('a browser with no geolocation says so', async () => {
    m.suggest.mockResolvedValue({ status: 'unavailable', reason: 'off', suggestions: [] });
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    page('home', 'edit');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use my current location' })),
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('notifications', () => {
  it('flips a kind, a channel, and clamps the radii', () => {
    const prefs = mutation('profiles:setNotificationPrefs');
    const channels = mutation('profiles:setChannelPrefs');
    page('notifications');
    fireEvent.click(
      screen.getByRole('switch', { name: 'Someone found my report helpful, or backed it up' }),
    );
    expect(prefs).toHaveBeenCalledWith({ prefs: { reportRated: true } });
    fireEvent.click(screen.getByRole('switch', { name: 'Email me the ones worth an email' }));
    expect(channels).toHaveBeenCalledWith({ email: true });
    expect(screen.getAllByRole('img', { name: 'Also by email' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox', { name: 'Within' })).toHaveLength(2);
  });

  it('asks for a home when the nearby ones have none', () => {
    fakes.queries.set('profiles:current', me({ homeCoord: undefined }));
    page('notifications');
    expect(screen.getByText(/Set a home under Home and drive time/)).toBeInTheDocument();
  });
});

describe('reports and tracks', () => {
  it('flips the put-in default and the maps opt-out, and disconnects Strava', async () => {
    const putIn = mutation('profiles:setShowPutInDefault');
    const optOut = mutation('profiles:setAggregateTracksOptOut');
    const disconnect = mutation('strava:disconnect');
    page('reporting');
    fireEvent.click(screen.getByRole('switch', { name: 'Show where I got on the ice' }));
    expect(putIn).toHaveBeenCalledWith({ showPutIn: false });
    fireEvent.click(
      screen.getByRole('switch', { name: "Don't use my paths in community lake maps" }),
    );
    expect(optOut).toHaveBeenCalledWith({ excludeTracksFromAggregate: true });
    expect(screen.getByText('Connected · Since December 3, 2026')).toBeInTheDocument();
    expect(screen.getAllByAltText('Powered by Strava').length).toBe(2);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })));
    expect(disconnect).toHaveBeenCalled();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByText(/a GPX file from your watch/)).toBeInTheDocument();
  });

  it('connects through our own start URL and records the start', async () => {
    fakes.queries.set('strava:connectionStatus', { configured: true, connected: false });
    mutation('strava:beginConnect').mockResolvedValue({ connectUrl: 'https://x/strava/start?s=1' });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign, origin: 'https://gli.test' },
      configurable: true,
    });
    page('reporting');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Connect with Strava' })),
    );
    expect(fakes.capture).toHaveBeenCalledWith('strava_connect_started');
    expect(fakes.mutations.get('strava:beginConnect')).toHaveBeenCalledWith({
      redirectTo: 'https://gli.test/settings/reporting',
    });
    expect(assign).toHaveBeenCalledWith('https://x/strava/start?s=1');
    Object.defineProperty(window, 'location', { value: original, configurable: true });
  });

  it('says so when Strava fails, and hides the put-in default while leaving', async () => {
    fakes.queries.set('strava:connectionStatus', { configured: true, connected: false });
    fakes.queries.set('profiles:current', me({ deletionRequestedAt: Date.now() }));
    page('reporting');
    expect(screen.queryByRole('switch', { name: 'Show where I got on the ice' })).toBeNull();
    // Connecting is closed while leaving.
    expect(screen.queryByRole('button', { name: 'Connect with Strava' })).toBeNull();
  });

  it('shows the failure line', async () => {
    fakes.queries.set('strava:connectionStatus', { configured: true, connected: false });
    mutation('strava:beginConnect').mockRejectedValue(new Error('down'));
    page('reporting');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Connect with Strava' })),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Strava didn’t answer/);
  });

  it('an unconfigured deployment says so and offers no button', () => {
    fakes.queries.set('strava:connectionStatus', { configured: false, connected: false });
    page('reporting');
    expect(screen.getByText('Strava uploads aren’t available yet.')).toBeInTheDocument();
  });
});

describe('blocked people', () => {
  it('lists the blocked and unblocks one', async () => {
    fakes.queries.set('blocks:myBlocks', [
      { userId: 'u9', username: 'dfortin', displayName: 'Dale Fortin' },
    ]);
    const unblock = mutation('blocks:unblock');
    page('blocked');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Unblock Dale Fortin' })),
    );
    expect(unblock).toHaveBeenCalledWith({ targetUserId: 'u9' });
  });

  it('says when nobody is blocked', () => {
    fakes.queries.set('blocks:myBlocks', []);
    page('blocked');
    expect(screen.getByText('You haven’t blocked anyone.')).toBeInTheDocument();
  });
});

describe('contact support', () => {
  it('sends with a topic, says thanks, and can send another', async () => {
    const create = mutation('support:create');
    page('support');
    expect(screen.getByText('Replies go to kate@donovan.net')).toBeInTheDocument();
    const safety = screen.getByRole('button', { name: 'Safety concern' });
    fireEvent.click(safety);
    expect(safety).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(safety);
    expect(safety).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Bug report' }));
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: '  The map is off.  ' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(create).toHaveBeenCalledWith({
      category: 'bug',
      body: 'The map is off.',
      context: { platform: 'web', appVersion: expect.any(String) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send another' }));
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('sends without a topic as "other", and says when it fails', async () => {
    const create = mutation('support:create').mockRejectedValue(new Error('x'));
    page('support');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ category: 'other' });
    expect(screen.getByRole('alert')).toHaveTextContent('didn’t send');
  });
});

describe('data and account', () => {
  it('exports, lists the exports, and deletes after a second, red step', async () => {
    fakes.queries.set('dataExport:myExports', [
      {
        exportId: 'x1',
        status: 'ready',
        requestedAt: new Date(2027, 0, 4).getTime(),
        expiresAt: new Date(2027, 1, 3).getTime(),
        sizeBytes: 48 * 1024 * 1024,
        url: 'https://files/x1',
      },
      {
        exportId: 'x0',
        status: 'ready',
        requestedAt: new Date(2026, 10, 20).getTime(),
        expiresAt: new Date(2026, 11, 20).getTime(),
        expired: true,
        url: null,
      },
    ]);
    const request = mutation('dataExport:requestExport');
    const del = mutation('accountDeletion:requestDeletion');
    page('data');
    expect(screen.getByText('Jan 4, 2027')).toBeInTheDocument();
    expect(screen.getByText('48 MB · expires Feb 3')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      'https://files/x1',
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export my data' })));
    expect(request).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    const yes = screen.getByRole('button', { name: 'Yes, delete my account' });
    expect(yes).toHaveAttribute('data-armed');
    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Yes, delete my account' })),
    );
    expect(del).toHaveBeenCalled();
  });

  it('while pending: the date, and the way back', async () => {
    fakes.queries.set(
      'profiles:current',
      me({ deletionRequestedAt: new Date(2027, 0, 13).getTime() }),
    );
    const cancel = mutation('accountDeletion:cancelDeletion').mockRejectedValueOnce(new Error('x'));
    page('data');
    expect(screen.getByText('February 12, 2027')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' })));
    expect(screen.getByRole('alert')).toHaveTextContent('didn’t go through');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' })));
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('a building export holds the button', () => {
    fakes.queries.set('dataExport:myExports', [
      { exportId: 'x2', status: 'building', requestedAt: Date.now(), expiresAt: 0, url: null },
      { exportId: 'x3', status: 'failed', requestedAt: Date.now(), expiresAt: 0, url: null },
    ]);
    page('data');
    expect(screen.getByRole('button', { name: 'Preparing your export' })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByText('Couldn’t be prepared')).toBeInTheDocument();
  });
});
