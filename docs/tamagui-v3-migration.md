# Tamagui 3 migration

The mobile app moves to Tamagui `3.3.3` while keeping Expo SDK 58, Config v5, and the app's
palette and spacing tokens. The [v3 guide](https://tamagui.dev/docs/guides/how-to-upgrade)
describes the new flat style syntax. The app uses Tamagui's runtime styles without the legacy
Babel plugin; a Metro compiler integration is not required for this migration.

## Conversion

The `3.3.3` codemod converted 1,034 style sites using v2 pixel semantics. The remaining work
was done manually: dynamic theme values, the conditional press style on notification rows,
named control sizes, and quiet button variants. Hazard actions retain their distinct 64 dp
size. The app keeps the Expo 58 Babel 7 stack; the Babel 8 trial failed pnpm peer checks even
after removing `@tamagui/babel-plugin`.

## Android preview checklist

Compare a pre-upgrade preview and the migration preview on the same device in light and dark:

- Sign-in: button sizes, keyboard, placeholder and caret colors, and focus.
- Map and lake sheet: spacing, close and back buttons, scrolling, and press feedback.
- Report and hazard editing: chip outlines, selected states, and large hazard action targets.
- Notifications: unread marker, pressed background, and navigation on actionable rows only.
- Theme picker: compact touch targets and immediate light/dark updates, including inputs that
  haven't changed value.

Bundle exports do not validate the native UI. Don't publish the migration over the air before
the Android preview is checked.
