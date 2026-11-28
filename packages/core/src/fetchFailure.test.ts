/**
 * PLACEHOLDER (B01-8c-1 seams): pins the vocabulary and the stub's shape. The chain's builder
 * replaces the stub's test with the rule's, and its `fast-check` properties.
 */

import { describe, expect, test } from 'vitest';
import { CRON_CAUSE_SAMPLE_MAX, CRON_FAILURE_CAUSES, fetchFailureCause } from './fetchFailure';

describe('the failure causes', () => {
  test('the nine causes, in the design’s order', () => {
    expect(CRON_FAILURE_CAUSES).toEqual([
      'timeout',
      'rateLimit',
      'serverError',
      'refused',
      'unreachable',
      'badAnswer',
      'emptyAnswer',
      'writeFailed',
      'other',
    ]);
    expect(CRON_CAUSE_SAMPLE_MAX).toBe(300);
  });

  test('the stub answers a cause from the vocabulary', () => {
    expect(CRON_FAILURE_CAUSES).toContain(fetchFailureCause({ status: 429 }));
  });
});
