import { describe, expect, it } from 'vitest';

import { SPECTACLE_RULING } from '../handlers/Request/requestFixtures';
import { rulingEvent } from './rulingEvent';

describe('a standing ruling as one timeline event', () => {
  it('is the same event for an Access item and a contest, its source trimmed (blank is none)', () => {
    expect(rulingEvent(SPECTACLE_RULING)).toEqual({
      kind: 'ruling',
      key: 'ruling',
      at: SPECTACLE_RULING.ruledAt,
      verdict: 'none',
      by: SPECTACLE_RULING.by,
      note: 'Posted private by the landowner.',
      reason: 'The landowner wrote in; the only access is across their field.',
    });
    expect(rulingEvent({ ...SPECTACLE_RULING, reason: '   ' }).reason).toBeNull();
    expect(rulingEvent({ ...SPECTACLE_RULING, reason: null }).reason).toBeNull();
  });
});
