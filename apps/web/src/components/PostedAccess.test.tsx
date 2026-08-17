import type { PostedAccess as PostedAccessRule } from '@skating/core';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostedAccess, PostedAccessLine } from './PostedAccess';

/** Tomhannock Reservoir, Rensselaer County NY — the rule this feature was built from. */
const TOMHANNOCK: PostedAccessRule = {
  dateRange: { startMonth: 1, startDay: 1, endMonth: 3, endDay: 15 },
  dailyWindow: { kind: 'daylight', offsetMinutes: 0 },
  permitRequired: true,
  note: 'NYSDEC; access permit from the City of Troy',
};

const COORD = { lat: 42.8462, lng: -73.5501 };

/** 2026-01-15 13:00 ET — inside the season and comfortably between sunrise and sunset. */
const MIDWINTER_MIDDAY = Date.parse('2026-01-15T18:00:00Z');
/** 2026-01-15 20:00 ET — inside the season, after sunset. */
const MIDWINTER_NIGHT = Date.parse('2026-01-16T01:00:00Z');
/** 2025-10-05 — outside the posted season entirely. */
const OCTOBER = Date.parse('2025-10-05T18:00:00Z');

function freeze(atMs: number) {
  vi.useFakeTimers();
  vi.setSystemTime(atMs);
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PostedAccess', () => {
  it('renders both lines — the rule, and what it means now', () => {
    freeze(MIDWINTER_MIDDAY);
    render(<PostedAccess rule={TOMHANNOCK} coord={COORD} />);

    // The durable, checkable fact.
    expect(
      screen.getByText('January 1 – March 15 · sunrise to sunset · permit required'),
    ).toBeInTheDocument();
    // Its consequence at one instant.
    expect(screen.getByText(/^Open now · until /)).toBeInTheDocument();
    expect(screen.getByText('NYSDEC; access permit from the City of Troy')).toBeInTheDocument();
  });

  it('says closed after sunset, and still shows the rule', () => {
    freeze(MIDWINTER_NIGHT);
    render(<PostedAccess rule={TOMHANNOCK} coord={COORD} />);

    expect(screen.getByText(/^Closed now · opens \d+:\d\d AM$/)).toBeInTheDocument();
    // The rule does not disappear when it happens to be shut — you plan tomorrow against it.
    expect(
      screen.getByText('January 1 – March 15 · sunrise to sunset · permit required'),
    ).toBeInTheDocument();
  });

  it('answers out-of-season with a date rather than a time', () => {
    freeze(OCTOBER);
    render(<PostedAccess rule={TOMHANNOCK} coord={COORD} />);
    expect(screen.getByText('Closed now · opens January 1')).toBeInTheDocument();
  });

  it('renders nothing at all when a body has no posted rule', () => {
    const { container } = render(<PostedAccess coord={COORD} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the absence under the reveal flag', () => {
    render(<PostedAccess coord={COORD} reveal />);
    expect(screen.getByText(/No posted rules recorded/)).toBeInTheDocument();
  });

  it('renders the rule without a coordinate, minus the live state', () => {
    // A body with no interiorPoint and no centroid still has a rule worth reading.
    render(<PostedAccess rule={TOMHANNOCK} />);
    expect(
      screen.getByText('January 1 – March 15 · sunrise to sunset · permit required'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/now ·/)).not.toBeInTheDocument();
  });
});

describe('PostedAccessLine', () => {
  it('renders a lot rule on one line', () => {
    freeze(MIDWINTER_MIDDAY);
    render(
      <PostedAccessLine
        rule={{ dailyWindow: { kind: 'clock', openMinute: 17 * 60, closeMinute: 9 * 60 } }}
        coord={COORD}
      />,
    );
    expect(screen.getByText(/5:00 PM to 9:00 AM/)).toBeInTheDocument();
  });

  it('renders nothing without a rule, so an unrestricted launch stays quiet', () => {
    const { container } = render(<PostedAccessLine coord={COORD} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('omits the note, which belongs on the body’s strip', () => {
    freeze(MIDWINTER_MIDDAY);
    render(<PostedAccessLine rule={TOMHANNOCK} coord={COORD} />);
    expect(screen.queryByText(/City of Troy/)).not.toBeInTheDocument();
  });
});
