import { describe, expect, it } from 'vitest';
import {
  floorPruneScope,
  landmarkLoadScope,
  landmarkMatchScope,
  mergeScope,
  RETIRE_ABSORBED_SCOPE,
  stateCodes,
} from './runScopes';

const FIVE = ['me', 'nh', 'vt', 'ma', 'ny'];

describe('run scopes (D218)', () => {
  it('stores states as sorted, upper-case, distinct codes, so two runs over the same states agree', () => {
    expect(stateCodes(['vt', 'ME', 'vt'])).toEqual(['ME', 'VT']);
  });

  it('a merge of every catalog is a complete full re-import; one missing a catalog is not', () => {
    expect(mergeScope(FIVE, [])).toEqual({
      pass: 'full-canonical',
      states: ['MA', 'ME', 'NH', 'NY', 'VT'],
      complete: true,
    });
    expect(mergeScope(FIVE, ['3dhp']).complete).toBe(false);
  });

  it('a landmark match is complete only over every state the corpus covers', () => {
    expect(landmarkMatchScope(FIVE, FIVE)).toEqual({
      pass: 'derived',
      states: ['MA', 'ME', 'NH', 'NY', 'VT'],
      complete: true,
    });
    expect(landmarkMatchScope(['VT', 'nh'], FIVE)).toEqual({
      pass: 'derived',
      states: ['NH', 'VT'],
      complete: false,
    });
  });

  it("a landmark load carries its match's states, and is never whole on a summary that doesn't say", () => {
    expect(landmarkLoadScope({ states: ['vt'], complete: false })).toEqual({
      pass: 'enrichment',
      states: ['VT'],
      complete: false,
    });
    expect(landmarkLoadScope({ states: FIVE, complete: true }).complete).toBe(true);
    expect(landmarkLoadScope({})).toEqual({ pass: 'enrichment', complete: false });
    expect(landmarkLoadScope(undefined)).toEqual({ pass: 'enrichment', complete: false });
  });

  it('a resumed floor prune is partial — it walked only what the killed run had not', () => {
    expect(floorPruneScope(false)).toEqual({ pass: 'cleanup', complete: true });
    expect(floorPruneScope(true)).toEqual({ pass: 'cleanup', complete: false });
  });

  it('the retirement is a cleanup over every absorbed pair, not by state', () => {
    expect(RETIRE_ABSORBED_SCOPE).toEqual({ pass: 'cleanup', complete: true });
  });
});
