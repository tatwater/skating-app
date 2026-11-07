import { NOTIFICATION_PREF_DEFAULTS } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must, rootPx } from '../../kit/storyKit';
import { KATE, SkaterPair } from '../storySupport';
import { AboutView } from './AboutView';
import { AccountSection } from './AccountSection';
import { AddressField } from './AddressField';
import { BlockedSection } from './BlockedSection';
import { ChangeEmailView } from './ChangeEmail';
import { DataSection } from './DataSection';
import type { AddressLookup, AddressSuggestion } from './geocoder';
import { HomeSection, type HomeSectionProps, travelDays } from './HomeSection';
import { NotificationsSection } from './NotificationsSection';
import { ProfilePhoto, type ProfilePhotoProps } from './ProfilePhoto';
import { ProfileSection } from './ProfileSection';
import { ReportingSection } from './ReportingSection';
import { SettingsFrame } from './SettingsFrame';
import { SignOutDialog, type UnsentDraft } from './SignOutGuard';
import { SupportSection } from './SupportSection';
import type { SettingsSection } from './sections';

/** Row 7: Settings (7.1–7.15, 7.18, 7.19) and About (7.16, 7.17), props only. */
const meta = {
  title: 'Skater/Settings',
  component: SettingsFrame,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SettingsFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = new Date(2027, 0, 16, 12, 0).getTime();
const PERSON = { name: KATE.name, username: KATE.username };
const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];

function Frame({
  section,
  leaving,
  children,
  height = '56rem',
}: {
  section: SettingsSection;
  leaving?: boolean;
  children: ReactNode;
  height?: string;
}) {
  return (
    <SkaterPair height={height}>
      {() => (
        <SettingsFrame
          section={section}
          person={PERSON}
          leaving={leaving ?? false}
          onNavigate={() => {}}
          onSignOut={() => {}}
        >
          {children}
        </SettingsFrame>
      )}
    </SkaterPair>
  );
}

const account = (changing = false) => (
  <AccountSection
    name="Kate Donovan"
    username="kdonovan"
    email="kate@donovan.net"
    strava="connected"
    changingEmail={changing}
    onViewProfile={() => {}}
    onChangeEmail={() => {}}
    onManageConnections={() => {}}
    {...(changing
      ? {
          changeEmail: (
            <ChangeEmailView
              step="code"
              pendingEmail="kdonovan@fastmail.com"
              busy={false}
              error={null}
              old={null}
              onSendCode={() => {}}
              onResend={() => {}}
              onVerify={() => {}}
              onRetryRemove={() => {}}
              onCancel={() => {}}
            />
          ),
        }
      : {})}
  />
);

