import { describe, expect, it } from 'vitest';
import {
  buildReportInput,
  emptyReportForm,
  emptyThicknessReading,
  FORM_THICKNESS_METHODS,
  formCreateRefusal,
  isFormRoundTripOf,
  type ReportFormState,
  reportFormFromReport,
  resolveSkateWindow,
  type StoredReportForForm,
  type ThicknessFormReading,
} from './reportForm';
import { cmToInches, cToF, fToC, inchesToCm, kphToMph } from './units';

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

  it('shows the put-in unless the remembered default says otherwise', () => {
    expect(emptyReportForm(NOW).showPutIn).toBe(true);
    expect(emptyReportForm(NOW, { showPutIn: true }).showPutIn).toBe(true);
    expect(emptyReportForm(NOW, { showPutIn: false }).showPutIn).toBe(false);
  });
});

const NOW = Date.UTC(2026, 0, 5, 19, 30);
const BASE: ReportFormState = emptyReportForm(NOW);

describe('buildReportInput', () => {
  it('sends the put-in opt-out only when it is off — shown is the stored default', () => {
    expect(buildReportInput({ ...BASE, showPutIn: true }, 'wb1')).not.toHaveProperty('showPutIn');
    expect(buildReportInput({ ...BASE, showPutIn: false }, 'wb1').showPutIn).toBe(false);
    // A draft persisted before the switch existed carries no `showPutIn` at all; it must read as shown.
    const legacy = { ...BASE } as Partial<ReportFormState> as ReportFormState;
    delete (legacy as { showPutIn?: boolean }).showPutIn;
    expect(buildReportInput(legacy, 'wb1')).not.toHaveProperty('showPutIn');
  });

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
    expect('snow' in input).toBe(false);
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
    expect(cmToInches(input.snow?.depthCm ?? 0)).toBeCloseTo(1.5);
    expect(input.point).toEqual({ lat: 44.4, lng: -73.2 });
  });

  it('carries an optional skate start time when the form holds one (Phase 05)', () => {
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

  it('rejects a start at the end — a zero-minute skate', () => {
    expect(resolveSkateWindow({ end: END, start: END })).toEqual({
      ok: false,
      error: 'The start must be before the end.',
    });
    expect(resolveSkateWindow({ end: END, start: END - 60_000 }).ok).toBe(true);
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
 * The edit path's load-bearing property (A06f).
 *
 * `reports.update` is last-write-wins over the whole content block, so a form seeded with anything
 * less than the stored report **deletes** whatever the author didn't retype. That makes
 * `buildReportInput(reportFormFromReport(r))` ≡ `r` the actual contract, not a nicety.
 */
describe('reportFormFromReport', () => {
  const SKATE_END = Date.UTC(2026, 0, 15, 20, 0, 0);

  /** A report using every field the form can edit, in the shapes a stored row has, so the round trip has something to lose. */
  const FULL: StoredReportForForm = {
    skateEndTime: SKATE_END,
    skateStartTime: SKATE_END - 90 * 60_000,
    iceTypes: [{ type: 'black_ice' }],
    surfaceTags: [{ type: 'glass' }],
    skateQuality: 'great',
    iceThickness: {
      readings: [
        { valueCm: 12.7, method: 'measured' }, // 5.0 in
        { minCm: 10.16, maxCm: 15.24, method: 'estimated' }, // 4.0–6.0 in
      ],
    },
    snow: { depthCm: 2.54 }, // 1.0 in
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
    expect(rebuilt.snow?.depthCm).toBeCloseTo(FULL.snow?.depthCm as number, 2);
    expect(rebuilt.conditions?.airTempC).toBeCloseTo(-10, 1);
    expect(rebuilt.conditions?.windSpeedKph).toBeCloseTo(16.09, 1);
    expect(rebuilt.conditions?.windDir).toBe('NW');
    expect(rebuilt.conditions?.sky).toBe('clear');
    expect(rebuilt.conditions?.precip).toBe('none');
  });

  it('carries the stored put-in through an edit, and drops it under a new pin (A10 §7.1)', () => {
    // `reports.update` is last-write-wins over `putInId`: a form with no picker for it must send it
    // back, or a typo fix on the web silently unlinks the launch the sheet chose.
    const form = reportFormFromReport({ ...FULL, putInId: 'put-in-1' });
    expect(buildReportInput(form, 'wb1').putInId).toBe('put-in-1');
    // A new pin is "somewhere else": the point is its own, the launch is not named.
    expect(buildReportInput(form, 'wb1', { lat: 44, lng: -72 })).not.toHaveProperty('putInId');
    expect(buildReportInput(reportFormFromReport(FULL), 'wb1')).not.toHaveProperty('putInId');
  });

  it('seeds the put-in switch from the stored report, defaulting to shown', () => {
    expect(reportFormFromReport(FULL).showPutIn).toBe(true);
    expect(reportFormFromReport({ ...FULL, showPutIn: true }).showPutIn).toBe(true);
    const hidden = reportFormFromReport({ ...FULL, showPutIn: false });
    expect(hidden.showPutIn).toBe(false);
    expect(buildReportInput(hidden, 'wb1').showPutIn).toBe(false);
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
  describe('a modeled reading that does not land on a whole imperial unit', () => {
    /** −3.4 °C → 25.88 °F → the field shows 26 → back to −3.33 °C. Off by a rounding step, untouched. */
    const MODELED: StoredReportForForm = {
      skateEndTime: SKATE_END,
      conditions: { airTempC: -3.4, windSpeedKph: 18.7 },
    };

    it('does not survive an exact comparison — which is why the server cannot use one', () => {
      const rebuilt = buildReportInput(reportFormFromReport(MODELED), 'wb1');
      expect(rebuilt.conditions?.airTempC).not.toBe(-3.4);
      expect(rebuilt.conditions?.windSpeedKph).not.toBe(18.7);
      expect(rebuilt.conditions?.airTempC).toBeCloseTo(-3.4, 0);
    });

    it('is recognized as untouched, because the round trip is predicted exactly', () => {
      const rebuilt = buildReportInput(reportFormFromReport(MODELED), 'wb1');
      expect(isFormRoundTripOf('airTempC', -3.4, rebuilt.conditions?.airTempC)).toBe(true);
      expect(isFormRoundTripOf('windSpeedKph', 18.7, rebuilt.conditions?.windSpeedKph)).toBe(true);
    });
  });

  describe('isFormRoundTripOf', () => {
    it('is true for the value the form would have re-emitted', () => {
      // −3.4 °C displays as 26 °F, and 26 °F converts back to −3.33: the exact number an untouched
      // field arrives as, so it is the one number that counts as "the author left this alone".
      expect(isFormRoundTripOf('airTempC', -3.4, fToC(26))).toBe(true);
    });

    it('is true when the field is absent on both sides', () => {
      expect(isFormRoundTripOf('airTempC', undefined, undefined)).toBe(true);
    });

    it('is false when the field was cleared or added', () => {
      expect(isFormRoundTripOf('airTempC', -3.4, undefined)).toBe(false);
      expect(isFormRoundTripOf('airTempC', undefined, -3.4)).toBe(false);
    });

    it('is false for a value the author actually retyped', () => {
      expect(isFormRoundTripOf('airTempC', -3.4, -3.888888888888889)).toBe(false); // 26 °F → 25 °F
      expect(isFormRoundTripOf('windSpeedKph', 18.7, 20.3)).toBe(false); // 12 mph → 13 mph
    });

    /**
     * ⚠ The reason this predicts the round trip instead of allowing a whole-unit tolerance: both
     * inputs take decimals, so a tolerance would read 26.4 °F typed over a modeled 26 °F as
     * unchanged and restore the model's number — discarding an edit to protect provenance, which is
     * a worse failure than the one the check exists to prevent.
     */
    it('is false for a fractional edit inside the displayed unit', () => {
      const typed = buildReportInput(
        { ...BASE, conditions: { ...BASE.conditions, airTempF: '26.4', windMph: '11.6' } },
        'wb1',
      );
      expect(isFormRoundTripOf('airTempC', -3.4, typed.conditions?.airTempC)).toBe(false);
      expect(isFormRoundTripOf('windSpeedKph', 18.7, typed.conditions?.windSpeedKph)).toBe(false);
    });
  });

  it('rounds to a stable display value, so a no-op edit does not perturb the number', () => {
    const once = reportFormFromReport(FULL);
    const twice = reportFormFromReport({
      ...FULL,
      ...(buildReportInput(once, 'wb1').snow !== undefined
        ? { snow: buildReportInput(once, 'wb1').snow }
        : {}),
    });
    expect(twice.snowCover).toBe(once.snowCover);
  });

  /**
   * The A10 fields this form has no control for (Greptile P1 on PR #71). The sheet writes a chip's
   * `where`, the snow facets, a vantage, a suitability, a precision — and the same last-write-wins
   * rule that made `reportFormFromReport` necessary would have this form delete every one of them
   * on an edit to the notes. They ride through `carried`.
   */
  describe('the fields the form cannot edit (A10)', () => {
    const LOCATED: StoredReportForForm = {
      skateEndTime: SKATE_END,
      skateEndPrecision: 'minute',
      observedFrom: 'shore',
      sighting: 'frozen',
      suitability: 'experienced_only',
      iceTypes: [
        { type: 'black_ice', where: { sector: 'N' }, note: 'past the point' },
        { type: 'black_ice', where: { sector: 'S' } },
        { type: 'snow_ice' },
      ],
      surfaceTags: [{ type: 'glass', note: 'until noon' }],
      iceThickness: {
        scope: 'at_spot',
        readings: [
          { method: 'poke', pokeCount: 2, supportable: true, note: 'by the launch' },
          { valueCm: 12.7, method: 'measured', where: { extent: 'mostly' } },
        ],
      },
      snow: {
        coverage: 'patches',
        impediment: 'slowed_me',
        drifts: 'none',
        plowedPath: true,
        depthCm: 2.54,
      },
      notes: 'Two ends, two kinds of black ice.',
    };

    it('shows one key per chip type and sends every stored chip back under it', () => {
      const form = reportFormFromReport(LOCATED);
      expect(form.iceTypes).toEqual(['black_ice', 'snow_ice']);
      const rebuilt = buildReportInput(form, 'wb1');
      expect(rebuilt.iceTypes).toEqual(LOCATED.iceTypes);
      expect(rebuilt.surfaceTags).toEqual(LOCATED.surfaceTags);
    });

    it('drops the stored chips of a key the author deselects, and adds a bare key for a new one', () => {
      const form = reportFormFromReport(LOCATED);
      const rebuilt = buildReportInput({ ...form, iceTypes: ['snow_ice', 'white_ice'] }, 'wb1');
      expect(rebuilt.iceTypes).toEqual([{ type: 'snow_ice' }, 'white_ice']);
    });

    it('sends the vantage, sighting, suitability and precision back as they were', () => {
      const rebuilt = buildReportInput(reportFormFromReport(LOCATED), 'wb1');
      expect(rebuilt).toMatchObject({
        skateEndPrecision: 'minute',
        observedFrom: 'shore',
        sighting: 'frozen',
        suitability: 'experienced_only',
      });
    });

    it('drops the precision when the end time it described has changed', () => {
      const form = reportFormFromReport(LOCATED);
      const rebuilt = buildReportInput({ ...form, skateEndTime: SKATE_END + 60_000 }, 'wb1');
      expect(rebuilt).not.toHaveProperty('skateEndPrecision');
      expect(rebuilt.observedFrom).toBe('shore');
    });

    it('joins the depth typed here to the stored snow facets, and keeps the facets when the depth is cleared', () => {
      const form = reportFormFromReport(LOCATED);
      expect(form.snowCover).toBe('1');
      expect(buildReportInput(form, 'wb1').snow).toEqual(LOCATED.snow);
      expect(buildReportInput({ ...form, snowCover: '' }, 'wb1').snow).toEqual({
        coverage: 'patches',
        impediment: 'slowed_me',
        drifts: 'none',
        plowedPath: true,
      });
    });

    it('keeps a poke reading alive without an inch figure, with its facets, and the scope', () => {
      const form = reportFormFromReport(LOCATED);
      expect(form.thickness[0]).toMatchObject({
        mode: 'range',
        min: '',
        max: '',
        method: 'poke',
        carried: { pokeCount: 2, supportable: true, note: 'by the launch' },
      });
      const rebuilt = buildReportInput(form, 'wb1');
      expect(rebuilt.iceThickness?.scope).toBe('at_spot');
      expect(rebuilt.iceThickness?.readings[0]).toEqual({
        method: 'poke',
        pokeCount: 2,
        supportable: true,
        note: 'by the launch',
      });
      expect(rebuilt.iceThickness?.readings[1]).toMatchObject({
        method: 'measured',
        where: { extent: 'mostly' },
      });
      expect(rebuilt.iceThickness?.readings[1]?.valueCm).toBeCloseTo(12.7, 2);
    });

    it('drops the count when the author changes a poke reading to a measurement', () => {
      const form = reportFormFromReport(LOCATED);
      const [poke, ...rest] = form.thickness as [ThicknessFormReading, ...ThicknessFormReading[]];
      const rebuilt = buildReportInput(
        {
          ...form,
          thickness: [{ ...poke, mode: 'single', method: 'measured', value: '3' }, ...rest],
        },
        'wb1',
      );
      expect(rebuilt.iceThickness?.readings[0]).not.toHaveProperty('pokeCount');
      expect(rebuilt.iceThickness?.readings[0]).toMatchObject({
        method: 'measured',
        supportable: true,
      });
    });

    it('does not offer the poke method: this form has no count field for it', () => {
      expect(FORM_THICKNESS_METHODS).toEqual(['measured', 'estimated']);
    });

    it('carries nothing on a fresh form, so a create sends only what was typed', () => {
      expect(emptyReportForm(NOW).carried).toBeUndefined();
      const input = buildReportInput({ ...BASE, iceTypes: ['black_ice'], snowCover: '1' }, 'wb1');
      expect(input.iceTypes).toEqual(['black_ice']);
      expect(input.snow).toEqual({ depthCm: inchesToCm(1) });
      expect(input).not.toHaveProperty('observedFrom');
    });
  });
});

describe('formCreateRefusal — the create-only rules as the pre-sheet forms ask them (A10-2)', () => {
  const now = Date.UTC(2026, 1, 1, 12);
  const base = { waterBodyId: 'wb', skateEndTime: now - 3_600_000 };
  it('says what to add, in the server’s words', () => {
    expect(formCreateRefusal({ ...base }, 0, now)).toBe(
      'Before this can post, add how it was and one thing you saw — an ice or surface chip, a thickness, or a hazard.',
    );
    expect(formCreateRefusal({ ...base, skateQuality: 'good' }, 0, now)).toBe(
      'Before this can post, add one thing you saw — an ice or surface chip, a thickness, or a hazard.',
    );
    expect(formCreateRefusal({ ...base, iceTypes: [{ type: 'black_ice' }] }, 0, now)).toBe(
      'Before this can post, add how it was.',
    );
  });
  it('a hazard is an observation; a week-old end time is refused first', () => {
    expect(formCreateRefusal({ ...base, suitability: 'dont_go' }, 1, now)).toBeNull();
    expect(
      formCreateRefusal(
        { ...base, skateEndTime: now - 8 * 24 * 3_600_000, skateQuality: 'good' },
        1,
        now,
      ),
    ).toBe('Reports can be posted up to a week after you got off the ice.');
    expect(formCreateRefusal({ ...base, skateEndTime: now + 2 * 3_600_000 }, 1, now)).toBe(
      'That end time is in the future.',
    );
  });
});
