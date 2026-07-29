import { describe, expect, it } from 'vitest';
import {
  BODY_FEATURE_CAVEAT,
  confirmerClause,
  confirmerSummary,
  confirmRequestPrompt,
  expiredCrossingNote,
  FOOTPRINT_IS_APPROXIMATE,
  freshnessLabel,
  hazardTypeLabel,
  healingNote,
  NO_ALERT_IS_NOT_ALL_CLEAR,
  stalenessCaveat,
  verdictHelp,
  verdictLabel,
  warningHeadline,
} from './hazardCopy';
import type { HazardFreshness } from './hazardDecay';
import type { HazardVerdict } from './hazardLifecycle';
import { HAZARD_TYPES } from './types';

const FRESHNESSES: HazardFreshness[] = ['fresh', 'aging', 'stale'];
const VERDICTS: HazardVerdict[] = ['still_there', 'healing_unsafe', 'fully_healed'];

describe('coverage', () => {
  it('labels every hazard type without falling back to the raw key', () => {
    for (const type of HAZARD_TYPES) {
      const label = hazardTypeLabel(type);
      expect(label.length, type).toBeGreaterThan(0);
      expect(label, type).not.toContain('_');
    }
  });

  it('has a staleness caveat for every type', () => {
    for (const type of HAZARD_TYPES) {
      expect(stalenessCaveat(type).length, type).toBeGreaterThan(20);
    }
  });

  it('labels every verdict for every type', () => {
    for (const type of HAZARD_TYPES) {
      for (const verdict of VERDICTS) {
        expect(verdictLabel(verdict, type).length, `${type}/${verdict}`).toBeGreaterThan(0);
        expect(verdictHelp(verdict, type).length, `${type}/${verdict}`).toBeGreaterThan(0);
      }
    }
  });

  it('preserves the collapsed slash-pair vocabulary in labels', () => {
    expect(hazardTypeLabel('open_water')).toContain('lead');
    expect(hazardTypeLabel('ice_heave')).toContain('buckling');
    expect(hazardTypeLabel('spring_current')).toContain('current');
  });
});

/**
 * The core D3 guard. Descriptive copy — the sentences *we* write about the state of a hazard — must
 * never contain a reassurance. (Verdict button labels are excluded on purpose: "Fully healed & safe" is
 * the *skater's* assertion that they are making, not ours about the ice.)
 */
describe('never asserts safety (D3)', () => {
  const REASSURING = [
    /\bsafe\b/i,
    /\ball[- ]clear\b/i,
    /\bskateable\b/i,
    /\bgone\b/i,
    /\bfine\b/i,
    /\bno longer a hazard\b/i,
  ];

  function assertNoReassurance(text: string, context: string) {
    for (const pattern of REASSURING) {
      expect(pattern.test(text), `${context}: "${text}" matched ${pattern}`).toBe(false);
    }
  }

  it('holds for every freshness label', () => {
    for (const freshness of FRESHNESSES) {
      assertNoReassurance(freshnessLabel(freshness), `freshnessLabel(${freshness})`);
    }
  });

  it('holds for every staleness caveat — including the types that genuinely refreeze', () => {
    for (const type of HAZARD_TYPES) {
      assertNoReassurance(stalenessCaveat(type), `stalenessCaveat(${type})`);
    }
  });

  it('holds for healing notes — "healed" must never read as "safe"', () => {
    for (const type of HAZARD_TYPES) {
      assertNoReassurance(healingNote(type), `healingNote(${type})`);
    }
  });

  it('holds for on-ice prompts and warnings', () => {
    for (const type of HAZARD_TYPES) {
      assertNoReassurance(confirmRequestPrompt(type), `confirmRequestPrompt(${type})`);
      assertNoReassurance(warningHeadline(type, 100), `warningHeadline(${type})`);
    }
  });

  it('holds for the standing caveats', () => {
    assertNoReassurance(FOOTPRINT_IS_APPROXIMATE, 'FOOTPRINT_IS_APPROXIMATE');
    assertNoReassurance(BODY_FEATURE_CAVEAT, 'BODY_FEATURE_CAVEAT');
  });
});

