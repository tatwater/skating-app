import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  DRIVE_TIME_BANDS,
  effectiveChannelPrefs,
  isLeaving,
  isMinor,
  type NotificationPrefKey,
  resolveShowPutInDefault,
} from '@skating/core';
import { useAction, useMutation, useQuery } from 'convex/react';
import { type ReactNode, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';

import { Skeleton } from '../../kit/skeleton';
import { AccountSection, type StravaState } from './AccountSection';
import { type BlockedPerson, BlockedSection } from './BlockedSection';
import { ChangeEmailView } from './ChangeEmail';
import { DataSection, type ExportRow } from './DataSection';
import { type AddressSuggestion, type SuggestFn, useAddressSuggestions } from './geocoder';
import { HomeSection, type HomeView, type LocateState } from './HomeSection';
import { NotificationsSection, radiusPatch } from './NotificationsSection';
import { ProfilePhoto } from './ProfilePhoto';
import { ProfileSection } from './ProfileSection';
import { ReportingSection } from './ReportingSection';
import { SettingsFrame } from './SettingsFrame';
import { SignOutDialog } from './SignOutGuard';
import { SupportSection, type SupportState, type SupportTopic } from './SupportSection';
import type { SettingsSection } from './sections';
import { useChangeEmail } from './useChangeEmail';
import { useGuardedSignOut } from './useGuardedSignOut';
import { useProfilePhoto } from './useProfilePhoto';

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'web';

type Profile = NonNullable<ReturnType<typeof useCurrentProfile>>;

function useCurrentProfile() {
  return useQuery(api.profiles.current, {});
}

/**
 * Settings, wired (row 7): the section from the path, the home view from the search, and every
 * section's reads and writes. Each section is its own component below, so one section's queries
 * never run on another's page.
 */
export function SettingsPage({
  section,
  homeView = 'summary',
  onNavigate,
}: {
  section: SettingsSection;
  homeView?: HomeView;
  onNavigate: (href: string, options?: { replace?: boolean }) => void;
}) {
  const profile = useCurrentProfile();
  const guard = useGuardedSignOut();
  const leaving = isLeaving(profile);
  // A cleared profile has no section to edit (D62): its link is gone, and so is its page.
  const shown: SettingsSection = leaving && section === 'profile' ? 'account' : section;

  return (
    <>
      <SettingsFrame
        section={shown}
        person={{
          name: profile?.displayName ?? '',
          username: profile?.username ?? '',
          ...(profile?.profileImageUrl ? { imageUrl: profile.profileImageUrl } : {}),
        }}
        leaving={leaving}
        signOutOpen={guard.open}
        onNavigate={onNavigate}
        onSignOut={guard.request}
      >
        {profile == null ? (
          <PaneSkeleton />
        ) : (
          <Section section={shown} profile={profile} homeView={homeView} onNavigate={onNavigate} />
        )}
      </SettingsFrame>
      <SignOutDialog
        {...guard.dialog}
        onOpenDraft={(draft) => {
          guard.dialog.onOpenChange(false);
          onNavigate(`/settings/${shown}?${new URLSearchParams({ post: draft.post })}`);
        }}
      />
    </>
  );
}

function PaneSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading settings"
      className="flex flex-col gap-(--space-4)"
    >
      <Skeleton className="h-[1.625rem] w-[16rem]" />
      <Skeleton className="h-[3.25rem] w-full" />
      <Skeleton className="h-[3.25rem] w-full" />
    </div>
  );
}

function Section({
  section,
  profile,
  homeView,
  onNavigate,
}: {
  section: SettingsSection;
  profile: Profile;
  homeView: HomeView;
  onNavigate: (href: string, options?: { replace?: boolean }) => void;
}): ReactNode {
  switch (section) {
    case 'account':
      return <Account profile={profile} onNavigate={onNavigate} />;
    case 'profile':
      return <YourProfile profile={profile} />;
    case 'home':
      return <Home profile={profile} view={homeView} onNavigate={onNavigate} />;
    case 'notifications':
      return <Notifications profile={profile} />;
    case 'reporting':
      return <Reporting profile={profile} />;
    case 'blocked':
      return <Blocked />;
    case 'support':
      return <Support />;
    case 'data':
      return <Data profile={profile} />;
  }
}

