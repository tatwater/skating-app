/**
 * **The phone's onboarding words that core doesn't have yet.** Everything else on these screens is
 * core's (`ONBOARDING_COPY`, the terms, the questions) so the two apps say the same thing; these are
 * the few lines the phone needs that the boards don't draw, kept in this one file so the founder's
 * copy pass finds them together and they can move to core in one step. All drafts.
 */

export const ONBOARDING_COPY_MOBILE = {
  account: {
    /** The live check found the username in use (a client-side field problem: amber, inline). */
    usernameTaken: 'That username is taken. Try another one.',
    /** The month picker's button before a month is picked, and its sheet's title. */
    pickMonth: 'Pick a month',
    cancel: 'Cancel',
  },
  home: {
    /** The address field's placeholder (the web's own). */
    addressPlaceholder: 'Start typing an address',
    /** The suggestions failed this once; typing again retries (the web's own words). */
    suggestionsFailed: 'Suggestions didn’t load. Keep typing, or use your current location.',
    /** No provider, or its limit was reached: the typed address is out for this session. */
    suggestionsOff: 'Address search isn’t available right now. You can use your current location.',
    /** The field's line once the phone's location was taken instead of an address. */
    usingLocation: 'Using your current location.',
    /** The location couldn't be read (denied, or no fix). */
    locationFailed: 'Couldn’t get your location. Check that Gli is allowed to use it.',
  },
} as const;
