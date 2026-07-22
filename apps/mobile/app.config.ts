import type { ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config (D8). Barebones Phase 0 shell — Continuous Native Generation
 * (no committed `ios/`/`android/`, see root .gitignore), new architecture (default
 * in SDK 57), EAS dev-client workflow (native map/auth modules need a dev build).
 *
 * `owner` + `extra.eas.projectId` are set below (dynamic config can't be auto-written
 * by EAS, so they're maintained by hand) — see README.
 * Sentry's build-time org/project come from env at build time (see .env.example).
 */
const config: ExpoConfig = {
  name: 'Skating',
  slug: 'skating-app',
  owner: 'tatwater',
  scheme: 'skating',
  version: '0.0.1',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.newmoneycompany.skating',
  },
  android: {
    package: 'com.newmoneycompany.skating',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-web-browser',
    // Native date/time picker for editing a report's skate time (D9 — past times for offline).
    '@react-native-community/datetimepicker',
    // Native MapLibre map (Phase 2 §F). The plugin wires the iOS Podfile post_install; the native
    // SDK bundled by v11.3.x reads Protomaps `.pmtiles` directly (no JS protocol), so the map shares
    // the web basemap. Can't run in Expo Go — needs the EAS/dev build (already our workflow, D8).
    '@maplibre/maplibre-react-native',
    // Device geolocation (D12/D20). Foreground use frames the map on nearby lakes and marks where you
    // skated; the Phase 9.5 opt-in "on-ice mode" (D54 Layer 2) additionally runs a *background*
    // location session while you actively skate, so the directional "hazard ahead" alert fires with the
    // phone pocketed and the screen asleep. Background updates go through a foreground service on Android
    // (a persistent notification — which doubles as the "on-ice mode is on" affordance and one-tap off)
    // and `UIBackgroundModes: location` on iOS. Positions never leave the device (D12): the alert is
    // evaluated and fired entirely on-device. No keep-awake — the screen sleeps at the normal pace.
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Skating uses your location to frame the map on nearby lakes and mark where you skated.',
        locationAlwaysAndWhenInUsePermission:
          'Skating uses your location in the background only while "on-ice mode" is on, to warn you about reported ice hazards ahead while you skate. It stays on your device and you can turn it off in one tap.',
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    // Local (on-device) notifications for the on-ice directional alert (D54 Layer 2). No push token,
    // no server, no credentials — the notification is computed and scheduled entirely on-device, so
    // D12 holds. Permission is requested lazily when the skater arms on-ice mode, never on cold launch.
    'expo-notifications',
    // Report photos (D31/D42): the picker returns EXIF (incl. GPS) so the pipeline can offer the
    // opt-in `placeOnMap` geotag; expo-image-manipulator (no plugin) does the resize + EXIF strip.
    [
      'expo-image-picker',
      {
        photosPermission: 'Skating accesses your photos so you can attach them to an ice report.',
        cameraPermission:
          'Skating uses the camera so you can photograph ice conditions for a report.',
      },
    ],
    // Placeholder logo (D8) — swap `assets/splash-icon.png` for the real brand mark later.
    // The image is required on Android: expo-splash-screen always references a splash
    // drawable, so without one, resource linking fails at build time.
    [
      'expo-splash-screen',
      { backgroundColor: '#0b1620', image: './assets/splash-icon.png', imageWidth: 180 },
    ],
    [
      '@sentry/react-native/expo',
      {
        organization: process.env.SENTRY_ORG ?? 'PLACEHOLDER_ORG',
        project: process.env.SENTRY_PROJECT ?? 'PLACEHOLDER_PROJECT',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: 'bc7e5bb9-9b85-4343-b93c-cdd14cbeeb64',
    },
  },
};

export default config;
