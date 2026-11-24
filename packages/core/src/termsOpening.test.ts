import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleTermsWaitingLine,
  TERMS_OPEN_RETRY_GAP_MS,
  TERMS_WAITING_LINE_MS,
  termsOpenRetryDue,
} from './termsOpening';

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

describe('scheduleTermsWaitingLine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the line once a wait has lasted three seconds, not before', () => {
    vi.useFakeTimers();
    const show = vi.fn();
    scheduleTermsWaitingLine(true, show);
    expect(TERMS_WAITING_LINE_MS).toBe(3_000);
    vi.advanceTimersByTime(TERMS_WAITING_LINE_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });

  it('never shows it for a wait cancelled first, or when nothing waits', () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const cancel = scheduleTermsWaitingLine(true, show);
    vi.advanceTimersByTime(TERMS_WAITING_LINE_MS - 1);
    cancel();
    scheduleTermsWaitingLine(false, show)();
    vi.advanceTimersByTime(TERMS_WAITING_LINE_MS * 2);
    expect(show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
