# Partner marks

- `btn_strava_connect_with_orange.svg`, `api_logo_pwrdBy_strava_horiz_*.svg`: Strava's own kits,
  developers.strava.com/guidelines (revised 2025-09-29), copied unaltered from
  `skating-mockups/skater-web/assets/brands/`. Don't modify, alter, or animate them; never draw them
  more prominent than Gli. "Connect with Strava" must lead to Strava's OAuth (here through our own
  `/strava/start`, which binds the browser first).
- The small Strava and Garmin marks in `components/skater/settings/brandMarks.tsx` are Simple Icons'
  paths. Check Garmin's brand terms when its partner application lands; Garmin ships only as a disabled
  "Coming soon" row until then.
- `garmin-mark.svg` is the same Simple Icons Garmin path as a file, for the report sheet's Which lake?
  cards (`components/skater/sheet/WhichLakeCards.tsx`); the same Garmin terms apply. Its viewBox is
  cropped to the wordmark (`0 8.74 24 6.52`, as the boards draw it) so it fills its row; the paths
  are untouched.
