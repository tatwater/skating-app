/**
 * The account menu's words and its one link, shared by both surfaces' menus — the skater app's
 * avatar menu and phone sheet, and the console's menu at the rail's foot — so a label the founder
 * changes changes everywhere it is shown. Surface-neutral on purpose: the console reads these
 * without importing any skater code.
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
