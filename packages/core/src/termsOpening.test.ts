import { describe, expect, it } from 'vitest';

import { TERMS_OPEN_RETRY_GAP_MS, termsOpenRetryDue } from './termsOpening';

// A pinned instant (D243).
const T0 = Date.UTC(2026, 10, 24, 15);

describe('termsOpenRetryDue', () => {
  it('tries again only once the gap has passed since the last try', () => {
    expect(TERMS_OPEN_RETRY_GAP_MS).toBe(5_000);
    expect(termsOpenRetryDue(T0, T0)).toBe(false);
    expect(termsOpenRetryDue(T0, T0 + TERMS_OPEN_RETRY_GAP_MS - 1)).toBe(false);
    expect(termsOpenRetryDue(T0, T0 + TERMS_OPEN_RETRY_GAP_MS)).toBe(true);
  });

  it('tries at once when nothing was tried, or when the clock was set back past the last try', () => {
    expect(termsOpenRetryDue(null, T0)).toBe(true);
    // Set back an hour: due now, not an hour and five seconds from now.
    expect(termsOpenRetryDue(T0, T0 - 60 * 60 * 1000)).toBe(true);
    expect(termsOpenRetryDue(T0, T0 - 1)).toBe(true);
  });
});
