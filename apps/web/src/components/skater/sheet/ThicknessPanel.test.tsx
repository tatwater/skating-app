import {
  emptySheet,
  inchesToCm,
  type SheetReport,
  sheetReducer,
  THICKNESS_BAND_LABELS,
  THICKNESS_BANDS,
  THICKNESS_METHOD_LABELS,
  type ThicknessReadingInput,
} from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { type ConsoleMode, ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { readingLabel, ThicknessPanel } from './ThicknessPanel';
import type { SheetBody } from './useSheetBody';
import { whereClickOnWater } from './WhereCards';

const NOW = Date.UTC(2026, 0, 10, 20);

const body: SheetBody = {
  waterBodyId: 'wb1',
  name: 'Lake Morey',
  polygon: null,
  silhouette: null,
  frame: null,
  bays: [],
  landmarks: [],
  putIns: [],
  parking: [],
  hazards: [],
  recentCards: [],
  sunAt: () => null,
  timeZone: 'America/New_York',
};

/**
 * Drive the real reducer, so the panel is asserted against the rules and not against a spy — inside
 * the console's mode, so a where question is asserted against the mode the instrument would read.
 */
function renderPanel({ instrument = true }: { instrument?: boolean } = {}) {
  let latest: SheetReport | undefined;
  let ctx: ReturnType<typeof useConsoleMode> | undefined;
  function Probe() {
    ctx = useConsoleMode();
    return null;
  }
  function Wrapper() {
    const [report, setReport] = useState<SheetReport>(() => ({
      id: 'r1',
      idempotencyKey: 'k1',
      sheet: emptySheet(NOW, 'wb1'),
      photos: [],
      keptPhotoIds: [],
      bundleCandidateIds: [],
      unbundledHazardIds: [],
    }));
    latest = report;
    return (
      <ThicknessPanel
        report={report}
        body={body}
        dispatch={(action) => setReport((r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }))}
        setReport={(update) => setReport(update)}
        gaps={new Set()}
        editing={false}
        timeZone="America/New_York"
      />
    );
  }
  render(
    <ConsoleModeProvider instrument={instrument}>
      <Wrapper />
      <Probe />
    </ConsoleModeProvider>,
  );
  const chips = () => latest?.sheet.fields.thickness.chips ?? [];
  const readings = () =>
    chips()
      .filter((c) => c.key.startsWith('reading:'))
      .map((c) => c.value as ThicknessReadingInput);
  const mode = () => ctx?.mode ?? null;
  /** The where mode the instrument would read; fails the test when none is armed. */
  const whereMode = (): Extract<ConsoleMode, { kind: 'where' }> => {
    const m = mode();
    if (m?.kind !== 'where') throw new Error(`expected a where mode, got ${m?.kind ?? 'none'}`);
    return m;
  };
  return {
    chips,
    readings,
    scope: () => latest?.sheet.scalars.thicknessScope,
    mode,
    whereMode,
    /** The instrument's own Done. */
    exit: () => act(() => ctx?.exit()),
  };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const near = (cm: number | undefined, inches: number) =>
  expect(cm).toBeCloseTo(inchesToCm(inches), 5);

describe('ThicknessPanel', () => {
  it('takes a quick band, toggles it off, and asks for a scope only once there is a figure', () => {
    const p = renderPanel();
    const first = THICKNESS_BAND_LABELS[THICKNESS_BANDS[0]];
    expect(screen.queryByRole('button', { name: 'At this spot' })).toBeNull();
    click(first);
    expect(p.chips()).toHaveLength(1);
    click('At this spot');
    expect(p.scope()).toBe('at_spot');
    click('At this spot');
    expect(p.scope()).toBeUndefined();
    click(first);
    expect(p.chips()).toHaveLength(0);
    click("Didn't check");
    expect(p.chips()).toHaveLength(0);
  });

  it('records a measurement in inches, the method, and the skater’s own word', () => {
    const p = renderPanel();
    click('+ A measurement');
    // A fresh editor stores nothing until it has a figure.
    click('Held me');
    expect(p.readings()).toEqual([]);
    type('Thickness in inches', '4.5');
    near(p.readings()[0]?.valueCm, 4.5);
    expect(p.readings()[0]?.supportable).toBe(true);
    click(THICKNESS_METHOD_LABELS.estimated);
    expect(p.readings()[0]?.method).toBe('estimated');
    click('Held me');
    expect(p.readings()[0]?.supportable).toBeUndefined();
    click("Didn't hold");
    expect(p.readings()[0]?.supportable).toBe(false);
  });

  it('takes a range with either end alone, and a poke count with a guess', () => {
    const p = renderPanel();
    click('+ A measurement');
    click('A range');
    type('At least, in inches', '4');
    expect(p.readings()[0]?.valueCm).toBeUndefined();
    near(p.readings()[0]?.minCm, 4);
    expect(p.readings()[0]?.maxCm).toBeUndefined();
    type('At most, in inches', '6');
    near(p.readings()[0]?.maxCm, 6);

    click('Pokes');
    type('Pokes to go through', '3.4');
    expect(p.readings()[0]).toMatchObject({ method: 'poke', pokeCount: 3 });
    type('Your guess, in inches', '3');
    near(p.readings()[0]?.valueCm, 3);
    // Back to a number: a poke reading's method falls back to an estimate.
    click('A number');
    expect(p.readings()[0]?.method).toBe('estimated');
  });

  it('settles one reading and opens the next; Remove drops a stored one and closes a blank one', () => {
    const p = renderPanel();
    click('+ A measurement');
    type('Thickness in inches', '4');
    click('+ A measurement');
    const fields = screen.getAllByLabelText('Thickness in inches');
    expect(fields).toHaveLength(2);
    // The fresh editor is the second one; the first is the stored chip's.
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    expect(p.readings()).toHaveLength(2);

    // A where per reading: the picker opens under the reading's own chip.
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Choose on the lake' })[0] as HTMLElement,
    );
    expect(screen.getByLabelText('Where on the lake')).toBeInTheDocument();

    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[0] as HTMLElement);
    expect(p.readings()).toHaveLength(1);
    click('+ A measurement');
    const blank = screen.getAllByRole('button', { name: 'Remove' }).at(-1) as HTMLElement;
    fireEvent.click(blank);
    expect(p.readings()).toHaveLength(1);
  });

  it('offers a place on the fresh editor, and a place chosen before the first digit rides it', () => {
    const p = renderPanel();
    click('+ A measurement');
    // The state the founder hit: nothing typed yet, and the place is already askable.
    expect(screen.getByText('Where did you measure?')).toBeInTheDocument();
    click('Choose on the lake');
    expect(screen.getByLabelText('Where on the lake')).toBeInTheDocument();
    expect(p.whereMode().label).toBe('New measurement');

    // A sector on the ring, before there is a chip to hold it: nothing is stored yet…
    act(() => p.whereMode().onChange({ sector: 'N' }));
    expect(p.readings()).toEqual([]);
    expect(p.whereMode().where).toEqual({ sector: 'N' });
    // …and the first digit carries it.
    type('Thickness in inches', '4');
    expect(p.readings()[0]?.where).toEqual({ sector: 'N' });
    // The banner names the measurement by its figure once it has one.
    expect(p.whereMode().label).toBe('4″ measurement');

    // A click on the water places the point for this reading, beside the sector.
    const coord = { lat: 43.9, lng: -72.1 };
    act(() => p.whereMode().onChange(whereClickOnWater(p.whereMode().where, coord)));
    expect(p.readings()[0]?.where).toMatchObject({ sector: 'N', point: { coord } });

    // Done closes the question and leaves the mode; the chip names what was picked.
    click('Done');
    expect(p.mode()).toBeNull();
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    expect(screen.getByRole('button', { name: 'North end' })).toBeInTheDocument();
  });

  it('keeps one where question open, moves it between readings, and closes it with its reading', () => {
    const p = renderPanel();
    click('+ A measurement');
    type('Thickness in inches', '4');
    click('+ A measurement');
    fireEvent.change(screen.getAllByLabelText('Thickness in inches')[1] as HTMLElement, {
      target: { value: '5' },
    });

    const choose = () => screen.getAllByRole('button', { name: 'Choose on the lake' });
    fireEvent.click(choose()[0] as HTMLElement);
    expect(p.whereMode().label).toBe('4″ measurement');
    // The second reading's chip moves the question — and the mode — to it.
    expect(choose()).toHaveLength(1);
    fireEvent.click(choose()[0] as HTMLElement);
    expect(screen.getAllByLabelText('Where on the lake')).toHaveLength(1);
    expect(p.whereMode().label).toBe('5″ measurement');
    act(() => p.whereMode().onChange({ sector: 'S' }));
    expect(p.readings().map((r) => r.where)).toEqual([undefined, { sector: 'S' }]);

    // The instrument's Done closes the block that armed it.
    p.exit();
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    expect(p.mode()).toBeNull();

    // Removing a reading with its question open closes the question and the mode.
    fireEvent.click(choose()[0] as HTMLElement);
    expect(p.whereMode().label).toBe('4″ measurement');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(p.readings()).toHaveLength(1);
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    expect(p.mode()).toBeNull();
  });

  it('closes a blank editor’s question with it, and a new measurement starts with no place', () => {
    const p = renderPanel();
    click('+ A measurement');
    click('Choose on the lake');
    act(() => p.whereMode().onChange({ sector: 'E' }));
    click('Remove');
    expect(p.mode()).toBeNull();
    click('+ A measurement');
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    type('Thickness in inches', '3');
    expect(p.readings()[0]?.where).toBeUndefined();
  });

  it('on a phone, arms no mode and says where a point is placed', () => {
    const p = renderPanel({ instrument: false });
    click('+ A measurement');
    click('Choose a place');
    expect(screen.getByLabelText('Where on the lake')).toBeInTheDocument();
    expect(p.mode()).toBeNull();
    expect(
      screen.getByText('A point on the lake is placed on the map, on a wider screen.'),
    ).toBeInTheDocument();
    // The chips still answer without the map.
    click('North end');
    type('Thickness in inches', '2');
    expect(p.readings()[0]?.where).toEqual({ sector: 'N' });
  });

  it('names a place it cannot put in words by what it is', () => {
    const p = renderPanel();
    click('+ A measurement');
    type('Thickness in inches', '4');
    click('Choose on the lake');
    // An unnamed point on the water…
    act(() => p.whereMode().onChange(whereClickOnWater(undefined, { lat: 43.9, lng: -72.1 })));
    click('Done');
    click('A point on the lake');
    // …and a bay this sheet has no name for: a part of the lake, never the whole of it.
    act(() => p.whereMode().onChange({ subAreaId: 'gone' }));
    click('Done');
    expect(screen.getByRole('button', { name: 'Somewhere on the lake' })).toBeInTheDocument();
  });

  it('names a reading by its figure, never by the skater’s word', () => {
    expect(readingLabel({ method: 'measured' })).toBe('New measurement');
    expect(readingLabel({ method: 'measured', valueCm: inchesToCm(4.5), supportable: true })).toBe(
      '4.5″ measurement',
    );
    expect(readingLabel({ method: 'estimated', minCm: inchesToCm(4), maxCm: inchesToCm(6) })).toBe(
      '4–6″ measurement',
    );
    expect(readingLabel({ method: 'estimated', minCm: inchesToCm(4) })).toBe('4″+ measurement');
    expect(readingLabel({ method: 'poke', pokeCount: 3 })).toBe('3 pokes measurement');
  });
});
