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
  name: 'Gli',
  // `slug` and `scheme` deliberately keep the old name. The slug identifies the project on
  // EAS (it pairs with `extra.eas.projectId`), and `skating://` is registered with Strava as
  // an OAuth callback and baked into every hazard deep link already in the wild — neither is
  // user-visible, and renaming them buys nothing but a migration.
  slug: 'skating-app',
  owner: 'tatwater',
  scheme: 'skating',
  version: '0.0.1',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  // EAS Update (OTA). Ships a new *JS bundle + assets* to installed builds without a rebuild
  // or a store round-trip — the `channel` in eas.json picks which branch a build subscribes to.
  //
  // `fingerprint` policy derives the runtime version by hashing the native layer (deps, plugins,
  // permissions, config). That's the safety interlock: change only JS and the fingerprint holds,
  // so the update reaches existing installs. Touch anything NATIVE — add a module, edit a plugin,
  // change a permission string, bump the SDK — and the fingerprint changes, so the update is
  // simply not offered to old builds instead of shipping them a bundle they'd crash on.
  // A native change therefore still requires a fresh `eas build` + reinstall. There is no way
  // around that; it's the price of not being able to hot-swap native code.
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/bc7e5bb9-9b85-4343-b93c-cdd14cbeeb64',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.teaganatwater.gli',
  },
  android: {
    package: 'com.teaganatwater.gli',
    // Android masks this to whatever shape the launcher uses (circle, squircle, teardrop),
    // so the foreground keeps the wordmark well inside the safe zone and the navy is painted
    // by the OS behind it rather than baked into the image.
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0b1620',
    },
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
          'Gli uses your location to frame the map on nearby lakes and mark where you skated.',
        locationAlwaysAndWhenInUsePermission:
          'Gli uses your location in the background only while "on-ice mode" is on, to warn you about reported ice hazards ahead while you skate. It stays on your device and you can turn it off in one tap.',
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
        photosPermission: 'Gli accesses your photos so you can attach them to an ice report.',
        cameraPermission:
          'Gli uses the camera so you can photograph ice conditions for a report.',
      },
    ],
    // The Gli wordmark. The image is required on Android: expo-splash-screen always references
    // a splash drawable, so without one, resource linking fails at build time.
    //
    // `userInterfaceStyle` is 'automatic', so the splash follows the system theme: the black
    // mark on white in light mode, the white mark on the app's navy in dark. Both PNGs are the
    // mark on transparency — the background here is what's actually painted behind it — so the
    // duotone accent is the only part that stays fixed across the two.
    [
      'expo-splash-screen',
      {
        backgroundColor: '#ffffff',
        image: './assets/splash-icon-light.png',
        imageWidth: 200,
        dark: {
          backgroundColor: '#0b1620',
          image: './assets/splash-icon-dark.png',
        },
      },
    ],
    [
      '@sentry/react-native/expo',
      {
        organization: process.env.SENTRY_ORG ?? 'PLACEHOLDER_ORG',
        project: process.env.SENTRY_PROJECT ?? 'PLACEHOLDER_PROJECT',
      },
    ],
    // Gained a config plugin in 57.0.1, so it has to be registered here by hand — `expo install`
    // can't write into a dynamic `app.config.ts` and errors out until this line exists.
    'expo-status-bar',
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
