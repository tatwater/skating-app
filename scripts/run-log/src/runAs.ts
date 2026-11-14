/**
 * The identity a script's write goes out with when it is made as a person (D256).
 *
 * `convex run --identity` makes the call as that person, so the audit row names them as the actor,
 * and puts `via` (the script's own name) beside the `subject`, so the row also records what the
 * person did it through: "Teagan via seed-destinations". A call made as a person must say which
 * script it is made through, and the name must pass the audit row's own rule (`isAuditVia`), so a
 * mistyped one stops here, before any write, rather than being dropped by the server.
 */
import { AUDIT_VIA_MAX_LENGTH, isAuditVia } from '@skating/core';

/** Who a write is made as, and through what. `as` is the operator's own Clerk user id. */
export interface RunAs {
  as: string;
  via: string;
}

/** The `--identity` arguments for a call: none for a bare (admin-credential) call. */
export function identityArgs(runAs: RunAs | undefined): string[] {
  if (runAs === undefined) return [];
  // Trimmed once, here, and sent as checked: a stray space or newline from the shell would otherwise
  // pass the check and name no one on the server.
  const subject = runAs.as.trim();
  if (subject === '') throw new Error('A call made as a person needs their Clerk user id.');
  if (!isAuditVia(runAs.via)) {
    throw new Error(
      `"${runAs.via}" can't name what this write is made through: use the script's name in ` +
        `lowercase words joined by hyphens, at most ${AUDIT_VIA_MAX_LENGTH} characters.`,
    );
  }
  return ['--identity', JSON.stringify({ subject, via: runAs.via })];
}
