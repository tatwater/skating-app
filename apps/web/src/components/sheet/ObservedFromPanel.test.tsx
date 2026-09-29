import {
  emptySheet,
  type SheetAction,
  type SheetReport,
  SIGHTING_FROM_ICE_MESSAGE,
  selectedValues,
  sheetReducer,
  toReportInput,
  validateReportInput,
} from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ConsoleModeProvider } from './ConsoleMode';
import { ObservedFromPanel } from './ReportPanels';

const NOW = Date.UTC(2026, 0, 10, 20);

/** Drive the real reducer, so the panel is asserted against the rules and not against a spy. */
function renderPanel(pre: SheetAction[] = []) {
  let latest: SheetReport | undefined;
  function Wrapper() {
    const [report, setReport] = useState<SheetReport>(() => ({
      id: 'r1',
      idempotencyKey: 'k1',
      sheet: pre.reduce(sheetReducer, emptySheet(NOW, 'wb1')),
      photos: [],
      keptPhotoIds: [],
      bundleCandidateIds: [],
      unbundledHazardIds: [],
    }));
    latest = report;
    return (
      <ObservedFromPanel
        report={report}
        body={null}
        dispatch={(action) => setReport((r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }))}
        setReport={(update) => setReport(update)}
        gaps={new Set()}
        editing={false}
        timeZone="America/New_York"
      />
    );
  }
  render(
    <ConsoleModeProvider>
      <Wrapper />
    </ConsoleModeProvider>,
  );
  return () => latest as SheetReport;
}

const post = (report: SheetReport) =>
  validateReportInput(
    { ...toReportInput(report.sheet), skateEndTime: NOW - 3_600_000, skateQuality: 'good' },
    { now: NOW },
  );

describe('What did you see? — located sightings (D210)', () => {
  it('from the ice: asks for the part not skated, opens the where at once, and posts once it has one', () => {
    const get = renderPanel();
    expect(screen.getByText('What did you see but not skate?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Still open/ }));
    // The one chip tap that opens the where question: from the ice a sighting needs a place.
    expect(screen.getByText('Where was it still open?')).toBeInTheDocument();
    expect(screen.getByText(`Say where — ${SIGHTING_FROM_ICE_MESSAGE}.`)).toBeInTheDocument();
    expect(post(get()).ok).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'South end' }));
    expect(selectedValues(get().sheet, 'sightings')).toEqual([
      { type: 'open', where: { sector: 'S' } },
    ]);
    expect(screen.queryByText(`Say where — ${SIGHTING_FROM_ICE_MESSAGE}.`)).not.toBeInTheDocument();
    const result = post(get());
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.normalized.sightings).toEqual([{ type: 'open', where: { sector: 'S' } }]);
  });

  it('from shore: any sighting, no where asked for', () => {
    const get = renderPanel([
      { type: 'select', field: 'observedFrom', key: 'shore', value: 'shore' },
    ]);
    expect(screen.getByText('What did you see?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Frozen over/ }));
    expect(screen.queryByText('Where was it frozen over?')).not.toBeInTheDocument();
    expect(post(get()).ok).toBe(true);
  });
});