function useStravaState(): { state: StravaState; since: number | null } {
  const status = useQuery(api.strava.connectionStatus, {});
  if (status === undefined) return { state: 'not-connected', since: null };
  if (!status.configured) return { state: 'unavailable', since: null };
  return status.connected
    ? { state: 'connected', since: status.connectedAt }
    : { state: 'not-connected', since: null };
}

function Account({
  profile,
  onNavigate,
}: {
  profile: Profile;
  onNavigate: (href: string) => void;
}) {
  const email = useChangeEmail();
  const strava = useStravaState();
  return (
    <AccountSection
      name={profile.displayName}
      username={profile.username}
      email={email.currentEmail}
      strava={strava.state}
      changingEmail={email.step !== 'idle'}
      onViewProfile={() => onNavigate(`/u/${profile.username}`)}
      onChangeEmail={email.start}
      onManageConnections={() => onNavigate('/settings/reporting')}
      changeEmail={
        email.step === 'idle' ? undefined : <ChangeEmailView step={email.step} {...email.view} />
      }
    />
  );
}

function YourProfile({ profile }: { profile: Profile }) {
  const update = useMutation(api.profiles.updateProfile);
  const photo = useProfilePhoto();
  return (
    <ProfileSection
      photo={<ProfilePhoto name={profile.displayName} {...photo} />}
      town={profile.homeTownLabel ?? ''}
      bio={profile.bio ?? ''}
      isPublic={profile.profileVisibility === 'public'}
      canGoPublic={!isMinor(profile.dateOfBirth, Date.now())}
      onSaveTown={(homeTownLabel) => update({ homeTownLabel })}
      onSaveBio={(bio) => update({ bio })}
      onPublicChange={(on) =>
        void update({ profileVisibility: on ? 'public' : 'private' }).catch(() => {})
      }
    />
  );
}

/** The browser's position, once. Rejects when there's no geolocation or it's refused. */
export function currentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { maximumAge: 60_000, timeout: 20_000 },
    );
  });
}

