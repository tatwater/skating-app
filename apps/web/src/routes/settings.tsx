import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  CHANNEL_PREF_LABELS,
  DRIVE_TIME_BANDS,
  effectiveChannelPrefs,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PREF_LABELS,
  NOTIFICATION_PREF_ORDER,
  type NotificationPrefKey,
} from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { AccountLifecycle } from '../components/AccountLifecycle';
import { AggregateTracksSetting } from '../components/AggregateTracksSetting';
import { ChangeEmail } from '../components/ChangeEmail';
import { ContactSupport } from '../components/ContactSupport';
import { ProfileEdit } from '../components/ProfileEdit';
import { Avatar } from '../components/ProfileView';
import { PutInSetting } from '../components/PutInSetting';
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
 * editing (bio / town / public↔private, D13), home + drive time, notification toggles, the D58
 * aggregate-tracks opt-out, your blocked-users list (D32), data export + account deletion (D33/D62),
 * the about/license link (D43), and sign-out. **Connecting Strava lives in the mobile app** — it's an adjunct to recording, which is
 * phone-only — but the aggregate opt-out is here too, because it governs data already collected and
 * must be withdrawable from wherever you signed in.
 */
export const Route = createFileRoute('/settings')({ component: SettingsPage });

function SettingsPage() {
  const { signOut } = useAuth();
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
          <ChangeEmail />
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
      <PutInSetting />
      <AggregateTracksSetting />
      <BlockedUsers />

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Contact support
        </h2>
        <ContactSupport />
      </section>

      <AccountLifecycle />

      <p className="text-foreground-muted text-sm">
        Recording a skate and connecting Strava live in the mobile app.
      </p>
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
 * Home location (Phase 04, D11/D18) — the PRIVATE anchor for drive-time bands. Only the derived
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
 * Notification preferences — **every** type, iterated from the vocabulary in `@skating/core` (D16;
 * A08). This page used to hand-pick three of ten toggles, and the other seven were switches on the
 * server nobody could reach. The two radius-bearing Phase-04 buckets sit last, each with its "within"
 * row (X₂ ≥ X₁, clamped here and re-enforced server-side); the radii need a home set above.
 */
function NotificationSettings() {
  const profile = useQuery(api.profiles.current, {});
  const setPrefs = useMutation(api.profiles.setNotificationPrefs);
  const setChannels = useMutation(api.profiles.setChannelPrefs);
  if (!profile) return null;
  const prefs = profile.notificationPrefs;
  const channels = effectiveChannelPrefs(profile.channelPrefs);
  const allRadius = profile.allRadiusMinutes;
  const greatRadius = profile.greatRadiusMinutes;

  const toggle = (key: NotificationPrefKey) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`notif-${key}`}
        checked={prefs[key]}
        onCheckedChange={(v) => void setPrefs({ prefs: { [key]: v === true } })}
      />
      <Label htmlFor={`notif-${key}`} className="text-foreground text-sm">
        {NOTIFICATION_PREF_LABELS[key]}
      </Label>
    </div>
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Notifications
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {NOTIFICATION_PREF_ORDER.map((key) => {
            if (key === 'nearbyReportDigest') {
              return (
                <div key={key} className="flex flex-col gap-2">
                  {toggle(key)}
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
                            minutes !== undefined &&
                            greatRadius !== undefined &&
                            greatRadius < minutes
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
              );
            }
            if (key === 'greatReportNearby') {
              return (
                <div key={key} className="flex flex-col gap-2">
                  {toggle(key)}
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
                          if (
                            minutes !== undefined &&
                            allRadius !== undefined &&
                            minutes < allRadius
                          ) {
                            void setPrefs({ greatRadiusMinutes: allRadius });
                            return;
                          }
                          void setPrefs({ greatRadiusMinutes: minutes });
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            }
            return <div key={key}>{toggle(key)}</div>;
          })}

          {/* The two transports (A08 PR 3 / D174): what the toggles above pick, these carry — push
              goes to the phones this account is signed in on; email only for the digest-class types. */}
          <div className="flex flex-col gap-3 border-border border-t pt-4">
            <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
              Where they reach you
            </h3>
            {NOTIFICATION_CHANNELS.map((channel) => (
              <div key={channel} className="flex items-center gap-2">
                <Checkbox
                  id={`channel-${channel}`}
                  checked={channels[channel]}
                  onCheckedChange={(v) => void setChannels({ [channel]: v === true })}
                />
                <Label htmlFor={`channel-${channel}`} className="text-foreground text-sm">
                  {CHANNEL_PREF_LABELS[channel]}
                </Label>
              </div>
            ))}
            <p className="text-foreground-muted text-xs">
              Push goes to the phones you’re signed in on. Email is only for the daily digest,
              unreported skates, bounties and moderator rulings — never every thumb — and every one
              has a one-click unsubscribe.
            </p>
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
