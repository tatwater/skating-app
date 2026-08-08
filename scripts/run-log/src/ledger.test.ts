import { describe, expect, it } from 'vitest';
import {
  accepted,
  DropLedger,
  expectAcceptance,
  formatLedger,
  LEDGER_SAMPLE_CAP,
  rejected,
} from './ledger';

/**
 * These tests are written against the incident, not against the API.
 *
 * `normalizeNhdId` was derived from one observed GUID and would have refused 84.4% of NHD's
 * post-floor identifiers — silently, because a body whose id fails to normalize just never gets one.
 * Every test here asks the same question: would this module have made that loud?
 */

/** The real shape of the failure: a rule that only accepts GUIDs, meeting a mostly-numeric archive. */
const guidOnly = (raw: unknown) => {
  const s = String(raw ?? '').trim();
  if (!s) return rejected('absent');
  return /^[0-9a-f]{8}-/i.test(s) ? accepted(s.toLowerCase()) : rejected('malformed');
};

describe('the incident this exists to prevent', () => {
  it('makes a rule that drops five sixths of the corpus FAIL, not warn', () => {
    const ledger = new DropLedger('nhdId');
    // The measured census: 15.6% GUIDs, 84.4% plain numeric.
    for (let i = 0; i < 156; i++)
      ledger.normalize('601f3c2e-2c78-4691-8aec-8735a10d22b5', guidOnly);
    for (let i = 0; i < 844; i++) ledger.normalize('141034078', guidOnly);

    const report = ledger.report();
    expect(report.accepted).toBe(156);
    expect(report.byReason.malformed).toBe(844);
    expect(() => expectAcceptance(report, 0.98)).toThrow(/accepted 156 of 1000/);
  });

  it('puts the offending raw values in the exception, so it is the diagnosis', () => {
    const ledger = new DropLedger('nhdId');
    ledger.normalize('141034078', guidOnly);
    ledger.normalize('118181968', guidOnly);
    expect(() => expectAcceptance(ledger.report(), 0.9)).toThrow(/141034078/);
  });

  it('passes silently when the rule actually fits the data', () => {
    const ledger = new DropLedger('nhdId');
    for (let i = 0; i < 100; i++)
      ledger.normalize('601f3c2e-2c78-4691-8aec-8735a10d22b5', guidOnly);
    expect(() => expectAcceptance(ledger.report(), 0.98)).not.toThrow();
  });
});

describe('reasons are three different facts', () => {
  it('keeps a publisher sentinel out of the malformed bucket', () => {
    // NHD writes gnis_id = -1 on 1,032 post-floor rows to mean "no GNIS entry" — cross-border
    // Québec lakes. That is healthy data, not a broken parser, and must not trip the floor.
    const ledger = new DropLedger('gnisId');
    const rule = (raw: unknown) => {
      const s = String(raw ?? '').trim();
      if (!s) return rejected('absent');
      if (s === '-1') return rejected('sentinel');
      return /^\d+$/.test(s) ? accepted(s.replace(/^0+/, '')) : rejected('malformed');
    };
    for (let i = 0; i < 1032; i++) ledger.normalize('-1', rule);
    for (let i = 0; i < 13_989; i++) ledger.normalize('00869848', rule);

    const report = ledger.report();
    expect(report.byReason.sentinel).toBe(1032);
    expect(report.byReason.malformed).toBe(0);
    expect(report.samples.sentinel).toContain('-1');
    // …and it must not count against the rule. The first version of the floor scored sentinels as
    // parse failures and the very first real audit run failed at 93.1% on healthy data. A floor that
    // cries wolf gets ignored, which is the failure this module exists to prevent.
    expect(() => expectAcceptance(report, 0.98)).not.toThrow();
    expect(() => expectAcceptance(report, 0.98, { countSentinel: true })).toThrow(/sentinel=1032/);
  });

  it('excludes absence from the floor by default — 71.7% of NHD rows have no GNIS id at all', () => {
    const ledger = new DropLedger('gnisId');
    for (let i = 0; i < 717; i++) ledger.normalize('', () => rejected('absent'));
    for (let i = 0; i < 283; i++) ledger.normalize('869848', () => accepted('869848'));

    const report = ledger.report();
    expect(report.acceptanceRate).toBeCloseTo(0.283);
    // Absent excluded: every row that HAD a value parsed fine, so the rule is healthy.
    expect(() => expectAcceptance(report, 0.98)).not.toThrow();
    // …and countAbsent makes absence a failure, for a field that must always be present.
    expect(() => expectAcceptance(report, 0.98, { countAbsent: true })).toThrow();
  });
});

describe('DropLedger bookkeeping', () => {
  it('bounds the sample it keeps, so a run row stays small', () => {
    const ledger = new DropLedger('x');
    for (let i = 0; i < 500; i++) ledger.normalize(`junk-${i}`, () => rejected('malformed'));
    expect(ledger.report().samples.malformed).toHaveLength(LEDGER_SAMPLE_CAP);
    expect(ledger.report().rejected).toBe(500); // the COUNT is not truncated, only the sample
  });

  it('reports an empty input as having dropped nothing', () => {
    // Reporting 0% for "we read no rows" would trip every floor and train people to ignore it.
    const report = new DropLedger('x').report();
    expect(report.acceptanceRate).toBe(1);
    expect(() => expectAcceptance(report, 0.99)).not.toThrow();
  });

  it('flattens into run-row counts, omitting reasons that never fired', () => {
    const ledger = new DropLedger('nhdId');
    ledger.normalize('601f3c2e-2c78-4691-8aec-8735a10d22b5', guidOnly);
    ledger.normalize('141034078', guidOnly);
    const names = ledger.counts_().map((c) => c.name);
    expect(names).toContain('nhdId.seen');
    expect(names).toContain('nhdId.rejected.malformed');
    expect(names).not.toContain('nhdId.rejected.sentinel');
  });

  it('summarises in one line for a log', () => {
    const ledger = new DropLedger('nhdId');
    ledger.normalize('601f3c2e-2c78-4691-8aec-8735a10d22b5', guidOnly);
    ledger.normalize('141034078', guidOnly);
    expect(formatLedger(ledger.report())).toBe('nhdId: 1/2 accepted · rejected 1 malformed');
  });

  it('returns the outcome it was handed, so it can wrap a call site inline', () => {
    const ledger = new DropLedger('x');
    expect(ledger.normalize('869848', () => accepted('869848'))).toEqual({
      ok: true,
      value: '869848',
    });
  });
});