/** 7.1, 7.2: Account. The list's rows are links; ↑↓ walk them, Home and End jump. */
export const Account: Story = {
  args: {} as never,
  render: () => <Frame section="account">{account()}</Frame>,
  play: async ({ canvasElement }) => {
    const q = must(quads(canvasElement)[0]);
    const nav = within(q).getByRole('navigation', { name: 'Settings' });
    const first = within(nav).getByRole('link', { name: 'Account' });
    await expect(first).toHaveAttribute('aria-current', 'page');
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(within(nav).getByRole('link', { name: 'Your profile' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(within(nav).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(within(nav).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    // Tab leaves the list for the section.
    await userEvent.keyboard('{Home}');
    for (const qq of quads(canvasElement)) {
      // The last row keeps no rule under it.
      const rows = qq.querySelectorAll<HTMLElement>('[data-slot="settings-row"]');
      const last = must(rows[rows.length - 1]);
      await expect(getComputedStyle(last).borderBottomWidth).toBe('0px');
    }
  },
};

/** 7.3: changing the email, at the code. */
export const ChangeEmail: Story = {
  args: {} as never,
  render: () => <Frame section="account">{account(true)}</Frame>,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('button', { name: 'Verify' })).toHaveAttribute(
        'data-disabled',
      );
      await expect(within(q).queryByRole('button', { name: 'Change email' })).toBeNull();
    }
  },
};

const draft: UnsentDraft = {
  label: 'Mascoma Lake',
  openedAtMs: new Date(2027, 0, 16, 11, 52).getTime(),
  post: 'new',
};
const signedOut = fn();
const openedDraft = fn();

/**
 * 7.15: signing out over an unsent draft. Sign out asks first; Tab walks Open the draft → Cancel →
 * Sign out; Esc closes and focus returns to Sign out.
 */
export const SignOutUnsentDraft: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <div className="h-[56rem]">
        <SettingsFrame
          section="account"
          person={PERSON}
          signOutOpen={open}
          onNavigate={() => {}}
          onSignOut={() => setOpen(true)}
        >
          {account()}
        </SettingsFrame>
        <SignOutDialog
          draft={open ? draft : null}
          busy={false}
          now={NOW}
          onOpenChange={setOpen}
          onSignOut={() => {
            signedOut();
            setOpen(false);
          }}
          onOpenDraft={(d) => {
            openedDraft(d);
            setOpen(false);
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const out = within(canvasElement).getByRole('button', { name: 'Sign out' });
    out.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[role="dialog"]')),
    );
    await expect(within(dialog).getByText(/started today at 11:52 AM/)).toBeInTheDocument();
    await expect(out).toHaveAttribute('aria-pressed', 'true');
    await expect(signedOut).not.toHaveBeenCalled();
    // The dialog puts its opening focus inside a beat after it mounts; let it land, so it can't
    // take focus back from the draft below.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // The tab order: the draft, Cancel, then the red Sign out.
    const openDraft = within(dialog).getByRole('button', { name: 'Open the draft' });
    openDraft.focus();
    await userEvent.tab();
    await expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.tab();
    const confirm = within(dialog).getByRole('button', { name: 'Sign out' });
    await expect(confirm).toHaveFocus();
    await expect(confirm).toHaveAttribute('data-armed');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await waitFor(() => expect(out).toHaveFocus());
    // Again, and this time out.
    await userEvent.keyboard('{Enter}');
    const again = await waitFor(() => must(document.querySelector<HTMLElement>('[role="dialog"]')));
    await userEvent.click(within(again).getByRole('button', { name: 'Sign out' }));
    await expect(signedOut).toHaveBeenCalledTimes(1);
  },
};

const BIO =
  'Lunchtime skater out of Hanover. Mostly Mascoma and Crystal, the odd pond when the wind has been kind.';

/** A stand-in photo (no real face): drawn inline, so the story never waits on the network. */
const PHOTO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#7f97a8"/><circle cx="40" cy="31" r="14" fill="#d9e2e8"/><ellipse cx="40" cy="74" rx="26" ry="20" fill="#d9e2e8"/></svg>',
)}`;

function profileWithPhoto(photo: Partial<ProfilePhotoProps>, container: HTMLElement | null) {
  return (
    <ProfileSection
      town="Hanover, NH"
      bio={BIO}
      isPublic
      canGoPublic
      onSaveTown={async () => {}}
      onSaveBio={async () => {}}
      onPublicChange={() => {}}
      photo={
        <ProfilePhoto
          name={KATE.name}
          imageUrl={undefined}
          busy={null}
          error={null}
          offline={false}
          onChange={() => {}}
          onRemove={async () => true}
          container={container}
          {...photo}
        />
      }
    />
  );
}

/** 7.4: your profile — every field saves itself; no photo yet, so the initials and Change photo. */
export const YourProfile: Story = {
  args: {} as never,
  render: () => <Frame section="profile">{profileWithPhoto({}, null)}</Frame>,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('button', { name: /Save/ })).toBeNull();
      await expect(within(q).getByRole('switch', { name: 'Public profile' })).toBeChecked();
      await expect(within(q).getByRole('img', { name: 'Your photo' })).toHaveTextContent('KD');
      await expect(within(q).queryByRole('button', { name: 'Remove photo' })).toBeNull();
    }
  },
};

const removePhoto = fn(async () => true);

/**
 * 7.4 with a photo: Change photo is the section's first stop after the list; Remove photo asks
 * first, and Esc backs out with the photo kept and focus back on Remove photo.
 */
export const YourProfilePhoto: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="56rem">
      {(_mode, container) => (
        <SettingsFrame
          section="profile"
          person={{ ...PERSON, imageUrl: PHOTO }}
          onNavigate={() => {}}
          onSignOut={() => {}}
        >
          {profileWithPhoto({ imageUrl: PHOTO, onRemove: removePhoto }, container)}
        </SettingsFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    removePhoto.mockClear();
    const quad = must(quads(canvasElement)[0]);
    // The list's last row, then Tab: the first thing in the section is Change photo.
    within(quad).getByRole('button', { name: 'Sign out' }).focus();
    await userEvent.tab();
    await expect(within(quad).getByRole('button', { name: 'Change photo' })).toHaveFocus();
    await userEvent.tab();
    const remove = within(quad).getByRole('button', { name: 'Remove photo' });
    await expect(remove).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const dialog = await waitFor(() =>
      must(quad.querySelector<HTMLElement>('[role="alertdialog"]')),
    );
    await expect(dialog).toHaveTextContent('Remove your photo?');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(quad.querySelector('[role="alertdialog"]')).toBeNull());
    await waitFor(() => expect(remove).toHaveFocus());
    await expect(removePhoto).not.toHaveBeenCalled();
  },
};

/** 7.4's photo states: going up (dark), refused (light), and offline under each. */
export const YourProfilePhotoStates: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="44rem">
      {(mode, container) => (
        <div className="flex flex-col gap-(--space-8) p-(--space-8)">
          {profileWithPhoto(
            mode === 'dark'
              ? { imageUrl: PHOTO, busy: 'uploading' }
              : { imageUrl: PHOTO, error: 'Your photo wasn’t saved. Try again in a moment.' },
            container,
          )}
          <ProfilePhoto
            name={KATE.name}
            imageUrl={PHOTO}
            busy={null}
            error={null}
            offline
            onChange={() => {}}
            onRemove={async () => true}
            container={container}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const [dark, light] = quads(canvasElement).map((q) => must(q));
    const changes = within(must(dark)).getAllByRole('button', { name: 'Change photo' });
    await expect(changes[0]).toHaveAttribute('aria-busy', 'true');
    await expect(changes[1]).toBeDisabled();
    await expect(within(must(light)).getByRole('alert')).toHaveTextContent('wasn’t saved');
    await expect(within(must(light)).getByText(/You’re offline/)).toBeInTheDocument();
  },
};

const ATTR = 'Powered by Geoapify | © OpenStreetMap contributors';
const SUGGESTIONS: AddressSuggestion[] = [
  { label: '14 School Street, Hanover, NH 03755, USA', lat: 43.7, lng: -72.29 },
  { label: '14 School Street, Lebanon, NH 03766, USA', lat: 43.64, lng: -72.25 },
  { label: '14 School Street, Enfield, NH 03748, USA', lat: 43.64, lng: -72.14 },
  { label: '14 Schoolhouse Road, Canaan, NH 03741, USA', lat: 43.66, lng: -72.01 },
];

function home(over: Partial<HomeSectionProps> = {}): HomeSectionProps {
  return {
    view: 'summary',
    hasHome: true,
    bands: [30, 60, 90],
    address: '',
    onAddressChange: () => {},
    lookup: { state: 'idle', attribution: ATTR },
    chosen: null,
    onPick: () => {},
    locate: 'idle',
    saving: false,
    failed: false,
    onUseLocation: () => {},
    onSave: () => {},
    onClear: () => {},
    onEdit: () => {},
    onCancel: () => {},
    ...over,
  };
}

const travel = {
  days: travelDays(NOW),
  until: travelDays(NOW)[7]?.value ?? '',
  onUntilChange: () => {},
  onOpen: () => {},
  onStart: () => {},
};

/** 7.5: home set, with traveling (when the server holds a temporary base). */
export const Home: Story = {
  args: {} as never,
  render: () => (
    <Frame section="home">
      <HomeSection {...home({ travel })} />
    </Frame>
  ),
};

/** 7.6: no home yet, and no address provider on — current location is the way. */
export const HomeNotSet: Story = {
  args: {} as never,
  render: () => (
    <Frame section="home">
      <HomeSection {...home({ hasHome: false, lookup: { state: 'off' } })} />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('combobox')).toBeNull();
      await expect(
        within(q).getByRole('button', { name: 'Use my current location' }),
      ).toBeInTheDocument();
    }
  },
};

const picked = fn();

/**
 * 7.18: changing home by typed address. ↓↑ move through the suggestions, Enter takes the lit one,
 * Esc closes the list; the provider's attribution sits under them.
 */
export const ChangeHome: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [address, setAddress] = useState('14 School');
    const [chosen, setChosen] = useState<AddressSuggestion | null>(null);
    const lookup: AddressLookup =
      chosen === null && address.trim().length >= 3
        ? { state: 'ok', attribution: ATTR, suggestions: SUGGESTIONS }
        : { state: 'idle', attribution: ATTR };
    return (
      <div className="h-[56rem]">
        <SettingsFrame section="home" person={PERSON} onNavigate={() => {}} onSignOut={() => {}}>
          <HomeSection
            {...home({
              view: 'edit',
              address,
              lookup,
              chosen,
              onAddressChange: (v) => {
                setChosen(null);
                setAddress(v);
              },
              onPick: (s) => {
                picked(s);
                setChosen(s);
                setAddress(s.label);
              },
            })}
          />
        </SettingsFrame>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('combobox');
    await waitFor(() => expect(input).toHaveFocus());
    const list = within(canvasElement).getByRole('listbox');
    await expect(
      canvasElement.querySelector('[data-slot="geocoder-attribution"]'),
    ).toHaveTextContent(ATTR);
    await expect(within(canvasElement).getByRole('link', { name: 'Geoapify' })).toHaveAttribute(
      'href',
      'https://www.geoapify.com/',
    );
    await expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(within(list).getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}');
    await expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    await expect(within(canvasElement).queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{ArrowDown}');
    await expect(within(canvasElement).getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await expect(picked).toHaveBeenCalledWith(SUGGESTIONS[0]);
    await expect(input).toHaveValue(SUGGESTIONS[0]?.label);
    await expect(
      within(canvasElement).getByRole('button', { name: 'Save home' }),
    ).not.toHaveAttribute('data-disabled');
  },
};

/** 7.19: a temporary base until a date. */
export const Traveling: Story = {
  args: {} as never,
  render: () => (
    <Frame section="home">
      <HomeSection
        {...home({
          view: 'travel',
          travel,
          address: 'Mountain Road, Stowe, VT 05672',
          chosen: { label: 'Mountain Road, Stowe, VT 05672', lat: 44.47, lng: -72.7 },
        })}
      />
    </Frame>
  ),
};

/** 7.7, 7.8: notifications, in the board's four groups, then the channels. */
export const Notifications: Story = {
  args: {} as never,
  render: () => (
    <Frame section="notifications" height="84rem">
      <NotificationsSection
        prefs={{
          ...NOTIFICATION_PREF_DEFAULTS,
          nearbyReportDigest: true,
          greatReportNearby: true,
          reportRated: false,
        }}
        channels={{ push: true, email: true }}
        allRadius={30}
        greatRadius={90}
        hasHome
        onPrefChange={() => {}}
        onRadiusChange={() => {}}
        onChannelChange={() => {}}
      />
    </Frame>
  ),
};

/** 7.9: reports and tracks — Strava connected (its own lockup), Garmin coming soon. */
export const ReportsAndTracks: Story = {
  args: {} as never,
  render: () => (
    <Frame section="reporting" height="60rem">
      <ReportingSection
        showPutIn
        excludeTracks={false}
        strava="connected"
        stravaSince={new Date(2026, 11, 3).getTime()}
        canConnect
        stravaBusy={false}
        stravaFailed={false}
        onShowPutInChange={() => {}}
        onExcludeTracksChange={() => {}}
        onConnectStrava={() => {}}
        onDisconnectStrava={() => {}}
      />
    </Frame>
  ),
};

/** 7.9, unconnected: Strava's own Connect button, never louder than Gli. */
export const ConnectStrava: Story = {
  args: {} as never,
  render: () => (
    <Frame section="reporting" height="60rem">
      <ReportingSection
        showPutIn
        excludeTracks
        strava="not-connected"
        stravaSince={null}
        canConnect
        stravaBusy={false}
        stravaFailed={false}
        onShowPutInChange={() => {}}
        onExcludeTracksChange={() => {}}
        onConnectStrava={() => {}}
        onDisconnectStrava={() => {}}
      />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const img = within(q).getByAltText('Connect with Strava');
      // Never louder than Gli: no taller than the skater button height (2.25rem).
      await waitFor(() => expect(img.getBoundingClientRect().height).toBeGreaterThan(0));
      await expect(img.getBoundingClientRect().height).toBeLessThanOrEqual(2.25 * rootPx() + 0.5);
    }
  },
};

/** 7.10: blocked people. */
export const BlockedPeople: Story = {
  args: {} as never,
  render: () => (
    <Frame section="blocked">
      <BlockedSection
        people={[
          { userId: 'u1', username: 'dfortin', displayName: 'Dale Fortin' },
          { userId: 'u2', username: 'jwhitcomb', displayName: 'Jess Whitcomb' },
        ]}
        pending={new Set()}
        onUnblock={() => {}}
      />
    </Frame>
  ),
};

/** 7.11: contact support. */
export const ContactSupport: Story = {
  args: {} as never,
  render: () => (
    <Frame section="support">
      <SupportSection
        replyTo="kate@donovan.net"
        state="idle"
        onSend={() => {}}
        onAnother={() => {}}
      />
    </Frame>
  ),
};

const exportsList = [
  {
    exportId: 'x1',
    status: 'ready' as const,
    requestedAt: new Date(2027, 0, 4).getTime(),
    expiresAt: new Date(2027, 1, 3).getTime(),
    sizeBytes: 48 * 1024 * 1024,
    url: '#',
  },
  {
    exportId: 'x0',
    status: 'ready' as const,
    requestedAt: new Date(2026, 10, 20).getTime(),
    expiresAt: new Date(2026, 11, 20).getTime(),
    expired: true,
    url: null,
  },
];

const data = (pending: boolean) => (
  <DataSection
    exports={exportsList}
    deletionRequestedAt={pending ? new Date(2027, 0, 13).getTime() : undefined}
    exportBusy={false}
    deleteBusy={false}
    failed={null}
    onExport={() => {}}
    onDelete={() => {}}
    onCancelDeletion={() => {}}
  />
);

/** 7.12, 7.13: data and account; Delete arms a red second step. */
export const DataAndAccount: Story = {
  args: {} as never,
  render: () => (
    <Frame section="data" height="64rem">
      {data(false)}
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const q = must(quads(canvasElement)[0]);
    const del = within(q).getByRole('button', { name: 'Delete my account' });
    // Never red at rest.
    await expect(del).not.toHaveAttribute('data-armed');
    await userEvent.click(del);
    await expect(within(q).getByRole('button', { name: 'Yes, delete my account' })).toHaveAttribute(
      'data-armed',
    );
    await userEvent.click(within(q).getByRole('button', { name: 'Never mind' }));
  },
};

/** 7.14: deletion pending. */
export const DeletionPending: Story = {
  args: {} as never,
  render: () => (
    <Frame section="data" leaving height="60rem">
      {data(true)}
    </Frame>
  ),
};

/** 7.16: About, signed in (the shell's top bar is the shell's). */
export const About: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="50rem">
      {() => (
        <AboutView
          signedIn
          counts={[
            { state: 'ME', stateName: 'Maine', known: 5902, active: 341 },
            { state: 'NH', stateName: 'New Hampshire', known: 2614, active: 412 },
            { state: 'MA', stateName: 'Massachusetts', known: 2240, active: 96 },
            { state: 'VT', stateName: 'Vermont', known: 1873, active: 287 },
          ]}
          onNavigate={() => {}}
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      for (const link of within(q).getAllByRole('link', { name: /opens in a new tab/ })) {
        await expect(link).toHaveAttribute('target', '_blank');
      }
    }
  },
};

/** 7.17: About, signed out — bare but for the logo and the way in. */
export const AboutSignedOut: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="50rem">
      {() => <AboutView signedIn={false} counts={[]} onNavigate={() => {}} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('link', { name: 'Create an account' })).toBeInTheDocument();
      await expect(within(q).queryByText('Help')).toBeNull();
    }
  },
};

/** The address field alone: what a failed lookup says. */
export const AddressFailed: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="12rem">
      {() => (
        <div className="p-(--space-5)">
          <AddressField
            label="Home address"
            hint="We work out your drive-time zones from it."
            value="14 School"
            onValueChange={() => {}}
            lookup={{ state: 'error', attribution: null }}
            onPick={() => {}}
          />
        </div>
      )}
    </SkaterPair>
  ),
};
