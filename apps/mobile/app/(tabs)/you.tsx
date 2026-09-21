import { useAuth } from '@clerk/clerk-expo';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faBell } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  AGGREGATE_OPT_OUT_EXPLAINER,
  AGGREGATE_OPT_OUT_HEADING,
  AGGREGATE_OPT_OUT_LABEL,
  CHANNEL_PREF_LABELS,
  DRIVE_TIME_BANDS,
  effectiveChannelPrefs,
  NOTIFICATION_PREF_LABELS,
  NOTIFICATION_PREF_ORDER,
  type NotificationPrefKey,
  resolveShowPutInDefault,
  SHOW_PUT_IN_HEADING,
  SHOW_PUT_IN_LABEL,
  SHOW_PUT_IN_SETTING_EXPLAINER,
} from '@skating/core';
import { THEME_PREFERENCES, type ThemePreference } from '@skating/design';
import { useMutation, useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { Link, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H1, Paragraph, Separator, Text, useTheme, XStack, YStack } from 'tamagui';
import { AccountLifecycle } from '../../src/components/AccountLifecycle';
import { ChangeEmail } from '../../src/components/ChangeEmail';
import { ProfileEdit } from '../../src/components/ProfileEdit';
import { Avatar } from '../../src/components/ProfileView';
import { StravaConnect } from '../../src/components/StravaConnect';
import { TrackHistory } from '../../src/components/TrackHistory';
import { UnreportedSkates } from '../../src/components/UnreportedSkates';
import { clearNotificationCache } from '../../src/lib/notificationCache';
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  isDeviceOptedOut,
  registerIfPermitted,
  unregisterThisDevice,
} from '../../src/lib/pushRegistration';
import { tapTargetSlop } from '../../src/lib/tapTarget';
import { THEME_PREFERENCE_LABELS } from '../../src/lib/themePreference';
import { useThemePreference } from '../../src/providers/ThemeProvider';

/**
 * Profile / settings hub (D28). Who you're signed in as (with a link to your public profile),
 * profile editing (bio / town / public↔private, D13), your blocked-users list (D32), data export +
 * account deletion (D33/D62), the license/about link (D43), and sign-out.
 */
