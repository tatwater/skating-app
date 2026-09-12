/**
 * Remote push registration (N8 PR 3) — the device half of "push is a transport over the inbox".
 *
 * Phase 9.5 installed `expo-notifications` for **local** on-ice alerts and deliberately never asked
 * Expo for a push token. This does, under two rules that keep the Phase 9.5 posture:
 *
 * 1. **Never prompt on cold launch.** `registerIfPermitted` only registers when permission is
 *    *already* granted (by on-ice mode, or by the explicit switch below); a permission prompt the
 *    moment the app opens is exactly the friction that gets it denied. The You tab's "this phone"
 *    switch is the one place that asks, through the same serialized `ensureNotificationPermission`.
 * 2. **A device-level off is remembered on the device.** Flipping the switch off unregisters the
 *    token and writes `push_device_opt_out` to the prefs db, so the next app open doesn't quietly
 *    re-register it. The account-level `channelPrefs.push` switch is separate and server-side: that
 *    one silences every phone at once.
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
/** Android needs a channel before a remote notification can show; the server sends `channelId: 'default'`. */
const ANDROID_CHANNEL = 'default';

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
  unregister: (args: { token: string }) => Promise<unknown>;
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
 * The explicit switch: ask for permission (once, serialized with on-ice mode's ask), then register.
 * Returns the token, or `null` when permission was declined or no token could be minted.
 */
export async function enablePushOnThisDevice(effects: RegisterEffects): Promise<string | null> {
  const platform = pushPlatform();
  if (!platform) return null;
  setDeviceOptedOut(false);
  const granted = await ensureNotificationPermission();
  if (!granted) return null;
  return registerNow(platform, effects);
}

/** The explicit off: forget this device server-side and remember the choice locally. */
export async function disablePushOnThisDevice(effects: RegisterEffects): Promise<void> {
  setDeviceOptedOut(true);
  const token = await fetchExpoPushToken();
  if (token) {
    try {
      await effects.unregister({ token });
    } catch {
      // Offline: the server row lingers until the next successful unregister or account deletion;
      // the local opt-out still stops re-registration, and the server's push will land on a device
      // that has since revoked permission at worst.
    }
  }
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
    return token;
  } catch {
    return null;
  }
}
