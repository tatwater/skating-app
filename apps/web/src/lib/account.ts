/**
 * The account menu's words and its one link, shared by both surfaces' menus — the skater app's
 * avatar menu and phone sheet, and the console's menu at the rail's foot — so a label the founder
 * changes changes everywhere it is shown. Surface-neutral on purpose: the console reads these
 * without importing the skater menus (it shares only their sign-out guard).
 */
export const ACCOUNT_WORDS = {
  /** The menu, and the control that opens it, to a reader. */
  account: 'Your account',
  profile: 'Your profile',
  theme: 'Theme',
  signOut: 'Sign out',
  /** Said after a link that opens a new tab, to a reader only. */
  newTab: '(opens in a new tab)',
} as const;

/** A person's own skater-facing profile. */
export function profileHref(username: string): string {
  return `/u/${encodeURIComponent(username)}`;
}

/**
 * Sign out's question when the work it would discard is in another tab of this browser — said in
 * the draft guard's dialog, under its own title.
 */
export const SIGN_OUT_WORDS = {
  elsewhere: {
    held: 'A report open in another tab of this browser has changes that aren’t posted yet. Signing out discards them.',
    unknown:
      'This browser can’t check its other tabs, so a report you’re writing in one of them may be discarded.',
  },
} as const;
