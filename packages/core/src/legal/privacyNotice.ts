/**
 * **Which Privacy Notice an acceptance agreed to** (D295). The agree line names two documents — *"I
 * have read and agree to the Terms of Use and the Privacy Notice."* — and the notice is a link, never
 * read to an end, so unlike the terms it is not data here: `PRIVACY.md` is the text. This pins which
 * text it was, so a terms record can say so.
 *
 * `PRIVACY_NOTICE_VERSION` is `PRIVACY.md`'s *Last updated* date and `PRIVACY_NOTICE_SHA256` the
 * SHA-256 of the whole file (UTF-8, hex); `packages/guards/src/termsDocument.test.ts` holds both to
 * the file. **To change the notice:** edit `PRIVACY.md`, set its *Last updated* to today, and paste
 * the version and hash the guard prints here. A notice change alone does not ask anyone to accept
 * again (the governor's ruling, B03 §9.15); the next terms acceptance pins the new one.
 */

import { claimMatches } from './hashLedger';

export const PRIVACY_NOTICE_VERSION = '2026-11-24';

export const PRIVACY_NOTICE_SHA256 =
  '6cb12c1bab8530dc2c1252e9a5583984d8e64c4ea35a84419d32c012b8e2c63d';

/** Whether a client's `{ version, hash }` names the notice this build serves. */
export function isCurrentPrivacyNotice(claim: { version: string; hash: string }): boolean {
  return claimMatches({ version: PRIVACY_NOTICE_VERSION, hash: PRIVACY_NOTICE_SHA256 }, claim);
}
