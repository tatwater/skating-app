/**
 * **A person's name, where the Inbox may show it** — one rule for every legend, byline, row and
 * timeline line: a person who is gone, or whose account is being deleted (`deleted`, served with
 * their real name while the deletion is pending), is never named. `null` then: each place says its
 * own "a former …" words instead.
 */
export function shownName(
  p: { displayName: string; deleted: boolean } | null | undefined,
): string | null {
  return p == null || p.deleted ? null : p.displayName;
}
