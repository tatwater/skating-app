import type { SheetReport } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BOARD_NOW_NH } from '@/test/boardNow';
import type { SheetBody } from '../sheet/useSheetBody';
import { PhoneInstrumentStrip, whenLine } from './PhoneInstrumentStrip';

const NH = 'America/New_York';
// Saturday 16 January 2027, 11:52 AM in New Hampshire — the boards' "today".
const NOW = BOARD_NOW_NH;
const at = (h: number, m: number) => Date.UTC(2027, 0, 16, h + 5, m);

/** A Report with just what the strip reads: the end time's selected value and the start. */
function report(end?: number, start?: number, bodyName?: string): SheetReport {
  return {
    id: 'r1',
    ...(bodyName ? { bodyName } : {}),
    photos: [],
    sheet: {
      scalars: start !== undefined ? { skateStartTime: start } : {},
      selections:
        end !== undefined ? { endTime: { chosen: { ms: end, precision: 'minute' } } } : {},
    },
  } as unknown as SheetReport;
}

vi.mock('@skating/core', async (load) => {
  const core = await load<typeof import('@skating/core')>();
  return {
    ...core,
    reportEndMs: (r: SheetReport) =>
      (r.sheet as unknown as { selections: { endTime?: { chosen: { ms: number } } } }).selections
        .endTime?.chosen.ms,
  };
});

describe('whenLine', () => {
  it('says the span, dropping a shared AM/PM from its start', () => {
    expect(whenLine(report(at(11, 30), at(9, 30)), NH, NOW)).toMatch(/^Today · 9:30–11:30\sAM$/);
  });

  it('keeps both periods across noon, and a lone end on its own', () => {
    expect(whenLine(report(at(13, 0), at(11, 0)), NH, NOW)).toMatch(/11:00\sAM–1:00\sPM$/);
    expect(whenLine(report(at(11, 52)), NH, NOW)).toMatch(/^Today · 11:52\sAM$/);
  });

  it('says so when no time is set yet', () => {
    expect(whenLine(report(), NH, NOW)).toBe('When: not set yet');
  });
});

describe('PhoneInstrumentStrip', () => {
  const body = {
    name: 'Mascoma Lake',
    timeZone: NH,
    silhouette: { bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }, rings: [] },
  } as unknown as SheetBody;

  it('names the lake and the day, and Change asks first', () => {
    const onChange = vi.fn();
    render(
      <PhoneInstrumentStrip
        report={report(at(11, 52))}
        body={body}
        inert={false}
        onChange={onChange}
        now={NOW}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalled();
  });

  it('without a body yet: the Report’s own name, no Change, dimmed while posting', () => {
    render(
      <PhoneInstrumentStrip
        report={report(undefined, undefined, 'Crystal Lake')}
        body={null}
        inert
      />,
    );
    expect(screen.getByRole('heading', { name: 'Crystal Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.getByRole('region', { name: 'The lake and the day' }).className).toContain(
      'opacity-50',
    );
  });

  it('falls back to "This lake"', () => {
    render(<PhoneInstrumentStrip report={report()} body={null} inert={false} />);
    expect(screen.getByRole('heading', { name: 'This lake' })).toBeInTheDocument();
  });
});
