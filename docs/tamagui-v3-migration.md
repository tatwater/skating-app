# Tamagui 3 migration

Keep Expo SDK 58 and the app's existing design tokens and themes. This migration changes the
Tamagui API and compiler integration, not the palette or spacing scale. Follow the
[v3 guide](https://tamagui.dev/docs/guides/how-to-upgrade) and keep Config v5 for the first pass.

## What the trial found

- The Tamagui `3.3.3` flat-values codemod identified 1,044 conversion sites under `app` and `src`.
  It classified 1,027 as clean, seven as unverified hosts, and ten as requiring manual review.
  These classifications are not proof that the resulting UI is correct.
- Tamagui 3 no longer ships `@tamagui/babel-plugin`. Remove the legacy plugin rather than mixing
  compiler versions; use the runtime path first, and evaluate the optional Metro integration
  separately.
- Babel `8.1.2` installed in an isolated trial, but pnpm reported unmet Babel 7 peer requirements
  from Expo's transform stack even after removing `@tamagui/babel-plugin`. Keep Babel 7 while
  migrating on SDK 58. Don't bypass the peer requirements to force Babel 8 into this change.

## Implementation and review

1. Capture the current Android preview in light and dark. Include sign-in, the map and its sheet,
   report editing, notifications, and the theme picker.
2. From `apps/mobile`, run the codemod dry-run and review its report before applying it:

   ```sh
   pnpm dlx @tamagui/codemod-flat-values@3.3.3 \
     --source-semantics v2-pixels --report /tmp/tamagui-flat-values.md ./app ./src
   ```

3. Keep the app's custom token values. Convert the manual sites, including the style spread in
   `app/notifications.tsx`. Check control sizes, focus and pressed states, and animation defaults
   against the baseline; type-checking alone can't establish visual parity.
4. Validate the frozen install, peer checks, Expo dependency check, mobile types and tests, and
   Android and iOS bundle exports. Then build a fresh Android preview and repeat the device
   checks. Don't publish this change over the air until native compatibility is established.

The application dependencies and compiler settings remain unchanged until the conversion and
validation are complete.
