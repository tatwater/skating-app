/**
 * Canonical links to the repo's public legal / informational docs. Single-sourced so the
 * About page (D43) and the signup acknowledgment (D45) point at the same place — the
 * assumption-of-risk consent must link to the privacy notice + interim terms. Mirrors the
 * mobile app's `src/lib/links.ts` (each surface owns its own copy of presentational bits).
 */
const REPO = 'https://github.com/tatwater/skating'
const doc = (file: string) => `${REPO}/blob/main/${file}`

export const DOC_URLS = {
  license: doc('LICENSE'),
  licenseExceptions: doc('LICENSE-EXCEPTIONS.md'),
  privacy: doc('PRIVACY.md'),
  terms: doc('TERMS.md'),
} as const
