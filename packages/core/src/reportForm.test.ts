import { describe, expect, it } from 'vitest';
import {
  buildReportInput,
  emptyReportForm,
  emptyThicknessReading,
  type ReportFormState,
  reportFormFromReport,
  resolveSkateWindow,
  type StoredReportForForm,
  sameThroughFormRounding,
} from './reportForm';
import { cmToInches, cToF, kphToMph } from './units';

describe('emptyThicknessReading', () => {
  it('is a blank single measured reading (the "add reading" default)', () => {
    expect(emptyThicknessReading()).toEqual({
      mode: 'single',
      value: '',
      min: '',
      max: '',
      method: 'measured',
    });
  });
});

describe('emptyReportForm', () => {
  it('defaults skate-end time to now (ms), no start, no ice fields required (D3)', () => {
    const now = Date.UTC(2026, 0, 5, 19, 30);
    const form = emptyReportForm(now);
    expect(form.skateEndTime).toBe(now);
    expect(form.skateStartTime).toBeUndefined();
    expect(form.iceTypes).toEqual([]);
    expect(form.thickness).toEqual([]);
  });
});

const NOW = Date.UTC(2026, 0, 5, 19, 30);
const BASE: ReportFormState = emptyReportForm(NOW);

describe('buildReportInput', () => {
  it('keeps a notes-only report minimal — no empty optional fields (D3)', () => {
    const input = buildReportInput({ ...BASE, notes: '  did not skate  ' }, 'wb1');
    expect(input).toEqual({
      waterBodyId: 'wb1',
      skateEndTime: NOW,
      notes: 'did not skate',
    });
    expect('iceTypes' in input).toBe(false);
    expect('conditions' in input).toBe(false);
  });

  it('converts a single measured thickness reading to metric (D25)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'single', value: '4', min: '', max: '', method: 'measured' }],
      },
      'wb1',
    );
    const reading = input.iceThickness?.readings[0];
    expect(reading?.method).toBe('measured');
    expect(cmToInches(reading?.valueCm ?? 0)).toBeCloseTo(4);
    expect(reading && 'minCm' in reading).toBe(false);
  });

  it('converts a min–max range reading and never emits both value and range (XOR)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '2', max: '4', method: 'estimated' }],
      },
      'wb1',
    );
    const reading = input.iceThickness?.readings[0];
    expect(reading && 'valueCm' in reading).toBe(false);
    expect(cmToInches(reading?.minCm ?? 0)).toBeCloseTo(2);
    expect(cmToInches(reading?.maxCm ?? 0)).toBeCloseTo(4);
  });

  it('drops empty readings so an untouched reading row doesn’t break validation', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [
          { mode: 'single', value: '', min: '', max: '', method: 'measured' },
          { mode: 'single', value: '3', min: '', max: '', method: 'measured' },
        ],
      },
      'wb1',
    );
    expect(input.iceThickness?.readings).toHaveLength(1);
  });

  it('assembles manual conditions in metric with source=user, omitting blank fields', () => {
    const input = buildReportInput(
      {
        ...BASE,
        conditions: { airTempF: '32', windMph: '10', windDir: 'NW', sky: 'overcast', precip: '' },
      },
      'wb1',
    );
    expect(input.conditions?.source).toBe('user');
    expect(cToF(input.conditions?.airTempC ?? 0)).toBeCloseTo(32);
    expect(kphToMph(input.conditions?.windSpeedKph ?? 0)).toBeCloseTo(10);
    expect(input.conditions?.windDir).toBe('NW');
    expect(input.conditions?.sky).toBe('overcast');
    expect(input.conditions && 'precip' in input.conditions).toBe(false);
  });

  it('drops non-numeric numeric inputs (e.g. a stray snow-cover value)', () => {
    const input = buildReportInput({ ...BASE, snowCover: 'lots' }, 'wb1');
    expect('snowCoverCm' in input).toBe(false);
  });

  it('supports a one-sided thickness range (max only)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '', max: '5', method: 'measured' }],
      },
      'wb1',
    );
    const reading = input.iceThickness?.readings[0];
    expect(reading && 'minCm' in reading).toBe(false);
    expect(cmToInches(reading?.maxCm ?? 0)).toBeCloseTo(5);
  });

  it('drops an empty range reading (neither min nor max entered)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '', max: '', method: 'measured' }],
      },
      'wb1',
    );
    expect('iceThickness' in input).toBe(false);
  });

  it('supports a one-sided thickness range (min only) and a precip-only condition', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '3', max: '', method: 'measured' }],
        conditions: { airTempF: '', windMph: '', windDir: '', sky: '', precip: 'snow' },
      },
      'wb1',
    );
    const reading = input.iceThickness?.readings[0];
    expect(reading && 'minCm' in reading).toBe(true);
    expect(reading && 'maxCm' in reading).toBe(false);
    expect(input.conditions).toEqual({ precip: 'snow', source: 'user' });
  });

  it('includes ice types, surface tags, quality, snow cover, and a put-in point when present', () => {
    const input = buildReportInput(
      {
        ...BASE,
        iceTypes: ['black_ice'],
        surfaceTags: ['glass', 'orange_peel'],
        skateQuality: 'great',
        snowCover: '1.5',
      },
      'wb1',
      { lat: 44.4, lng: -73.2 },
    );
    expect(input.iceTypes).toEqual(['black_ice']);
    expect(input.surfaceTags).toEqual(['glass', 'orange_peel']);
    expect(input.skateQuality).toBe('great');
    expect(cmToInches(input.snowCoverCm ?? 0)).toBeCloseTo(1.5);
    expect(input.point).toEqual({ lat: 44.4, lng: -73.2 });
  });

  it('carries an optional skate start time when the form holds one (Phase 5)', () => {
    const start = NOW - 90 * 60 * 1000;
    const input = buildReportInput({ ...BASE, skateStartTime: start }, 'wb1');
    expect(input.skateStartTime).toBe(start);
    expect(input.skateEndTime).toBe(NOW);
  });

  it('omits skateStartTime entirely when the form has none', () => {
    const input = buildReportInput(BASE, 'wb1');
    expect('skateStartTime' in input).toBe(false);
  });
});

