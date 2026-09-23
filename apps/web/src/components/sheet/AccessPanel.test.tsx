import {
  emptySheet,
  SHOW_PUT_IN_LABEL,
  type SheetAction,
  type SheetReport,
  sheetReducer,
} from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { AccessPanel } from './AccessPanel';
import { ConsoleModeProvider } from './ConsoleMode';
import type { SheetBody } from './useSheetBody';

const NOW = Date.UTC(2026, 0, 10, 20);
const LAUNCH = { lat: 43.9, lng: -72.15 };

const body: SheetBody = {
  waterBodyId: 'wb1',
  name: 'Lake Morey',
  polygon: null,
  // No silhouette: the map needs a polygon, and the chip rows are what this test is about.
  silhouette: null,
  frame: null,
  bays: [],
  putIns: [{ id: 'put-1', coord: LAUNCH, name: 'State launch', kind: 'putIn' }],
  parking: [{ id: 'lot-1', coord: { lat: 43.9, lng: -72.16 }, name: 'Town lot', kind: 'parking' }],
  hazards: [],
  recentCards: [],
  sunAt: () => null,
  timeZone: 'America/New_York',
};

/** The launches are offered inside the put-in question (A10-6): open it, as the author would. */
function openPutIn() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose on the lake' }));
}

/** Drive the real reducer, so the panel is asserted against the rules and not against a spy. */
function renderPanel(opts: { editing?: boolean } = {}) {
  const dispatched: SheetAction[] = [];
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
      <AccessPanel
        report={report}
        body={body}
        dispatch={(action) => {
          dispatched.push(action);
          setReport((r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }));
        }}
        setReport={(update) => setReport(update)}
        gaps={new Set()}
        editing={opts.editing ?? false}
        timeZone="America/New_York"
      />
    );
  }
  render(
    <ConsoleModeProvider>
      <Wrapper />
    </ConsoleModeProvider>,
  );
  return { dispatched, get: () => latest as SheetReport };
}

describe('the put-in (§7.1 / D198)', () => {
  it('choosing a launch stores its id and its coordinate as the report’s point', () => {
    const { get } = renderPanel();
    openPutIn();
    fireEvent.click(screen.getByRole('button', { name: 'State launch' }));
    expect(get().sheet.scalars.putInId).toBe('put-1');
    // The question closes on *Done* and the answer reads back on the chip that opened it.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'State launch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(get().sheet.scalars.point).toEqual(LAUNCH);
  });

  /**
   * The point *was* the launch's coordinate. Left behind when the launch is un-chosen it reads as
   * *Somewhere else · set* and posts as a nameless proposal for a launch the corpus already has.
   */
  it('Escape closes the question with the mode, so the block never outlives the lit launches', () => {
    renderPanel();
    openPutIn();
    expect(screen.getByText(/The launches are lit on the lake/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(/The launches are lit on the lake/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose on the lake' })).toBeInTheDocument();
  });

  it('un-choosing the launch un-places the pin it placed', () => {
    const { get } = renderPanel();
    openPutIn();
    fireEvent.click(screen.getByRole('button', { name: 'State launch' }));
    fireEvent.click(screen.getByRole('button', { name: 'State launch' }));
    expect(get().sheet.scalars.putInId).toBeUndefined();
    expect(get().sheet.scalars.point).toBeUndefined();
  });
});

describe('the conditions (§7.2 / D197)', () => {
  it('are offered only once a put-in or a lot is chosen', () => {
    renderPanel();
    expect(screen.getByText(/Pick your put-in or lot/)).toBeInTheDocument();
    openPutIn();
    fireEvent.click(screen.getByRole('button', { name: 'State launch' }));
    expect(screen.getByRole('button', { name: 'Plank needed' })).toBeInTheDocument();
  });

  it('the one-line note appears only once a condition is chosen', () => {
    renderPanel();
    openPutIn();
    fireEvent.click(screen.getByRole('button', { name: 'State launch' }));
    expect(screen.queryByLabelText(/what you found at the launch/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Plank needed' }));
    expect(screen.getByLabelText(/what you found at the launch/i)).toBeInTheDocument();
  });

  /**
   * The chips file their alerts as part of a *create* (the flush's step 7). An edit has no such
   * step, so offering them on the edit door would take a plank the author clicked and file nothing.
   */
  it('are not offered on the edit door — they say so instead', () => {
    renderPanel({ editing: true });
    expect(screen.queryByRole('button', { name: 'Plank needed' })).not.toBeInTheDocument();
    expect(screen.getByText(/filed when a report posts/)).toBeInTheDocument();
  });
});

describe('the put-in opt-out (Phase 04 #7)', () => {
  it('reads as shown by default, and toggles off', () => {
    const { get } = renderPanel();
    const toggle = screen.getByRole('button', { name: SHOW_PUT_IN_LABEL });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(get().sheet.scalars.showPutIn).toBe(false);
  });
});

describe('what a desk has no business offering', () => {
  it('has no *use my location* — a browser fix would place the put-in at the author’s desk', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /my location/i })).not.toBeInTheDocument();
  });
});
