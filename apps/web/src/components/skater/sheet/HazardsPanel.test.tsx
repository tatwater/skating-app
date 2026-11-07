import { emptySheet, NO_KNOWN_HAZARDS, type SheetReport, sheetReducer } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convexReact, fakes, resetFakes } from '../testMocks';
import type { SheetBody, SheetHazard } from './useSheetBody';

vi.mock('convex/react', () => convexReact);
vi.mock('@/components/HazardBundlePrompt', () => ({
  HazardBundlePrompt: () => <p>bundle prompt</p>,
}));
vi.mock('./sheetSlots', () => ({
  ReportHazardButton: () => <button type="button">Mark one here</button>,
}));

const { HazardsPanel } = await import('./HazardsPanel');

const NOW = Date.UTC(2026, 0, 10, 20);

function hazard(id: string, type: string, lat: number, createdByUserId?: string): SheetHazard {
  return {
    id,
    type: type as SheetHazard['type'],
    shape: { geometryKind: 'point', geometry: { type: 'Point', coordinates: [-72.15, lat] } },
    bbox: { minLat: lat, maxLat: lat, minLng: -72.15, maxLng: -72.15 },
    label: type,
    ...(createdByUserId !== undefined ? { createdByUserId } : {}),
  } as unknown as SheetHazard;
}

function bodyWith(hazards: SheetHazard[]): SheetBody {
  return {
    waterBodyId: 'wb1',
    name: 'Lake Morey',
    polygon: null,
    silhouette: null,
    frame: null,
    bays: [],
    landmarks: [],
    putIns: [{ id: 'put-1', coord: { lat: 43.9, lng: -72.15 }, name: 'Launch', kind: 'putIn' }],
    parking: [],
    hazards,
    recentCards: [],
    sunAt: () => null,
    timeZone: 'America/New_York',
  };
}

function renderPanel(body: SheetBody | null, opts: { editing?: boolean } = {}) {
  let latest: SheetReport | undefined;
  function Wrapper() {
    const [report, setReport] = useState<SheetReport>(() => {
      const sheet = emptySheet(NOW, 'wb1');
      return {
        id: 'r1',
        idempotencyKey: 'k1',
        sheet: { ...sheet, scalars: { ...sheet.scalars, putInId: 'put-1' } },
        photos: [],
        keptPhotoIds: [],
        bundleCandidateIds: [],
        unbundledHazardIds: [],
      };
    });
    latest = report;
    return (
      <HazardsPanel
        report={report}
        body={body}
        dispatch={(action) => setReport((r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }))}
        setReport={(update) => setReport(update)}
        gaps={new Set()}
        editing={opts.editing ?? false}
        timeZone="America/New_York"
      />
    );
  }
  render(<Wrapper />);
  return { verdicts: () => latest?.sheet.scalars.passedVerdicts ?? {} };
}

beforeEach(() => {
  resetFakes();
  fakes.queries.set('profiles:current', { _id: 'me' });
});

describe('HazardsPanel', () => {
  it('says what an empty list means and does not mean — never an all-clear (D3)', () => {
    renderPanel(bodyWith([]));
    expect(screen.getByText(NO_KNOWN_HAZARDS)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/all clear|no open hazards/i);
  });

  it('asks about others’ hazards nearest the put-in first, never the author’s own', () => {
    renderPanel(
      bodyWith([
        hazard('far', 'thin_ice', 43.99),
        hazard('mine', 'open_water', 43.9, 'me'),
        hazard('near', 'pressure_ridge', 43.901),
      ]),
    );
    expect(screen.getByText('Did you see any of these?')).toBeInTheDocument();
    const rows = [...document.querySelectorAll('p.font-semibold')].map((p) => p.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/ridge/i);
    expect(rows[1]).toMatch(/thin/i);
    // The bundle prompt waits for an end time; the hand-off to mark one doesn't.
    expect(screen.queryByText('bundle prompt')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark one here' })).toBeInTheDocument();
  });

  it('files the answer the skater gives, and only that', () => {
    const p = renderPanel(bodyWith([hazard('h1', 'thin_ice', 43.901)]));
    expect(p.verdicts()).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: 'Healing, not safe' }));
    expect(p.verdicts()).toEqual({ h1: 'healing_unsafe' });
  });

  it('names a crossing marker’s “still there” as a crossing', () => {
    renderPanel(bodyWith([hazard('x1', 'ridge_crossing', 43.901)]));
    expect(screen.getByRole('button', { name: 'Crossed here' })).toBeInTheDocument();
  });

  it('waits for the viewer before offering anything, and an edit drops the hand-offs', () => {
    fakes.queries.set('profiles:current', undefined);
    renderPanel(bodyWith([hazard('h1', 'thin_ice', 43.901)]), { editing: true });
    expect(screen.queryByText('Did you see any of these?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark one here' })).toBeNull();
  });
});
