/**
 * **The `.test.ts` files that need the DOM** — the web unit tests split by environment (the CI
 * saving, 2026-11-22). Every `*.test.tsx` renders, so it runs under jsdom (`unit`); a `*.test.ts` is
 * logic and runs under Node (`unit-node`), with no jsdom to build per file — except the files here,
 * which read `window`, `document`, storage, IndexedDB, a media query, an animation frame or a
 * Testing Library hook, and so run under jsdom with the rest.
 *
 * Kept honest by `packages/guards/src/webTestEnvironments.test.ts`: a `.test.ts` outside this list
 * that names the DOM fails that guard, and one that reaches the DOM through an import fails loudly
 * under Node (`document is not defined`) — add it here. An entry that no longer exists fails too.
 */
export const DOM_TS_TESTS: readonly string[] = [
  'src/components/admin/bodies/openedRecently.test.ts',
  'src/components/admin/body/tabs/listWriter.test.ts',
  'src/components/admin/inbox/handlers/Flag/useFlagServer.test.ts',
  'src/components/admin/inbox/handlers/Flag/useStillHere.test.ts',
  'src/components/admin/reads/readArgs.test.ts',
  'src/components/skater/lake/lakeRouting.test.ts',
  'src/components/skater/settings/useAutosave.test.ts',
  'src/components/skater/sheet/instrumentModes.test.ts',
  'src/components/skater/sheet/photoRelease.test.ts',
  'src/components/skater/sheet/sheetRemoval.properties.test.ts',
  'src/components/skater/sheet/useSheetBody.test.ts',
  'src/components/skater/sheet/useSkateWeather.test.ts',
  'src/components/useFreezeUpFrame.test.ts',
  'src/components/useImageryReveal.test.ts',
  'src/components/usePhotoDrafts.test.ts',
  'src/lib/bodyOutlines.test.ts',
  'src/lib/boot.test.ts',
  'src/lib/hazardDraftOwner.test.ts',
  'src/lib/loadAhead.test.ts',
  'src/lib/mapAttribution.test.ts',
  'src/lib/mediaQuery.test.ts',
  'src/lib/reviewMarkers.test.ts',
  'src/lib/sheetOwner.test.ts',
  'src/lib/sheetReconnect.test.ts',
  'src/lib/sheetStore.persistence.test.ts',
  'src/lib/sheetStore.properties.test.ts',
  'src/lib/sheetStore.resend.test.ts',
  'src/lib/sheetStore.test.ts',
  'src/lib/theme.test.ts',
  'src/lib/useConnection.test.ts',
  'src/lib/useOpenSync.test.ts',
  'src/stores/hazardDraftStore.test.ts',
  'src/stores/searchStore.test.ts',
  'src/stores/skaterMapStore.test.ts',
  'src/stores/storage.test.ts',
];
