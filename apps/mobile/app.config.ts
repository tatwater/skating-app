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
