/**
 * **The way in's words that core's `ONBOARDING_COPY` doesn't have yet** — the web's own lines, kept
 * in this one file so the founder's copy pass finds them together (B03 §9.9). Each is either a line
 * the web already said elsewhere (moved here, unchanged) or a draft for a state the boards don't
 * draw. They belong in `packages/core/src/onboardingCopy.ts` once the copy pass settles them, so the
 * phone can say the same thing.
 *
 * Nothing here may say or imply the ice is safe (D3).
 */
export const WEB_ONBOARDING_COPY = {
  account: {
    /** The live check found the handle taken (was the old profile form's line, 8.18). */
    usernameTaken: (handle: string) => `@${handle} is taken. Pick another, or try one of these:`,
  },
  terms: {
    /** Draft: the full-screen reader's way back (it also closes on Esc). */
    closeFullScreen: 'Back to the terms',
  },
  home: {
    /** Settings' own line, when the browser can't or won't share a position. */
    locateFailed: 'We couldn’t get your location. Check that the browser may share it.',
    /** Settings' own line, when the provider's limit pauses the suggestions. */
    quota: 'Address suggestions are paused for now. Use your current location instead.',
    /** Settings' own line, for a home the server didn't take (a toast). */
    notSaved: 'Your home wasn’t saved. Try again in a moment.',
  },
  profile: {
    /** Draft: a profile save the server didn't take (a toast). */
    notSaved: 'Your profile wasn’t saved. Try again in a moment.',
  },
} as const;
