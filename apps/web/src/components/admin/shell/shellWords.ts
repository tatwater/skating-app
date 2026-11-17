/**
 * The console shell's own words: the viewer's menu's row for their own page, and what it says while
 * their profile loads or when it could not be read. Its other labels — Your account, Theme, Sign
 * out — are the skater menu's, shared from `lib/account`; the theme's three choices are the kit
 * picker's.
 */
export const USER_MENU_WORDS = {
  /** The row that opens the viewer's own person page in People. */
  ownPage: 'Your page in People',
  /** The menu's head while the viewer's profile loads — said to a reader; the eye sees a skeleton. */
  loading: 'Loading your profile',
  /** The menu's head when the viewer's profile could not be read. Sign out still works. */
  failed: 'Your profile didn’t load',
  /** Sign out didn't go through (Clerk didn't answer): a toast; the viewer is still signed in. */
  signOutFailed: {
    title: 'Not signed out',
    description: 'You’re still signed in. Check your connection and try again.',
  },
} as const;
