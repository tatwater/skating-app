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
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ThicknessPanel } from './ThicknessPanel';
import type { SheetBody } from './useSheetBody';

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

/** Drive the real reducer, so the panel is asserted against the rules and not against a spy. */
function renderPanel() {
  let latest: SheetReport | undefined;
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
  render(<Wrapper />);
  const chips = () => latest?.sheet.fields.thickness.chips ?? [];
  const readings = () =>
    chips()
      .filter((c) => c.key.startsWith('reading:'))
      .map((c) => c.value as ThicknessReadingInput);
  return { chips, readings, scope: () => latest?.sheet.scalars.thicknessScope };
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

    // A where per reading: the picker opens under the chip's own Where?.
    expect(screen.queryByLabelText('Where on the lake')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Where?' })[0] as HTMLElement);
    expect(screen.getByLabelText('Where on the lake')).toBeInTheDocument();

    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[0] as HTMLElement);
    expect(p.readings()).toHaveLength(1);
    click('+ A measurement');
    const blank = screen.getAllByRole('button', { name: 'Remove' }).at(-1) as HTMLElement;
    fireEvent.click(blank);
    expect(p.readings()).toHaveLength(1);
  });
});