describe('staleness caveats say what the hazard probably became', () => {
  // The single most important sentence in the app: a decayed open-water pin must read as "probably
  // thin ice now", not as "probably gone".
  it('tells the skater a refrozen lead is thin ice', () => {
    expect(stalenessCaveat('open_water')).toMatch(/thin ice/i);
  });

  // Research §5, sign-flip 1 — the "overnight-ice trap" that killed people in 2013.
  it('warns that cold does not fix thawed/rotten ice', () => {
    const caveat = stalenessCaveat('thawed_rotten');
    expect(caveat).toMatch(/cold/i);
    expect(caveat).toMatch(/does not fix|overnight|gives way/i);
  });

  // Research §5, sign-flip 2 — ridges escalate in a thaw rather than quietly persisting.
  it('warns that a warm spell can open a ridge into water', () => {
    expect(stalenessCaveat('pressure_ridge')).toMatch(/warm|open/i);
  });

  it('describes permanent features as permanent, not as old news', () => {
    for (const type of ['spring_current', 'gas_hole', 'reef_hole'] as const) {
      expect(stalenessCaveat(type), type).toMatch(/permanent|every season/i);
    }
  });
});

describe('ridge_crossing relabeling (research §4)', () => {
  it('relabels all three verdicts as passage language', () => {
    expect(verdictLabel('still_there', 'ridge_crossing')).toBe('Still crossable');
    expect(verdictLabel('healing_unsafe', 'ridge_crossing')).toBe('Crossing looks dicey now');
    expect(verdictLabel('fully_healed', 'ridge_crossing')).toBe('Ridge closed / healed');
  });

  it('leaves danger types on the danger labels', () => {
    expect(verdictLabel('still_there', 'open_water')).toBe('Still here');
    expect(verdictLabel('healing_unsafe', 'pressure_ridge')).toBe('Healing — still unsafe');
  });

  it('is the only type that gets relabeled', () => {
    for (const type of HAZARD_TYPES) {
      const relabeled = verdictLabel('still_there', type) !== 'Still here';
      expect(relabeled, type).toBe(type === 'ridge_crossing');
    }
  });

  // The help text has to invert with the label. Its `fully_healed` verdict means "the crossing is
  // gone", so it must NOT fall through to the danger copy ("only if the ice here is genuinely sound"),
  // which on a passage marker would tell someone at a closed crossing to leave the stale marker up.
  it('gives the help text its own passage-marker wording for all three verdicts', () => {
    const danger = new Set([
      verdictHelp('still_there', 'open_water'),
      verdictHelp('healing_unsafe', 'open_water'),
      verdictHelp('fully_healed', 'open_water'),
    ]);
    for (const verdict of VERDICTS) {
      expect(danger.has(verdictHelp(verdict, 'ridge_crossing')), verdict).toBe(false);
    }
  });

  it('help text for retiring a crossing describes it closing, not the ice being sound', () => {
    const help = verdictHelp('fully_healed', 'ridge_crossing');
    expect(help).toMatch(/closed|no longer a way across/i);
    expect(help).not.toMatch(/sound/i);
    expect(help).toMatch(/two|retire/i);
  });
});

describe('the destructive verdict names its consequence', () => {
  // "Fully healed & safe" is the only verdict that retires a pin for everyone, so its help text has to
  // make that cost visible before the tap, not after.
  it('tells the skater that two of these retire the marker', () => {
    expect(verdictHelp('fully_healed', 'open_water')).toMatch(/two|retire/i);
  });

  it('explains that a healing verdict keeps the pin up', () => {
    expect(verdictHelp('healing_unsafe', 'open_water')).toMatch(/stays|next skater/i);
  });
});

describe('healing notes name what a healed hazard becomes', () => {
  it('warns that a healed ridge is refrozen blocks ("ice sharks")', () => {
    expect(healingNote('pressure_ridge')).toMatch(/ice sharks/i);
    expect(healingNote('ice_heave')).toMatch(/ice sharks/i);
  });
});