export default function YouScreen() {
  const { signOut } = useAuth();
  const profile = useQuery(api.profiles.current, {});
  const router = useRouter();
  const theme = useTheme();
  // The bell's dot (A08 §1.3). The tab bar shows the same signal on the You icon from every screen.
  const unread = useQuery(api.notifications.unreadCount, profile ? {} : 'skip') ?? 0;

  // Sign-out takes this phone's push address with it and drops the offline inbox (A08 PR 3): a phone
  // nobody is signed in on must not keep ringing — or reading back — for the account that left.
  // Both best-effort and *before* the Clerk sign-out. The release itself needs no session (it's
  // keyed by the token), so one that's still queued when the session ends still lands; the tabs
  // layout re-registers on the next sign-in.
  const registerToken = useMutation(api.pushTokens.register);
  const unregisterToken = useMutation(api.pushTokens.unregister);
  const releaseToken = useMutation(api.pushTokens.release);
  async function onSignOut() {
    await unregisterThisDevice({
      register: registerToken,
      unregister: unregisterToken,
      release: releaseToken,
    });
    clearNotificationCache();
    await signOut();
    router.replace('/sign-in');
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView>
        <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
          <XStack alignItems="center" justifyContent="space-between">
            <H1 color="$foreground">You</H1>
            {/* The inbox lives behind this bell rather than in the tab bar (D28: five tabs stand). */}
            <Button
              chromeless
              size="$3"
              circular
              hitSlop={tapTargetSlop('$3')}
              accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
              onPress={() => router.push('/notifications')}
              icon={
                <XStack>
                  <FontAwesomeIcon icon={faBell} size={22} color={theme.foreground?.val} />
                  {unread > 0 ? (
                    <YStack
                      position="absolute"
                      top={-2}
                      right={-3}
                      width={9}
                      height={9}
                      borderRadius={5}
                      backgroundColor="$primary"
                      borderWidth={1.5}
                      borderColor="$background"
                    />
                  ) : null}
                </XStack>
              }
            />
          </XStack>
          {profile ? (
            /* A `Paragraph` under `asChild` rendered dark-on-dark — the plain `Paragraph` on the
               next line, with no Link around it, themed fine. A Button is what `asChild` is meant
               to hand navigation to anyway, and it brings a real tap target with it: this was a
               line of text you had to hit exactly. Styled flat so it still reads as the name line
               rather than a control. */
            <Link
              href={{ pathname: '/u/[username]', params: { username: profile.username } }}
              asChild
            >
              <Button
                chromeless
                size="$3"
                hitSlop={tapTargetSlop('$3')}
                paddingHorizontal={0}
                justifyContent="flex-start"
                color="$foreground"
              >
                {profile.displayName} · @{profile.username}
              </Button>
            </Link>
          ) : (
            <Paragraph color="$foreground">Loading your profile…</Paragraph>
          )}
          <ChangeEmail />

          <Separator borderColor="$border" />
          <Text
            color="$foregroundMuted"
            fontSize={11}
            letterSpacing={1.5}
            textTransform="uppercase"
          >
            Your profile
          </Text>
          <ProfileEdit />

          <Separator borderColor="$border" />
          <Appearance />

          <Separator borderColor="$border" />
          <HomeLocation />
          <NotificationSettings />

          <PutInSetting />

          <AggregateTracksSetting />

          <BlockedUsers />

          <Separator borderColor="$border" />
          {/* Strava push (Phase 08). Sits with the account settings because it IS an account link —
              your skates going to your Strava — not a map or safety feature. The recorded-skate list
              sits directly under it because that's where a push that didn't land is retried by hand,
              and because connecting an account here is the thing that makes those retries work. */}
          <StravaConnect />
          {/* Server-backed, above the device-local `TrackHistory` (A06f): "which skates still owe a
              report" is the actionable question, and it is the one this phone alone can't answer. */}
          <UnreportedSkates />
          <TrackHistory />

          <AccountLifecycle />

          <Separator borderColor="$border" />
          <Link href="/support" asChild>
            <Button>Contact support</Button>
          </Link>
          <Link href="/about" asChild>
            <Button>About &amp; licenses</Button>
          </Link>
          <Button backgroundColor="$danger" color="$dangerForeground" onPress={onSignOut}>
            Sign out
          </Button>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Home location (Phase 04, D11/D18) — the PRIVATE anchor for drive-time bands. Only the derived
 * isochrones + radius are stored server-side; the coordinate never leaves the device beyond this set.
 * Uses `expo-location` (foreground permission) so there's no manual coordinate entry; setting it
 * triggers the isochrone recompute powering the drive-time filter + nearby notifications.
 */
function HomeLocation() {
  const profile = useQuery(api.profiles.current, {});
  const setHome = useMutation(api.profiles.setHome);
  const [status, setStatus] = useState<'idle' | 'locating' | 'error'>('idle');
  const hasHome = profile?.homeCoord !== undefined;

  async function useCurrentLocation() {
    setStatus('locating');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setStatus('error');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      await setHome({ homeCoord: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Home &amp; drive time
      </Text>
      <Paragraph color="$foregroundMuted" fontSize={13}>
        Your home anchors the drive-time filter and nearby notifications. It stays private — we
        store only the derived travel-time zones, never the coordinate.
      </Paragraph>
      <XStack gap="$2" flexWrap="wrap">
        <Button
          size="$3"
          hitSlop={tapTargetSlop('$3')}
          onPress={useCurrentLocation}
          disabled={status === 'locating'}
        >
          {hasHome ? 'Update home' : 'Set home from location'}
        </Button>
        {hasHome ? (
          <Button
            size="$3"
            hitSlop={tapTargetSlop('$3')}
            chromeless
            onPress={() => void setHome({})}
          >
            Clear
          </Button>
        ) : null}
      </XStack>
      {status === 'locating' ? (
        <Text color="$foregroundMuted" fontSize={13}>
          Locating…
        </Text>
      ) : status === 'error' ? (
        <Text color="$danger" fontSize={13}>
          Couldn't get your location.
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * The note under the theme picker, for the two states where the user has overridden their device.
 *
 * Split per preference rather than shared: a single line about light mode read as a non-sequitur
 * once `Dark` was the selected option — the interface recommending the thing you had just turned
 * off. The `System` case is built from the live theme instead and lives at the call site.
 */
const APPEARANCE_NOTE: Record<Exclude<ThemePreference, 'system'>, string> = {
  light: 'Built for reading the map in bright sun and glare on the ice.',
  dark: 'Overriding your device — tap System to follow it again.',
};

/**
 * Theme picker (D34 amendment) — three options rather than web's binary sun/moon toggle.
 *
 * `System` has to be selectable, not merely the state you start in: without it, the first tap ever
 * made here is irreversible, and a user who wanted to see what dark looked like can never get back
 * to following the OS. Web's toggle had exactly that trap.
 *
 * The live theme is named under the picker only while `System` is selected. On an explicit choice
 * the button already says which theme is on, and repeating it there would be the interface telling
 * you something you just told it.
 */
function Appearance() {
  const { preference, resolved, setPreference } = useThemePreference();

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Appearance
      </Text>
      <XStack gap="$2" alignItems="center">
        {THEME_PREFERENCES.map((option) => (
          <SegmentButton
            key={option}
            selected={preference === option}
            flex={1}
            onPress={() => setPreference(option)}
            aria-label={`Use ${THEME_PREFERENCE_LABELS[option]} theme`}
          >
            {THEME_PREFERENCE_LABELS[option]}
          </SegmentButton>
        ))}
      </XStack>
      <Paragraph color="$foregroundMuted" fontSize={11}>
        {preference === 'system'
          ? `Following your device — currently ${THEME_PREFERENCE_LABELS[resolved].toLowerCase()}.`
          : APPEARANCE_NOTE[preference]}
      </Paragraph>
    </YStack>
  );
}

/**
 * One button in a picker: filled when it's the current value, chromeless with a hairline when it
 * isn't.
 *
 * Three controls on this screen draw the same six style props — the notification toggles, the
 * drive-time radii, and the theme picker. Written out at each of them, "selected" was a convention
 * rather than a thing, and the fourth copy would have been where it quietly drifted.
 */
function SegmentButton({
  selected,
  onPress,
  children,
  flex,
  'aria-label': ariaLabel,
}: {
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
  flex?: number;
  'aria-label'?: string;
}) {
  return (
    <Button
      size="$2"
      // 28dp rendered — below the 48dp floor, and these are `chromeless` when unselected, so
      // there isn't even a filled shape to aim at. Grows the touch rect, not the layout.
      hitSlop={tapTargetSlop('$2')}
      flex={flex}
      backgroundColor={selected ? '$primary' : undefined}
      color={selected ? '$primaryForeground' : undefined}
      chromeless={!selected}
      borderWidth={1}
      borderColor={selected ? '$primary' : '$border'}
      onPress={onPress}
      aria-label={ariaLabel}
    >
      {children}
    </Button>
  );
}

/** An on/off toggle row rendered as a filled/outline button (matching the ProfileEdit pattern). */
function ToggleRow({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <XStack gap="$2" alignItems="center" justifyContent="space-between">
      <Text flex={1} color="$foreground" fontSize={14}>
        {label}
      </Text>
      <SegmentButton selected={value} onPress={() => onToggle(!value)}>
        {value ? 'On' : 'Off'}
      </SegmentButton>
    </XStack>
  );
}

/** A 30/60/90-minute radius picker as a button group. */
function RadiusRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (minutes: number) => void;
}) {
  return (
    <XStack gap="$2" alignItems="center">
      <Text color="$foregroundMuted" fontSize={13}>
        {label}
      </Text>
      {DRIVE_TIME_BANDS.map((m) => (
        <SegmentButton key={m} selected={value === m} onPress={() => onChange(m)}>
          {`${m}m`}
        </SegmentButton>
      ))}
    </XStack>
  );
}

/**
 * One on/off setting with its own section heading and a line of explainer — the shape the two
 * privacy switches below share. The words come from `@skating/core` (the same control ships on web,
 * and two surfaces wording one privacy promise differently means one of them is describing behavior
 * the app doesn't have); the layout comes from here so a fix to one switch is a fix to both.
 */
function SwitchSetting({
  heading,
  label,
  explainer,
  value,
  onToggle,
}: {
  heading: string;
  label: string;
  explainer: string;
  value: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        {heading}
      </Text>
      <ToggleRow label={label} value={value} onToggle={onToggle} />
      <Paragraph color="$foregroundMuted" fontSize={11}>
        {explainer}
      </Paragraph>
    </YStack>
  );
}

/**
 * The remembered default for the report form's put-in switch (Phase 04 decision #7;
 * `profiles.showPutInDefault`). The switch itself is on the report form — the choice is per report;
 * this is where the default is visible without opening one. Copy in `@skating/core` (`putInPrivacy.ts`).
 *
 * Not rendered for a ghost (deletion pending, D62): the mutation is contributor-gated because a
 * person who can no longer post has no next report for a default to seed, and a switch that rejects
 * every flip is worse than no switch.
 */
function PutInSetting() {
  const profile = useQuery(api.profiles.current, {});
  const setDefault = useMutation(api.profiles.setShowPutInDefault);
  if (!profile || profile.deletionRequestedAt !== undefined) return null;

  return (
    <SwitchSetting
      heading={SHOW_PUT_IN_HEADING}
      label={SHOW_PUT_IN_LABEL}
      explainer={SHOW_PUT_IN_SETTING_EXPLAINER}
      value={resolveShowPutInDefault(profile.showPutInDefault)}
      onToggle={(v) => void setDefault({ showPutIn: v })}
    />
  );
}

/**
 * The D58 aggregate opt-out. The reasoning behind the wording is documented with the copy in
 * `@skating/core` (`trackPrivacy.ts`).
 */
function AggregateTracksSetting() {
  const profile = useQuery(api.profiles.current, {});
  // `setAggregateTracksOptOut`, not `updateProfile`: this is the one profile setting a ghost keeps
  // (D62 second amendment) — it governs the tracks that outlive the account.
  const setOptOut = useMutation(api.profiles.setAggregateTracksOptOut);
  if (!profile) return null;

  return (
    <SwitchSetting
      heading={AGGREGATE_OPT_OUT_HEADING}
      label={AGGREGATE_OPT_OUT_LABEL}
      explainer={AGGREGATE_OPT_OUT_EXPLAINER}
      value={profile.excludeTracksFromAggregate === true}
      onToggle={(v) => void setOptOut({ excludeTracksFromAggregate: v })}
    />
  );
}

/**
 * Notification preferences — **every** type, iterated from the vocabulary in `@skating/core` (D16;
 * A08), so this list and the web's can't drift. The two radius-bearing Phase-04 buckets sit last with
 * their "within" rows (X₂ ≥ X₁, clamped here and re-enforced server-side).
 */
function NotificationSettings() {
  const profile = useQuery(api.profiles.current, {});
  const setPrefs = useMutation(api.profiles.setNotificationPrefs);
  if (!profile) return null;
  const prefs = profile.notificationPrefs;
  const allRadius = profile.allRadiusMinutes;
  const greatRadius = profile.greatRadiusMinutes;

  const toggle = (key: NotificationPrefKey) => (
    <ToggleRow
      key={key}
      label={NOTIFICATION_PREF_LABELS[key]}
      value={prefs[key]}
      onToggle={(v) => void setPrefs({ prefs: { [key]: v } })}
    />
  );

  return (
    <YStack gap="$3">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Notifications
      </Text>
      {NOTIFICATION_PREF_ORDER.flatMap((key) => {
        if (key === 'nearbyReportDigest') {
          return [
            toggle(key),
            prefs.nearbyReportDigest ? (
              <RadiusRow
                key="all-radius"
                label="Within"
                value={allRadius}
                onChange={(m) => {
                  // Keep X₂ ≥ X₁: bump the great radius up if it would fall below.
                  const nextGreat = greatRadius !== undefined && greatRadius < m ? m : greatRadius;
                  void setPrefs({
                    allRadiusMinutes: m,
                    ...(nextGreat !== greatRadius ? { greatRadiusMinutes: nextGreat } : {}),
                  });
                }}
              />
            ) : null,
          ];
        }
        if (key === 'greatReportNearby') {
          return [
            toggle(key),
            prefs.greatReportNearby ? (
              <RadiusRow
                key="great-radius"
                label="Within"
                value={greatRadius}
                onChange={(m) => {
                  // Clamp X₂ ≥ X₁ (the server rejects otherwise).
                  void setPrefs({
                    greatRadiusMinutes: allRadius !== undefined && m < allRadius ? allRadius : m,
                  });
                }}
              />
            ) : null,
          ];
        }
        return [toggle(key)];
      })}
      {profile.homeCoord === undefined ? (
        <Text color="$foregroundMuted" fontSize={12}>
          Set a home location above for the nearby options to take effect.
        </Text>
      ) : null}
      <ChannelSettings channelPrefs={profile.channelPrefs} />
    </YStack>
  );
}

/**
 * The two transports (A08 PR 3 / D174) — the per-type toggles above say *what*, these say *how far*:
 * a push to your phones, an email for the types worth one. Plus the one device-level switch, "this
 * phone", which is where notification permission is actually asked for (never on cold launch).
 */
function ChannelSettings({
  channelPrefs,
}: {
  channelPrefs: { push: boolean; email: boolean } | undefined;
}) {
  const setChannels = useMutation(api.profiles.setChannelPrefs);
  const registerToken = useMutation(api.pushTokens.register);
  const unregisterToken = useMutation(api.pushTokens.unregister);
  const releaseToken = useMutation(api.pushTokens.release);
  // Convex mutation refs are stable across renders, so this memo holds for the component's life.
  const effects = useMemo(
    () => ({ register: registerToken, unregister: unregisterToken, release: releaseToken }),
    [registerToken, unregisterToken, releaseToken],
  );
  const channels = effectiveChannelPrefs(channelPrefs);
  // Device state: opted out locally, or registered (a token exists and permission is granted).
  // `denied` is the OS setting; `unavailable` is a platform that can't mint a token at all.
  const [device, setDevice] = useState<'unknown' | 'on' | 'off' | 'denied' | 'unavailable'>(
    'unknown',
  );
  useEffect(() => {
    let canceled = false;
    (async () => {
      if (isDeviceOptedOut()) {
        if (!canceled) setDevice('off');
        return;
      }
      const token = await registerIfPermitted(effects);
      if (!canceled) setDevice(token ? 'on' : 'off');
    })().catch(() => {});
    return () => {
      canceled = true;
    };
  }, [effects]);

  async function onDeviceToggle(next: boolean) {
    if (next) {
      const result = await enablePushOnThisDevice(effects);
      setDevice(result.status);
    } else {
      // The local opt-out is the switch; the server-side unregister behind it is best-effort and,
      // offline, queued — the row must read "off" now, not when the connection comes back.
      setDevice('off');
      await disablePushOnThisDevice(effects);
    }
  }

  return (
    <YStack gap="$3" marginTop="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Where they reach you
      </Text>
      <ToggleRow
        label={CHANNEL_PREF_LABELS.push}
        value={channels.push}
        onToggle={(v) => void setChannels({ push: v })}
      />
      {channels.push ? (
        <ToggleRow
          label="…including this phone"
          value={device === 'on'}
          onToggle={(v) => void onDeviceToggle(v)}
        />
      ) : null}
      {device === 'denied' ? (
        <Paragraph color="$foregroundMuted" fontSize={12}>
          Notifications are turned off for Gli in your phone’s settings. Allow them there, then flip
          this on.
        </Paragraph>
      ) : null}
      {device === 'unavailable' ? (
        <Paragraph color="$foregroundMuted" fontSize={12}>
          This phone couldn’t be set up for push just now. Check your connection and try again.
        </Paragraph>
      ) : null}
      <ToggleRow
        label={CHANNEL_PREF_LABELS.email}
        value={channels.email}
        onToggle={(v) => void setChannels({ email: v })}
      />
      <Paragraph color="$foregroundMuted" fontSize={12}>
        Email is only for the daily digest, unreported skates, bounties and moderator rulings —
        never every thumb. Every email has a one-click unsubscribe.
      </Paragraph>
    </YStack>
  );
}

/** The caller's blocked users (D32) with an unblock control. A block never hid their reports (D3). */
function BlockedUsers() {
  const blocks = useQuery(api.blocks.myBlocks, {});
  const unblock = useMutation(api.blocks.unblock);

  if (blocks === undefined || blocks.length === 0) return null;

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Blocked users
      </Text>
      {blocks.map((b) => (
        <XStack key={b.userId} gap="$2" alignItems="center">
          <Avatar displayName={b.displayName} imageUrl={b.profileImageUrl} size={28} />
          <Text flex={1} color="$foreground">
            {b.displayName} · @{b.username}
          </Text>
          <Button size="$2" onPress={() => unblock({ targetUserId: b.userId as Id<'profiles'> })}>
            Unblock
          </Button>
        </XStack>
      ))}
    </YStack>
  );
}
