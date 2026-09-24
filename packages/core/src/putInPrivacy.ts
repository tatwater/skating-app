/**
 * The per-report put-in opt-out (Phase 04 decision #7) and the profile default it remembers.
 *
 * A report always names its water body; what this governs is the **precise spot** — the pin the map
 * draws from `reports.point`, and, for a report published from a recorded track, whether the ends of
 * that path are clipped near the shore (D58's put-in-gated clipping reads the same flag). Both are
 * "hide a marker, never scrub a location" (the schema note on `reports.showPutIn`): the coarse place
 * label stays, the report stays public, only the launch stops being pinpointed.
 *
 * The opt-out shipped server-side in Phase 04 with no client control, so until 2026-09-20 no skater
 * could set it and the clipping never fired — the deferred-register audit's one privacy finding.
 * The switch lives on the report form (the choice is per report), and the profile remembers the
 * last choice as the default for the next one (`profiles.showPutInDefault`), the way the other
 * privacy switches persist rather than asking every time.
 *
 * Copy lives here, not in either app, for the same reason as `trackPrivacy.ts`: one promise, two
 * surfaces, and they must not describe it differently.
 */

/** Section heading on the settings surfaces. */
export const SHOW_PUT_IN_HEADING = 'Put-ins on your reports';

/** The switch's label — on the report form and on settings. "On" means shown, matching the field. */
export const SHOW_PUT_IN_LABEL = 'Show where I got on the ice';

/** What the switch does and doesn't do, on the report form. */
export const SHOW_PUT_IN_EXPLAINER =
  "Off keeps the exact spot you got on off the map — the report still names the water body, and a skate path posted with it is trimmed near the shore. Use it for private property or a launch you'd rather not advertise. Remembered for your next report.";

/** The settings-page framing of the same default. */
export const SHOW_PUT_IN_SETTING_EXPLAINER =
  'The starting position of the switch on your next report. Each report keeps its own setting; changing this never touches reports you have already posted.';

/**
 * The remembered default, from the profile field. Unset means shown — the same default the stored
 * report field has, so a profile from before the setting existed behaves as it always did.
 */
export function resolveShowPutInDefault(stored: boolean | undefined): boolean {
  return stored !== false;
}