describe('warningHeadline', () => {
  it('rounds distance to avoid implying GPS precision we do not have', () => {
    expect(warningHeadline('open_water', 117)).toContain('~120 m away');
    expect(warningHeadline('open_water', 94)).toContain('~90 m away');
  });

  it('says "right here" rather than a misleading small number when very close', () => {
    expect(warningHeadline('open_water', 3)).toContain('right here');
  });

  it('names the hazard type', () => {
    expect(warningHeadline('pressure_ridge', 100)).toContain('Pressure ridge');
  });
});

describe('NO_ALERT_IS_NOT_ALL_CLEAR', () => {
  // Non-negotiable (D54 amendment): silence from a foreground-only proximity system is the most
  // dangerous signal the app can emit, so it must be stated wherever alerting is surfaced.
  it('states plainly that silence is not safety', () => {
    expect(NO_ALERT_IS_NOT_ALL_CLEAR).toMatch(/does not mean/i);
    expect(NO_ALERT_IS_NOT_ALL_CLEAR).toMatch(/reported/i);
  });
});

/**
 * D65 — a confirmation from someone you can look up carries weight a bare count doesn't, but it is a
 * sharper disclosure than a report: a named person, at a point, at a time. So the name follows the
 * privacy flag the skater already set, and the count stays honest either way.
 */
describe('confirmerSummary', () => {
  it('names everyone when everyone is public', () => {
    expect(confirmerSummary(['Alex R.', 'Sam K.'], 2)).toBe('Confirmed by Alex R. and Sam K.');
    // No trailing full stop: a display name can end in one, and "Sam K.." looks broken.
  });

  it('counts the private confirmers without naming them', () => {
    expect(confirmerSummary(['Alex R.'], 4)).toBe('Confirmed by Alex R. and 3 others');
  });

  it('says one other, not 1 others', () => {
    expect(confirmerSummary(['Alex R.'], 2)).toBe('Confirmed by Alex R. and 1 other');
  });

  it('falls back to a bare count when nobody is public', () => {
    expect(confirmerSummary([], 3)).toBe('Confirmed by 3 skaters');
    expect(confirmerSummary([], 1)).toBe('Confirmed by 1 skater');
  });

  it('says nothing at all when nobody has confirmed — silence is not an all-clear (D3)', () => {
    expect(confirmerSummary([], 0)).toBeNull();
  });
});

/**
 * The mid-sentence form, and the regression it exists for: both drawers render this inside
 * "reported 3 days ago by Alex · …", and the obvious way to write that is
 * `confirmerSummary(...).toLowerCase()` — which was shipped, and which lowercases the *names*.
 */
describe('confirmerClause', () => {
  it('lowers only the leading word, leaving the names alone', () => {
    expect(confirmerClause(['Alex R.', 'Sam K.'], 2)).toBe('confirmed by Alex R. and Sam K.');
  });

  it('never mangles a name — the whole point of D65 is that the names are readable', () => {
    const clause = confirmerClause(['Alex R.', 'McTavish', 'Ó Briain'], 3);
    expect(clause).toContain('Alex R.');
    expect(clause).toContain('McTavish');
    expect(clause).toContain('Ó Briain');
  });

  it('lowers the count fallback too', () => {
    expect(confirmerClause([], 3)).toBe('confirmed by 3 skaters');
  });

  it('is null exactly when the summary is', () => {
    expect(confirmerClause([], 0)).toBeNull();
  });
});

/**
 * The one pin allowed to leave the map on time alone (D64) needs to say so when a permalink reaches
 * it — and must not overclaim, because *nobody* reported the crossing closed. Silence retired it.
 */
describe('expiredCrossingNote', () => {
  it('says nobody has looked, and explicitly disclaims that the ridge has closed', () => {
    const note = expiredCrossingNote();
    expect(note).toMatch(/nobody has (reported|looked)/i);
    // The distinction the whole D64 inversion rests on: silence retired this pin, not a report.
    expect(note).toMatch(/not a report/i);
  });

  it('tells the skater how to bring it back — a crossing revives on evidence', () => {
    expect(expiredCrossingNote()).toMatch(/comes back/i);
  });
});
