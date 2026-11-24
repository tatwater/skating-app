/**
 * **The phone's own onboarding words**: only what no other surface draws. Everything else on these
 * screens is core's (`ONBOARDING_COPY`, `ADDRESS_FIELD_COPY`, the terms, the questions), so the two
 * apps say the same thing. Drafts, for the founder's copy pass.
 */

export const ONBOARDING_COPY_MOBILE = {
  account: {
    /** The month picker's button before a month is picked, and its sheet's title. */
    pickMonth: 'Pick a month',
    cancel: 'Cancel',
  },
} as const;
