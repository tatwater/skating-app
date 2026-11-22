import { describe, expect, it } from 'vitest';

import { BARE_SKATE, OVER_CASPIAN } from '../handlers/Drawn/drawnFixtures';
import type { DrawnItem } from '../handlers/Drawn/drawnModel';
import { skateWords } from './skateWords';

const NY = 'America/New_York';

describe('a recorded skate, in one format', () => {
  it('says the moving time, then when — never the span’s length as the time', () => {
    const skate = OVER_CASPIAN.skate as NonNullable<DrawnItem['skate']>;
    // 96 minutes moving inside a two-hour span.
    expect(skateWords(skate, NY)).toBe('1h 36m · 11 Oct 09:00–11:00');
  });

  it('reads a skate with no end from its start, and no moving time as nothing', () => {
    const bare = BARE_SKATE.skate as NonNullable<DrawnItem['skate']>;
    expect(skateWords(bare, NY)).toBe('11 Oct 09:00');
    expect(skateWords({ ...bare, elapsedSeconds: 0 }, NY)).toBe('11 Oct 09:00');
  });

  it('reads its day in the zone it is given', () => {
    const skate = OVER_CASPIAN.skate as NonNullable<DrawnItem['skate']>;
    expect(skateWords({ ...skate, elapsedSeconds: null, endTime: null }, 'UTC')).toBe(
      '11 Oct 13:00',
    );
  });
});
