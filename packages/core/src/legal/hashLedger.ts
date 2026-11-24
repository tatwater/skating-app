/**
 * A versioned text's ledger of published hashes (`TERMS_HASHES`, `KNOW_BEFORE_YOU_GO_HASHES`): every
 * version skaters were asked to accept or answer, keyed by its date, append only.
 */

/** Never a SHA-256, so a version missing from its ledger can match nothing a client could send. */
export const UNPUBLISHED_HASH = 'unpublished';

/**
 * The hash a ledger holds for `version`, or `UNPUBLISHED_HASH` while an edit is in progress (the
 * version bumped, its line not yet added: the text's own test fails and prints the line).
 */
export function ledgerHash(ledger: Readonly<Record<string, string>>, version: string): string {
  return Object.hasOwn(ledger, version) ? (ledger[version] as string) : UNPUBLISHED_HASH;
}

/** A version and its SHA-256, as a client claims them or a build holds them. */
export interface VersionClaim {
  version: string;
  hash: string;
}

/**
 * Whether a client's claim names exactly the published text `expected` — never the unpublished
 * sentinel. A build whose version is missing from its ledger holds `UNPUBLISHED_HASH` on the client
 * and the server alike, so plain equality would pass and record an acceptance of words nobody
 * published; this refuses it, so such a build can record nothing.
 */
export function claimMatches(expected: VersionClaim, claim: VersionClaim): boolean {
  return (
    expected.hash !== UNPUBLISHED_HASH &&
    claim.version === expected.version &&
    claim.hash === expected.hash
  );
}
