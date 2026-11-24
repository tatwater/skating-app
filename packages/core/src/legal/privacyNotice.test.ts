import { describe, expect, it } from 'vitest';
import {
  isCurrentPrivacyNotice,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
} from './privacyNotice';

// That these match `PRIVACY.md` is `packages/guards/src/termsDocument.test.ts`'s job: reading a file
// outside this package from a cached task would replay a stale answer (D236).
describe('the pinned Privacy Notice', () => {
  it('is a dated version and a 64-digit hex hash', () => {
    expect(PRIVACY_NOTICE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRIVACY_NOTICE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the current notice, and nothing else, as current', () => {
    const hash = PRIVACY_NOTICE_SHA256;
    expect(isCurrentPrivacyNotice({ version: PRIVACY_NOTICE_VERSION, hash })).toBe(true);
    expect(isCurrentPrivacyNotice({ version: '2026-11-22', hash })).toBe(false);
    expect(isCurrentPrivacyNotice({ version: PRIVACY_NOTICE_VERSION, hash: 'f'.repeat(64) })).toBe(
      false,
    );
  });
});
