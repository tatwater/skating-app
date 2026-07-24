import { useAuth, useUser } from '@clerk/clerk-expo';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { DRIVE_TIME_BANDS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, H1, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { ProfileEdit } from '../../src/components/ProfileEdit';
import { Avatar } from '../../src/components/ProfileView';

/**
 * Profile / settings hub (D28). Who you're signed in as (with a link to your public profile),
 * profile editing (bio / town / public↔private, D13), your blocked-users list (D32), the
 * license/about link (D43), and sign-out. GPS connections + notification toggles come later.
 */
export default function YouScreen() {
  const { signOut } = useAuth();
  const { user } = useUser();
  const profile = useQuery(api.profiles.current, {});
  const router = useRouter();

  async function onSignOut() {
    await signOut();
    router.replace('/sign-in');
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView>
        <YStack flex={1} gap="$4" padding="$4" backgroundColor="$background">
          <H1 color="$foreground">You</H1>
          {profile ? (
            <Link
              href={{ pathname: '/u/[username]', params: { username: profile.username } }}
              asChild
            >
              <Paragraph color="$foreground">
                {profile.displayName} · @{profile.username}
              </Paragraph>
            </Link>
          ) : (
            <Paragraph color="$foreground">Loading your profile…</Paragraph>
          )}
          {user?.primaryEmailAddress?.emailAddress ? (
            <Paragraph color="$foregroundMuted">{user.primaryEmailAddress.emailAddress}</Paragraph>
          ) : null}

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
          <HomeLocation />
          <NotificationSettings />

          <BlockedUsers />

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
 * Home location (Phase 4, D11/D18) — the PRIVATE anchor for drive-time bands. Only the derived
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
        <Button size="$3" onPress={useCurrentLocation} disabled={status === 'locating'}>
          {hasHome ? 'Update home' : 'Set home from location'}
        </Button>
        {hasHome ? (
          <Button size="$3" chromeless onPress={() => void setHome({})}>
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
      <Button
        size="$2"
        backgroundColor={value ? '$primary' : undefined}
        color={value ? '$primaryForeground' : undefined}
        chromeless={!value}
        borderWidth={1}
        borderColor={value ? '$primary' : '$border'}
        onPress={() => onToggle(!value)}
      >
        {value ? 'On' : 'Off'}
      </Button>
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
        <Button
          key={m}
          size="$2"
          backgroundColor={value === m ? '$primary' : undefined}
          color={value === m ? '$primaryForeground' : undefined}
          chromeless={value !== m}
          borderWidth={1}
          borderColor={value === m ? '$primary' : '$border'}
          onPress={() => onChange(m)}
        >
          {`${m}m`}
        </Button>
      ))}
    </XStack>
  );
}

/**
 * Notification preferences (Phase 4, decision #4) — favorites (default on, any distance), a daily
 * "all reports nearby" digest within X₁, and "great reports nearby" within X₂ (X₂ ≥ X₁, clamped here
 * and re-enforced server-side). The radii need a home set above to take effect.
 */
function NotificationSettings() {
  const profile = useQuery(api.profiles.current, {});
  const setPrefs = useMutation(api.profiles.setNotificationPrefs);
  if (!profile) return null;
  const prefs = profile.notificationPrefs;
  const allRadius = profile.allRadiusMinutes;
  const greatRadius = profile.greatRadiusMinutes;

  return (
    <YStack gap="$3">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Notifications
      </Text>
      <ToggleRow
        label="New reports on lakes I've favorited"
        value={prefs.favoriteReport}
        onToggle={(v) => void setPrefs({ prefs: { favoriteReport: v } })}
      />
      <ToggleRow
        label="Daily digest of all reports nearby"
        value={prefs.nearbyReportDigest}
        onToggle={(v) => void setPrefs({ prefs: { nearbyReportDigest: v } })}
      />
      {prefs.nearbyReportDigest ? (
        <RadiusRow
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
      ) : null}
      <ToggleRow
        label="Great reports nearby (drive farther for perfect ice)"
        value={prefs.greatReportNearby}
        onToggle={(v) => void setPrefs({ prefs: { greatReportNearby: v } })}
      />
      {prefs.greatReportNearby ? (
        <RadiusRow
          label="Within"
          value={greatRadius}
          onChange={(m) => {
            // Clamp X₂ ≥ X₁ (the server rejects otherwise).
            void setPrefs({
              greatRadiusMinutes: allRadius !== undefined && m < allRadius ? allRadius : m,
            });
          }}
        />
      ) : null}
      {profile.homeCoord === undefined ? (
        <Text color="$foregroundMuted" fontSize={12}>
          Set a home location above for the nearby options to take effect.
        </Text>
      ) : null}
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
