/**
 * Remote push registration (A08 PR 3) — the device half of "push is a transport over the inbox".
 *
 * Phase 09b installed `expo-notifications` for **local** on-ice alerts and deliberately never asked
 * Expo for a push token. This does, under two rules that keep the Phase 09b posture:
 *
 * 1. **Never prompt on cold launch.** `registerIfPermitted` only registers when permission is
 *    *already* granted (by on-ice mode, or by the explicit switch below); a permission prompt the
 *    moment the app opens is exactly the friction that gets it denied. The You tab's "this phone"
 *    switch is the one place that asks, through the same serialized `ensureNotificationPermission`.
 * 2. **A device-level off is remembered on the device.** Flipping the switch off unregisters the
 *    token and writes `push_device_opt_out` to the prefs db, so the next app open doesn't quietly
 *    re-register it. The account-level `channelPrefs.push` switch is separate and server-side: that
 *    one silences every phone at once.
 * 3. **Leaving must not depend on the network or the session it is ending.** The token the server
 *    holds is written to the prefs db when it's registered, so sign-out can name it without asking
 *    Expo again, and it is released through `pushTokens.release` — unauthenticated by design, the
 *    token being the credential — so a mutation queued offline still lands after Clerk's session is
 *    gone. A release that can't complete in time is remembered (`push_pending_release`) and retried
 *    at the next launch, signed in or not, until it does.
 *
 * The token itself is Expo's (`ExponentPushToken[…]`), minted against the EAS project id — Expo's
 * push service fronts APNs and FCM, so the server never holds a platform credential. Those live in
 * EAS (`eas credentials`): an FCM V1 service-account key for Android, an APNs key for iOS.
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ensureNotificationPermission } from './notifications';
import { readPref, writePref } from './prefsDb';

const OPT_OUT_KEY = 'push_device_opt_out';
/** The token the server currently holds for this device, as of the last successful `register`. */
const REGISTERED_TOKEN_KEY = 'push_registered_token';
/** A token whose release didn't complete — sign-out moved on before the mutation landed. */
const PENDING_RELEASE_KEY = 'push_pending_release';
/** Android needs a channel before a remote notification can show; the server sends `channelId: 'default'`. */
const ANDROID_CHANNEL = 'default';
/** How long an unregister may hold up the thing that asked for it (sign-out, the device switch). */
const UNREGISTER_TIMEOUT_MS = 4000;

export type PushPlatform = 'ios' | 'android';

export function pushPlatform(): PushPlatform | null {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return null;
}

/** Whether this device has been explicitly switched off (survives app restarts). */
export function isDeviceOptedOut(): boolean {
  try {
    return readPref(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDeviceOptedOut(optedOut: boolean): void {
  try {
    writePref(OPT_OUT_KEY, optedOut ? '1' : '0');
  } catch {
    // A prefs write failing costs one remembered choice, not the launch.
  }
}

/** A stored token, or `null` when the row is missing, empty, or the store can't answer. */
function readToken(key: string): string | null {
  try {
    return readPref(key) || null;
  } catch {
    return null;
  }
}

/** Write a token, or forget it (`null`). Best-effort, like every prefs write here. */
function writeToken(key: string, token: string | null): void {
  try {
    writePref(key, token ?? '');
  } catch {
    // Costs one remembered token; the next register or release writes it again.
  }
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
      name: 'Notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  } catch {
    // Channel creation failing leaves Android's default behaviour; not fatal.
  }
}

/**
 * The Expo push token for this device, or `null` without a project id or where the platform can't
 * mint one (an iOS simulator; an Android emulator without Play services). The failure is caught
 * rather than pre-empted with a device check — `expo-device` would be a native dependency for one
 * boolean the token call already knows.
 */
export async function fetchExpoPushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  } catch {
    return null;
  }
}

export interface RegisterEffects {
  register: (args: {
    token: string;
    platform: PushPlatform;
    deviceName?: string;
  }) => Promise<unknown>;
  /** Owner-scoped; the device switch, where a session is a given. */
  unregister: (args: { token: string }) => Promise<unknown>;
  /** Token-scoped, no session; sign-out and the launch-time retry. */
  release: (args: { token: string }) => Promise<unknown>;
}

/**
 * Register on app open **only if** permission is already granted and the device isn't opted out.
 * Never prompts. Returns the token when registered, else `null`.
 */
export async function registerIfPermitted(effects: RegisterEffects): Promise<string | null> {
  const platform = pushPlatform();
  if (!platform || isDeviceOptedOut()) return null;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) return null;
  } catch {
    return null;
  }
  return registerNow(platform, effects);
}

/**
 * What the explicit switch came back with. `denied` is the one the person can act on (the OS
 * setting); `unavailable` is a platform that granted permission and still minted nothing — an iOS
 * simulator, an Android build without its FCM config, no network — which no settings screen fixes.
 */