describe('resolveSkateWindow', () => {
  const END = Date.UTC(2026, 0, 5, 16, 0);

  it('yields just the end when neither a start nor a duration is given', () => {
    expect(resolveSkateWindow({ end: END })).toEqual({ ok: true, skateEndTime: END });
  });

  it('passes an explicit start through', () => {
    const start = END - 60 * 60 * 1000;
    expect(resolveSkateWindow({ end: END, start })).toEqual({
      ok: true,
      skateEndTime: END,
      skateStartTime: start,
    });
  });

  it('back-computes the start from a duration (never stores the duration)', () => {
    const result = resolveSkateWindow({ end: END, durationMinutes: 90 });
    expect(result).toEqual({ ok: true, skateEndTime: END, skateStartTime: END - 90 * 60_000 });
  });

  it('prefers an explicit start over a supplied duration', () => {
    const start = END - 30 * 60_000;
    const result = resolveSkateWindow({ end: END, start, durationMinutes: 90 });
    expect(result).toEqual({ ok: true, skateEndTime: END, skateStartTime: start });
  });

  it('rejects an invalid end', () => {
    expect(resolveSkateWindow({ end: 0 }).ok).toBe(false);
    expect(resolveSkateWindow({ end: Number.NaN }).ok).toBe(false);
  });

  it('rejects a start after the end', () => {
    const result = resolveSkateWindow({ end: END, start: END + 60_000 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive or non-finite duration', () => {
    expect(resolveSkateWindow({ end: END, durationMinutes: 0 }).ok).toBe(false);
    expect(resolveSkateWindow({ end: END, durationMinutes: -10 }).ok).toBe(false);
    expect(resolveSkateWindow({ end: END, durationMinutes: Number.NaN }).ok).toBe(false);
  });

  it('rejects a duration longer than the end instant itself', () => {
    const result = resolveSkateWindow({ end: 30 * 60_000, durationMinutes: 60 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive explicit start', () => {
    expect(resolveSkateWindow({ end: END, start: 0 }).ok).toBe(false);
    expect(resolveSkateWindow({ end: END, start: -5 }).ok).toBe(false);
  });
});

/**
 * The edit path's load-bearing property (N6f).
 *
 * `reports.update` is last-write-wins over the whole content block, so a form seeded with anything
 * less than the stored report **deletes** whatever the author didn't retype. That makes
 * `buildReportInput(reportFormFromReport(r))` ≡ `r` the actual contract, not a nicety.
 */
describe('reportFormFromReport', () => {
  const SKATE_END = Date.UTC(2026, 0, 15, 20, 0, 0);

  /** A report using every field the form can edit, so the round trip has something to lose. */
  const FULL: StoredReportForForm = {
    skateEndTime: SKATE_END,
    skateStartTime: SKATE_END - 90 * 60_000,
    iceTypes: ['black_ice'],
    surfaceTags: ['glass'],
    skateQuality: 'great',
    iceThickness: {
      readings: [
        { valueCm: 12.7, method: 'measured' }, // 5.0 in
        { minCm: 10.16, maxCm: 15.24, method: 'estimated' }, // 4.0–6.0 in
      ],
    },
    snowCoverCm: 2.54, // 1.0 in
    conditions: {
      airTempC: -10,
      windSpeedKph: 16.09344,
      windDir: 'NW',
      sky: 'clear',
      precip: 'none',
    },
    notes: 'Glassy all the way to the north end.',
  };

  it('round-trips a fully populated report through the form and back', () => {
    const rebuilt = buildReportInput(reportFormFromReport(FULL), 'wb1');
    expect(rebuilt.skateEndTime).toBe(FULL.skateEndTime);
    expect(rebuilt.skateStartTime).toBe(FULL.skateStartTime);
    expect(rebuilt.iceTypes).toEqual(FULL.iceTypes);
    expect(rebuilt.surfaceTags).toEqual(FULL.surfaceTags);
    expect(rebuilt.skateQuality).toBe(FULL.skateQuality);
    expect(rebuilt.notes).toBe(FULL.notes);
    // Imperial round trip, to the tenth of an inch the form displays.
    expect(rebuilt.snowCoverCm).toBeCloseTo(FULL.snowCoverCm as number, 2);
    expect(rebuilt.conditions?.airTempC).toBeCloseTo(-10, 1);
    expect(rebuilt.conditions?.windSpeedKph).toBeCloseTo(16.09, 1);
    expect(rebuilt.conditions?.windDir).toBe('NW');
    expect(rebuilt.conditions?.sky).toBe('clear');
    expect(rebuilt.conditions?.precip).toBe('none');
  });

  it('keeps each reading in the mode it was measured in', () => {
    const form = reportFormFromReport(FULL);
    expect(form.thickness[0]).toMatchObject({ mode: 'single', value: '5', method: 'measured' });
    expect(form.thickness[1]).toMatchObject({
      mode: 'range',
      min: '4',
      max: '6',
      method: 'estimated',
    });

    const rebuilt = buildReportInput(form, 'wb1');
    expect(rebuilt.iceThickness?.readings[0]).toMatchObject({ method: 'measured' });
    expect(rebuilt.iceThickness?.readings[0]?.valueCm).toBeCloseTo(12.7, 2);
    expect(rebuilt.iceThickness?.readings[1]?.minCm).toBeCloseTo(10.16, 2);
    expect(rebuilt.iceThickness?.readings[1]?.maxCm).toBeCloseTo(15.24, 2);
  });

  /**
   * A range reading with only one end filled has no `valueCm`, so it must stay a range — collapsing
   * it to `single` would move an open-ended "at least 4 inches" into a precise claim.
   */
  it('keeps a half-filled range a range', () => {
    const form = reportFormFromReport({
      skateEndTime: SKATE_END,
      iceThickness: { readings: [{ minCm: 10.16, method: 'estimated' }] },
    });
    expect(form.thickness[0]).toMatchObject({ mode: 'range', min: '4', max: '' });
    expect(buildReportInput(form, 'wb1').iceThickness?.readings[0]).not.toHaveProperty('maxCm');
  });

  it('seeds a bare observation-only report without inventing fields', () => {
    const form = reportFormFromReport({ skateEndTime: SKATE_END, notes: 'Just looked at it.' });
    expect(form).toMatchObject({
      skateEndTime: SKATE_END,
      iceTypes: [],
      surfaceTags: [],
      skateQuality: '',
      thickness: [],
      snowCover: '',
      notes: 'Just looked at it.',
    });
    const rebuilt = buildReportInput(form, 'wb1');
    expect(rebuilt).not.toHaveProperty('skateQuality');
    expect(rebuilt).not.toHaveProperty('iceThickness');
    expect(rebuilt).not.toHaveProperty('conditions');
  });

  it('does not carry conditions provenance — the server decides that', () => {
    // The form has no slot for `source` and no way to render it; round-tripping it here would mean
    // inventing a hidden field. `reports.update` preserves the stored source when values are unchanged.
    const form = reportFormFromReport(FULL);
    expect(form.conditions).not.toHaveProperty('source');
  });

  /**
   * The weather pair is the round trip's one lossy step, and the values that expose it are exactly
   * the ones production stores: `FULL` above uses −10 °C (14 °F) and 16.09344 kph (10.0 mph), both
   * whole imperial units, so they survive an exact comparison and hide the problem. Open-Meteo has no
   * reason to return either.
   */
  describe('a modelled reading that does not land on a whole imperial unit', () => {
    /** −3.4 °C → 25.88 °F → the field shows 26 → back to −3.33 °C. Off by a rounding step, untouched. */
    const MODELLED: StoredReportForForm = {
      skateEndTime: SKATE_END,
      conditions: { airTempC: -3.4, windSpeedKph: 18.7 },
    };

    it('does not survive an exact comparison — which is why the server cannot use one', () => {
      const rebuilt = buildReportInput(reportFormFromReport(MODELLED), 'wb1');
      expect(rebuilt.conditions?.airTempC).not.toBe(-3.4);
      expect(rebuilt.conditions?.windSpeedKph).not.toBe(18.7);
      expect(rebuilt.conditions?.airTempC).toBeCloseTo(-3.4, 0);
    });

    it('is recognised as unedited at the precision the field actually offers', () => {
      const rebuilt = buildReportInput(reportFormFromReport(MODELLED), 'wb1');
      expect(sameThroughFormRounding('airTempC', -3.4, rebuilt.conditions?.airTempC)).toBe(true);
      expect(sameThroughFormRounding('windSpeedKph', 18.7, rebuilt.conditions?.windSpeedKph)).toBe(
        true,
      );
    });
  });

  describe('sameThroughFormRounding', () => {
    it('is true for two readings that render as the same whole unit', () => {
      // −3.4 °C and −3.33 °C both show as 26 °F: the form could not tell them apart, so neither can
      // an author have meant to change one into the other.
      expect(sameThroughFormRounding('airTempC', -3.4, -3.3333333333333335)).toBe(true);
    });

    it('is true when the field is absent on both sides', () => {
      expect(sameThroughFormRounding('airTempC', undefined, undefined)).toBe(true);
    });

    it('is false when the field was cleared or added', () => {
      expect(sameThroughFormRounding('airTempC', -3.4, undefined)).toBe(false);
      expect(sameThroughFormRounding('airTempC', undefined, -3.4)).toBe(false);
    });

    /** The tolerance cannot mask a real edit: retyping the field moves it a whole unit at least. */
    it('is false for a value the author actually retyped', () => {
      expect(sameThroughFormRounding('airTempC', -3.4, -3.888888888888889)).toBe(false); // 26 °F → 25 °F
      expect(sameThroughFormRounding('windSpeedKph', 18.7, 20.3)).toBe(false); // 12 mph → 13 mph
    });
  });

  it('rounds to a stable display value, so a no-op edit does not perturb the number', () => {
    const once = reportFormFromReport(FULL);
    const twice = reportFormFromReport({
      ...FULL,
      ...(buildReportInput(once, 'wb1').snowCoverCm !== undefined
        ? { snowCoverCm: buildReportInput(once, 'wb1').snowCoverCm }
        : {}),
    });
    expect(twice.snowCover).toBe(once.snowCover);
  });
});
