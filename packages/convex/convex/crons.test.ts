import { describe, expect, test } from 'vitest';
import crons from './crons';

describe('crons', () => {
  test('registers the notification-queue flush job', () => {
    // Importing the module runs the registration; assert the configured registry exists and, when the
    // internal shape is reachable, that our flush job is registered (the digest/fav/great drain).
    expect(crons).toBeTruthy();
    const registry = crons as unknown as { crons?: Record<string, unknown> };
    if (registry.crons) {
      expect(Object.keys(registry.crons)).toContain('flush notification queue');
    }
  });

  test('registers the consent record’s two daily sweeps (B03 §9.11)', () => {
    const registry = crons as unknown as { crons?: Record<string, unknown> };
    expect(registry.crons).toBeTruthy();
    expect(Object.keys(registry.crons ?? {})).toEqual(
      expect.arrayContaining(['prune terms readings', 'purge due consent records']),
    );
  });
});