export type EnablePushResult =
  | { status: 'on'; token: string }
  | { status: 'denied' }
  | { status: 'unavailable' };

/**
 * The explicit switch: ask for permission (once, serialized with on-ice mode's ask), then register.
 */
export async function enablePushOnThisDevice(effects: RegisterEffects): Promise<EnablePushResult> {
  const platform = pushPlatform();
  if (!platform) return { status: 'unavailable' };
  setDeviceOptedOut(false);
  const granted = await ensureNotificationPermission();
  if (!granted) return { status: 'denied' };
  const token = await registerNow(platform, effects);
  return token ? { status: 'on', token } : { status: 'unavailable' };
}

/**
 * The explicit off: forget this device server-side and remember the choice locally. The person is
 * still signed in, so this is the owner-scoped `unregister`; issued offline it queues with the
 * session intact and lands on reconnect, and the local opt-out stops any re-register meanwhile.
 */
export async function disablePushOnThisDevice(effects: RegisterEffects): Promise<void> {
  setDeviceOptedOut(true);
  await withinBound(async () => {
    const token = await currentToken();
    if (!token) return;
    await effects.unregister({ token });
    writeToken(REGISTERED_TOKEN_KEY, null);
  });
}

/**
 * Forget this device server-side without touching the local opt-out — what sign-out does, so a
 * phone nobody is signed in on stops ringing for the account that left.
 *
 * Three things make this hold when the network doesn't. The token comes from the prefs db, written
 * at register, so no call to Expo stands between sign-out and naming the row. It goes through
 * `release`, which needs no session, so a mutation the Convex client queues offline is still valid
 * when it finally lands — after Clerk's sign-out, an authenticated one would arrive as nobody and
 * fail. And the token is written to `push_pending_release` **before** the attempt, so a sign-out
 * that moves on at the bound, or an app killed mid-flight, leaves a note the next launch acts on
 * (`retryPendingRelease`) rather than a row that rings until someone else signs in.
 *
 * Bounded, because "best-effort" has to include the wait: a queued mutation resolves only when the
 * connection returns, and a sign-out that awaited it would hang with it.
 */
export async function unregisterThisDevice(effects: RegisterEffects): Promise<void> {
  await withinBound(async () => {
    const token = await currentToken();
    if (!token) return;
    writeToken(PENDING_RELEASE_KEY, token);
    await effects.release({ token });
    forgetReleased(token);
  });
}

/**
 * Finish a release sign-out couldn't: called at every launch, signed in or not, before the tabs
 * layout can register. No bound and no await from the caller — it's a fire-and-forget the Convex
 * client queues until it has a connection.
 */
export function retryPendingRelease(effects: Pick<RegisterEffects, 'release'>): void {
  const token = readToken(PENDING_RELEASE_KEY);
  if (!token) return;
  effects
    .release({ token })
    .then(() => forgetReleased(token))
    .catch(() => {
      // Still pending; the next launch tries again.
    });
}

/** The token the server holds for this device — the stored one, minting only when nothing is stored. */
async function currentToken(): Promise<string | null> {
  return readToken(REGISTERED_TOKEN_KEY) ?? (await fetchExpoPushToken());
}

/** A release landed: neither the "registered" nor the "pending" note should name this token any more. */
function forgetReleased(token: string): void {
  if (readToken(PENDING_RELEASE_KEY) === token) writeToken(PENDING_RELEASE_KEY, null);
  if (readToken(REGISTERED_TOKEN_KEY) === token) writeToken(REGISTERED_TOKEN_KEY, null);
}

/** Run a best-effort step, moving on at `UNREGISTER_TIMEOUT_MS` whether or not it finished. */
async function withinBound(step: () => Promise<void>): Promise<void> {
  await Promise.race([
    step().catch(() => {
      // Best-effort: what a failure leaves behind is documented at each caller.
    }),
    new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_TIMEOUT_MS)),
  ]);
}

async function registerNow(
  platform: PushPlatform,
  effects: RegisterEffects,
): Promise<string | null> {
  await ensureAndroidChannel();
  const token = await fetchExpoPushToken();
  if (!token) return null;
  try {
    const deviceName = Constants.deviceName ?? undefined;
    await effects.register({ token, platform, ...(deviceName ? { deviceName } : {}) });
    writeToken(REGISTERED_TOKEN_KEY, token);
    // A registration supersedes any release still owed for the same token: the row is homed to
    // whoever is signed in now, which is exactly what a late release would undo. (A retry already
    // in flight was queued before this register, and the Convex client keeps that order.)
    if (readToken(PENDING_RELEASE_KEY) === token) writeToken(PENDING_RELEASE_KEY, null);
    return token;
  } catch {
    return null;
  }
}
