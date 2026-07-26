/**
 * Copy for the D58 aggregate-tracks opt-out — single-sourced so web and mobile can't drift.
 *
 * This is a **privacy promise**, which is why it lives here rather than being written twice: two
 * surfaces wording the same control differently means one of them is describing behavior the app
 * doesn't have. The same reasoning as the Strava brand copy (`strava.ts`), for a stronger reason.
 *
 * The framing is deliberate on two counts:
 * 1. **It describes what changes for *other people*, not "hide my data."** The paths this governs are
 *    already public on their reports — publishing the report was the consent (D58). So the honest
 *    question is "should your line be part of the crowd picture," not "should your data be private,"
 *    and overstating it would be its own kind of dishonesty.
 * 2. **It says what the toggle leaves alone.** A switch in a privacy section reads as bigger than it
 *    is unless you name the boundary: recording still works, Strava upload still works, and you still
 *    see your own path on your own report.
 *
 * It also states the retroactive behavior, because that's the part a person can't infer: flipping this
 * on removes paths they already posted, not just future ones (the flag lives on the profile, not the
 * activity — see the schema note on `profiles.excludeTracksFromAggregate`).
 */

/** Section heading for the setting, on both surfaces. */
export const AGGREGATE_OPT_OUT_HEADING = 'Community lake maps';

/** The toggle's label. Phrased so "on" means "opt me out" — matching the stored field's sense. */
export const AGGREGATE_OPT_OUT_LABEL = "Don't use my paths in community lake maps";

/** What the toggle does, including what it deliberately doesn't touch. */
export const AGGREGATE_OPT_OUT_EXPLAINER =
  "When this is on, the routes you skate won't be drawn on a lake's map for other people — including ones you've already posted. You'll still see your own path on your own reports, recording works the same, and Strava uploads are unaffected.";
