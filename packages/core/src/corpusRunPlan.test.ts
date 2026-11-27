import { describe, expect, it } from 'vitest';
import {
  CORPUS_HAND_PASSES,
  CORPUS_RUN_KINDS,
  CORPUS_RUN_PLAN,
  CORPUS_SCRIPT_PASSES,
  type CorpusPassName,
  passOfRun,
  planPass,
} from './corpusRunPlan';
import { RUN_QUIET_MS } from './runLiveness';

describe('CORPUS_RUN_PLAN', () => {
  it('holds the script’s passes in order, then the by-hand ones, each with its words', () => {
    expect(CORPUS_RUN_PLAN.map((p) => p.pass)).toEqual([
      ...CORPUS_SCRIPT_PASSES,
      ...CORPUS_HAND_PASSES,
    ]);
    for (const p of CORPUS_RUN_PLAN) {
      expect(p.does.length).toBeGreaterThan(0);
      expect(p.by).toBe(
        (CORPUS_HAND_PASSES as readonly string[]).includes(p.pass) ? 'hand' : 'script',
      );
    }
  });

  it('lists every pass’s kind under Corpus, and gives each a verdict', () => {
    for (const p of CORPUS_RUN_PLAN) {
      expect(CORPUS_RUN_KINDS).toContain(p.kind);
      expect(RUN_QUIET_MS[p.kind]).toBeGreaterThan(0);
    }
    expect(CORPUS_RUN_KINDS).toContain('corpus_campaign');
    expect(RUN_QUIET_MS.corpus_campaign).toBeGreaterThan(0);
  });

  it('finds a pass’s entry by name, and refuses a name it doesn’t know', () => {
    expect(planPass('merge').kind).toBe('corpus_merge');
    expect(() => planPass('nope' as CorpusPassName)).toThrow(/no corpus pass/);
  });
});

describe('passOfRun', () => {
  it('takes the stored pass name when it is one the plan knows', () => {
    expect(
      passOfRun({ kind: 'landmark_seed', label: 'x', campaignPass: 'load-landmark-names' }),
    ).toBe('load-landmark-names');
    expect(passOfRun({ kind: 'landmark_seed', label: 'x', campaignPass: 'bogus' })).toBe(
      'load-landmarks',
    );
  });

  it('names a row from before the pass was stored by its kind', () => {
    for (const p of CORPUS_RUN_PLAN.filter((x) => x.kind !== 'landmark_seed')) {
      expect(passOfRun({ kind: p.kind, label: 'anything' })).toBe(p.pass);
    }
  });

  it('tells the two landmark loads apart by label', () => {
    expect(
      passOfRun({
        kind: 'landmark_seed',
        label: 'Corpus place names no landmark took — the moderator queue (D202)',
      }),
    ).toBe('load-landmark-names');
    expect(
      passOfRun({
        kind: 'landmark_seed',
        label: 'Named landmarks — OSM + GNIS + the corpus (D202)',
      }),
    ).toBe('load-landmarks');
  });

  it('names a legacy retire row (a canonical_water kind) retire-absorbed', () => {
    expect(
      passOfRun({ kind: 'canonical_water', label: 'retire absorbed duplicates (dry run)' }),
    ).toBe('retire-absorbed');
    expect(passOfRun({ kind: 'canonical_water', label: 'VT canonical water' })).toBe('load');
  });

  it('is null for a kind that is no pass', () => {
    for (const kind of ['corpus_campaign', 'dedup_resolve', 'seed_destinations', 'lake_depth']) {
      expect(passOfRun({ kind, label: 'x' })).toBeNull();
    }
  });
});
