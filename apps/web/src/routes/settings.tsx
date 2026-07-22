import { useAuth, useUser } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { DRIVE_TIME_BANDS } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { ProfileEdit } from '../components/ProfileEdit';
import { Avatar } from '../components/ProfileView';
import { Button, buttonVariants } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

/**
 * Account hub — the web analog of mobile's "You" tab (D28). Who you're signed in as, profile
 * editing (bio / town / public↔private, D13), your blocked-users list (D32), the about/license link
 * (D43), and sign-out. GPS connections + notification toggles come in later phases.
 */
export const Route = createFileRoute('/settings')({ component: SettingsPage });

function SettingsPage() {
  const { signOut } = useAuth();
  const { user } = useUser();
  const profile = useQuery(api.profiles.current, {});

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 py-8">
      <h1 className="font-semibold text-2xl text-foreground">Settings</h1>
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-foreground">
            {profile ? (
              <Link
                to="/u/$username"
                params={{ username: profile.username }}
                className="hover:underline"
              >
                {profile.displayName} · @{profile.username}
              </Link>
            ) : (
              'Loading your profile…'
            )}
          </p>
          {user?.primaryEmailAddress?.emailAddress ? (
            <p className="text-foreground-muted">{user.primaryEmailAddress.emailAddress}</p>
          ) : null}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Your profile
        </h2>
        <ProfileEdit />
      </section>

      <HomeLocation />
      <NotificationSettings />
      <BlockedUsers />

      <p className="text-foreground-muted text-sm">GPS connections arrive in later phases.</p>
      <div className="flex gap-3">
        <Link to="/about" className={buttonVariants({ variant: 'outline' })}>
          About &amp; licenses
        </Link>
        <Button variant="destructive" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/**
 * Home location (Phase 4, D11/D18) — the PRIVATE anchor for drive-time bands. Only the derived
 * isochrones + radius are stored server-side; the coordinate itself never leaves your device beyond
 * this set. Uses the browser's geolocation so there's no manual coordinate entry; setting it triggers
 * the isochrone recompute that powers the drive-time feed filter + nearby notifications.
 */
function HomeLocation() {
  const profile = useQuery(api.profiles.current, {});
  const setHome = useMutation(api.profiles.setHome);
  const [status, setStatus] = useState<'idle' | 'locating' | 'error'>('idle');

  const useCurrentLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('error');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void setHome({ homeCoord: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
        setStatus('idle');
      },
      () => setStatus('error'),
    );
  };

  const hasHome = profile?.homeCoord !== undefined;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Home &amp; drive time
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <p className="text-foreground-muted text-sm">
            Your home anchors the drive-time filter and nearby notifications. It stays private — we
            store only the derived travel-time zones, never the coordinate.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={useCurrentLocation}
              disabled={status === 'locating'}
            >
              {hasHome ? 'Update home from current location' : 'Set home from current location'}
            </Button>
            {hasHome ? (
              <Button variant="ghost" size="sm" onClick={() => void setHome({})}>
                Clear
              </Button>
            ) : null}
          </div>
          {status === 'locating' ? (
            <p className="text-foreground-muted text-sm">Locating…</p>
          ) : status === 'error' ? (
            <p className="text-destructive text-sm">Couldn't get your location.</p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

/** A radius picker (30/60/90 min) or "off" for the notification distances. */
function RadiusSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | undefined;
  onChange: (minutes: number | undefined) => void;
}) {
  return (
    <Select
      value={value ? String(value) : 'off'}
      onValueChange={(v) => onChange(v && v !== 'off' ? Number(v) : undefined)}
    >
      <SelectTrigger id={id} size="sm" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="off">Off</SelectItem>
        {DRIVE_TIME_BANDS.map((m) => (
          <SelectItem key={m} value={String(m)}>{`${m} min`}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Notification preferences (Phase 4, decision #4) — favorites (default on, any distance), a daily
 * "all reports nearby" digest within X₁, and "great reports nearby" within X₂ (X₂ ≥ X₁, clamped here
 * and re-enforced server-side). The radii need a home set above; without one, nearby buckets never fire.
 */
function NotificationSettings() {
  const profile = useQuery(api.profiles.current, {});
  const setPrefs = useMutation(api.profiles.setNotificationPrefs);
  if (!profile) return null;
  const prefs = profile.notificationPrefs;
  const allRadius = profile.allRadiusMinutes;
  const greatRadius = profile.greatRadiusMinutes;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Notifications
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="notif-favorite"
              checked={prefs.favoriteReport}
              onCheckedChange={(v) => void setPrefs({ prefs: { favoriteReport: v === true } })}
            />
            <Label htmlFor="notif-favorite" className="text-foreground text-sm">
              New reports on lakes I've favorited
            </Label>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="notif-digest"
                checked={prefs.nearbyReportDigest}
                onCheckedChange={(v) =>
                  void setPrefs({ prefs: { nearbyReportDigest: v === true } })
                }
              />
              <Label htmlFor="notif-digest" className="text-foreground text-sm">
                Daily digest of all reports nearby
              </Label>
            </div>
            {prefs.nearbyReportDigest ? (
              <div className="ml-6 flex items-center gap-2">
                <Label htmlFor="all-radius" className="text-foreground-muted text-xs">
                  Within
                </Label>
                <RadiusSelect
                  id="all-radius"
                  value={allRadius}
                  onChange={(minutes) => {
                    // Keep X₂ ≥ X₁: bump the great radius up if it would fall below.
                    const nextGreat =
                      minutes !== undefined && greatRadius !== undefined && greatRadius < minutes
                        ? minutes
                        : greatRadius;
                    void setPrefs({
                      allRadiusMinutes: minutes,
                      ...(nextGreat !== greatRadius ? { greatRadiusMinutes: nextGreat } : {}),
                    });
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="notif-great"
                checked={prefs.greatReportNearby}
                onCheckedChange={(v) => void setPrefs({ prefs: { greatReportNearby: v === true } })}
              />
              <Label htmlFor="notif-great" className="text-foreground text-sm">
                Great reports nearby (I'll drive farther for perfect ice)
              </Label>
            </div>
            {prefs.greatReportNearby ? (
              <div className="ml-6 flex items-center gap-2">
                <Label htmlFor="great-radius" className="text-foreground-muted text-xs">
                  Within
                </Label>
                <RadiusSelect
                  id="great-radius"
                  value={greatRadius}
                  onChange={(minutes) => {
                    // Clamp X₂ ≥ X₁ client-side (the server rejects otherwise).
                    if (minutes !== undefined && allRadius !== undefined && minutes < allRadius) {
                      void setPrefs({ greatRadiusMinutes: allRadius });
                      return;
                    }
                    void setPrefs({ greatRadiusMinutes: minutes });
                  }}
                />
              </div>
            ) : null}
          </div>

          {profile.homeCoord === undefined ? (
            <p className="text-foreground-muted text-xs">
              Set a home location above for the nearby options to take effect.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

/** The caller's blocked users (D32) with an unblock control. A block never hid their reports (D3). */
function BlockedUsers() {
  const blocks = useQuery(api.blocks.myBlocks, {});
  const unblock = useMutation(api.blocks.unblock);

  if (blocks === undefined || blocks.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Blocked users
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          {blocks.map((b) => (
            <div key={b.userId} className="flex items-center gap-2">
              <Avatar displayName={b.displayName} imageUrl={b.profileImageUrl} size={28} />
              <span className="flex-1 text-foreground text-sm">
                {b.displayName} · @{b.username}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => unblock({ targetUserId: b.userId as Id<'profiles'> })}
              >
                Unblock
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
