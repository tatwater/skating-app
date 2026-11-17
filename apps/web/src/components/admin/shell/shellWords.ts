/**
 * The console shell's own words: what the viewer's menu says while their profile loads or when it
 * could not be read. Its row labels — Your profile, Theme, Sign out — are the skater menu's, shared
 * from `lib/account`; the theme's three choices are the kit picker's.
 */
export const USER_MENU_WORDS = {
  /** The menu's head while the viewer's profile loads — said to a reader; the eye sees a skeleton. */
  loading: 'Loading your profile',
  /** The menu's head when the viewer's profile could not be read. Sign out still works. */
  failed: 'Your profile didn’t load',
} as const;
