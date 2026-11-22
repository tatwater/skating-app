import { describe, expect, it } from 'vitest';

import { ALERT_WORDS } from './flagWords';

/** Board 2.6's *What each does*: a retraction tells the alert's author (the moderator's decision). */
describe('what each lever does on an access alert', () => {
  it('says a retraction tells its author', () => {
    expect(ALERT_WORDS.does.retract).toBe('Gone · no longer true · author told');
  });
});
