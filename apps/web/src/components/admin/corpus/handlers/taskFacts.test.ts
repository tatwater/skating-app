import { describe, expect, it } from 'vitest';

import { bodyNamesPath } from './bodyPath';
import {
  acresText,
  attachedWords,
  neighborsWords,
  queuedWords,
  raisedAgainWords,
} from './taskFacts';

describe('the facts both handlers say', () => {
  it('counts what hangs on the body, a floor where the read stopped, not recorded when it never ran', () => {
    expect(attachedWords({ reports: 3, landmarks: 1, asks: 0, capped: false })).toBe(
      '3 reports · 1 landmark',
    );
    expect(attachedWords({ reports: 1, landmarks: 2, asks: 1, capped: false })).toBe(
      '1 report · 2 landmarks · 1 ask',
    );
    expect(attachedWords({ reports: 0, landmarks: 0, asks: 2, capped: true })).toBe(
      'At least 2 asks',
    );
    expect(attachedWords({ reports: 0, landmarks: 0, asks: 0, capped: false })).toBe(
      'Nothing: no reports, no landmarks, no asks',
    );
    expect(attachedWords({ reports: 0, landmarks: 0, asks: 0, capped: true })).toBe(
      'Not recorded until the next campaign',
    );
  });

  it('names the neighbors, an unnamed one as unnamed water', () => {
    expect(neighborsWords([])).toBe('None on file');
    expect(neighborsWords([{ name: 'Taylor Pond' }, { name: '' }])).toBe(
      'Taylor Pond · Unnamed water',
    );
  });

  it('dates the campaign that queued it, or says none is on file', () => {
    const at = new Date(Date.UTC(2026, 9, 12, 16)).getTime();
    expect(queuedWords({ at }, 'America/New_York')).toBe('By the 12 Oct campaign');
    expect(queuedWords(null)).toBe('Not recorded until the next campaign');
  });

  it('writes acres as the boards do', () => {
    expect(acresText(2263.4)).toBe('2,263');
    expect(acresText(0.3)).toBe('<1');
    expect(acresText(0)).toBe('0');
  });

  it('says who settled it before, someone gone when the profile is', () => {
    const at = new Date(Date.UTC(2026, 8, 4, 16)).getTime();
    expect(
      raisedAgainWords(
        { previous: { at, by: null, decision: 'renamed' } },
        'a catalog’s spelling',
        'America/New_York',
      ),
    ).toBe(
      'Asked again: someone no longer on staff settled it on 4 Sep (renamed), and a catalog’s spelling has changed since.',
    );
    expect(raisedAgainWords(null, 'x')).toBeNull();
  });

  it('opens the body on its Names tab', () => {
    expect(bodyNamesPath('wb 1')).toBe('/admin/body/wb%201?tab=names');
  });
});