function Home({
  profile,
  view,
  onNavigate,
}: {
  profile: Profile;
  view: HomeView;
  onNavigate: (href: string, options?: { replace?: boolean }) => void;
}) {
  const setHome = useMutation(api.profiles.setHome);
  const suggest = useAction(api.geocode.suggest) as unknown as SuggestFn;
  const [address, setAddress] = useState('');
  const [chosen, setChosen] = useState<AddressSuggestion | null>(null);
  const [locate, setLocate] = useState<LocateState>('idle');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const lookup = useAddressSuggestions(chosen === null ? address : '', suggest);

  const back = () => {
    setAddress('');
    setChosen(null);
    setFailed(false);
    onNavigate('/settings/home', { replace: true });
  };
  const save = async (coord: { lat: number; lng: number } | undefined) => {
    setSaving(true);
    setFailed(false);
    try {
      await setHome(coord === undefined ? {} : { homeCoord: coord });
      back();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <HomeSection
      // Traveling waits on the server holding a temporary base (`travel` absent hides it).
      view={view === 'travel' ? 'summary' : view}
      hasHome={profile.homeCoord !== undefined}
      bands={DRIVE_TIME_BANDS}
      address={address}
      onAddressChange={(value) => {
        setChosen(null);
        setAddress(value);
      }}
      lookup={lookup}
      chosen={chosen}
      onPick={(s) => {
        setChosen(s);
        setAddress(s.label);
      }}
      locate={locate}
      saving={saving}
      failed={failed}
      onUseLocation={() => {
        setLocate('locating');
        currentPosition().then(
          (coord) => {
            setLocate('idle');
            void save(coord);
          },
          () => setLocate('failed'),
        );
      }}
      onSave={() => chosen && void save({ lat: chosen.lat, lng: chosen.lng })}
      onClear={() => void save(undefined)}
      onEdit={() => onNavigate('/settings/home?edit=true')}
      onCancel={back}
    />
  );
}

function Notifications({ profile }: { profile: Profile }) {
  const setPrefs = useMutation(api.profiles.setNotificationPrefs);
  const setChannels = useMutation(api.profiles.setChannelPrefs);
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  return (
    <NotificationsSection
      prefs={profile.notificationPrefs as Record<NotificationPrefKey, boolean>}
      channels={effectiveChannelPrefs(profile.channelPrefs)}
      allRadius={profile.allRadiusMinutes}
      greatRadius={profile.greatRadiusMinutes}
      hasHome={profile.homeCoord !== undefined}
      onPrefChange={(key, on) => quiet(setPrefs({ prefs: { [key]: on } }))}
      onRadiusChange={(which, minutes) =>
        quiet(
          setPrefs(
            radiusPatch(which, minutes, profile.allRadiusMinutes, profile.greatRadiusMinutes),
          ),
        )
      }
      onChannelChange={(channel, on) => quiet(setChannels({ [channel]: on }))}
    />
  );
}

function Reporting({ profile }: { profile: Profile }) {
  const { capture } = useAnalytics();
  const strava = useStravaState();
  const setPutIn = useMutation(api.profiles.setShowPutInDefault);
  const setOptOut = useMutation(api.profiles.setAggregateTracksOptOut);
  const begin = useMutation(api.strava.beginConnect);
  const disconnect = useMutation(api.strava.disconnect);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = isLeaving(profile);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(false);
    try {
      await work();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReportingSection
      {...(leaving ? {} : { showPutIn: resolveShowPutInDefault(profile.showPutInDefault) })}
      excludeTracks={profile.excludeTracksFromAggregate === true}
      strava={strava.state}
      stravaSince={strava.since}
      canConnect={!leaving}
      stravaBusy={busy}
      stravaFailed={failed}
      onShowPutInChange={(on) => void setPutIn({ showPutIn: on }).catch(() => {})}
      onExcludeTracksChange={(on) =>
        void setOptOut({ excludeTracksFromAggregate: on }).catch(() => {})
      }
      onConnectStrava={() =>
        void run(async () => {
          capture('strava_connect_started');
          // Our own start URL (it binds this browser before Strava's consent), then back here.
          const { connectUrl } = await begin({
            redirectTo: `${window.location.origin}/settings/reporting`,
          });
          window.location.assign(connectUrl);
        })
      }
      onDisconnectStrava={() => void run(() => disconnect({}))}
    />
  );
}

function Blocked() {
  const people = useQuery(api.blocks.myBlocks, {}) as BlockedPerson[] | undefined;
  const unblock = useMutation(api.blocks.unblock);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  return (
    <BlockedSection
      people={people}
      pending={pending}
      onUnblock={(p) => {
        setPending((s) => new Set(s).add(p.userId));
        unblock({ targetUserId: p.userId as Id<'profiles'> })
          .catch(() => {})
          .finally(() =>
            setPending((s) => {
              const next = new Set(s);
              next.delete(p.userId);
              return next;
            }),
          );
      }}
    />
  );
}

function Support() {
  const create = useMutation(api.support.create);
  const email = useChangeEmail();
  const [state, setState] = useState<SupportState>('idle');
  return (
    <SupportSection
      replyTo={email.currentEmail}
      state={state}
      onAnother={() => setState('idle')}
      onSend={(category: SupportTopic, body: string) => {
        setState('sending');
        create({ category, body, context: { platform: 'web', appVersion: APP_VERSION } }).then(
          () => setState('sent'),
          () => setState('failed'),
        );
      }}
    />
  );
}

function Data({ profile }: { profile: Profile }) {
  const exports = useQuery(api.dataExport.myExports, {}) as ExportRow[] | undefined;
  const request = useMutation(api.dataExport.requestExport);
  const requestDeletion = useMutation(api.accountDeletion.requestDeletion);
  const cancelDeletion = useMutation(api.accountDeletion.cancelDeletion);
  const [exportBusy, setExportBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const lifecycle = async (work: () => Promise<unknown>, message: string) => {
    setDeleteBusy(true);
    setFailed(null);
    try {
      await work();
    } catch {
      setFailed(message);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <DataSection
      exports={exports ?? []}
      deletionRequestedAt={profile.deletionRequestedAt}
      exportBusy={exportBusy}
      deleteBusy={deleteBusy}
      failed={failed}
      onExport={() => {
        setExportBusy(true);
        request({})
          .catch(() => {})
          .finally(() => setExportBusy(false));
      }}
      onDelete={() =>
        void lifecycle(() => requestDeletion({}), 'The deletion didn’t go through. Try again.')
      }
      onCancelDeletion={() =>
        void lifecycle(() => cancelDeletion({}), 'That didn’t go through. Try again.')
      }
    />
  );
}
