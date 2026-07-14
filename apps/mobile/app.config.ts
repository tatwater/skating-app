import type { ExpoConfig } from 'expo/config'

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
    // Device geolocation for home/water framing (D12/D20) — declares the location permission + copy.
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Skating uses your location to frame the map on nearby lakes and mark where you skated.',
      },
    ],
    // Report photos (D31/D42): the picker returns EXIF (incl. GPS) so the pipeline can offer the
    // opt-in `placeOnMap` geotag; expo-image-manipulator (no plugin) does the resize + EXIF strip.
    [
      'expo-image-picker',
      {
        photosPermission: 'Skating accesses your photos so you can attach them to an ice report.',
        cameraPermission: 'Skating uses the camera so you can photograph ice conditions for a report.',
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
}

export default config
