import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { formatClock, NotFoundView, OfflinePlate, OfflineView, SplashView } from './SystemScreens';

const AT = new Date('2027-01-16T14:42:00Z').getTime();
/**
 * The plate's clock reads in the reader's own zone, so its fixture is a local wall time (midday),
 * never a UTC instant: 14:42Z is 18:12 in Tehran and 20:27 in Kathmandu, and a fixed `:42` would
 * fail in every half- and quarter-hour zone.
 */
const LOCAL_MIDDAY = new Date(2027, 0, 16, 12, 42).getTime();
const region = <img alt="" data-testid="region" />;

describe('formatClock', () => {
  it('writes a US clock time', () => {
    expect(formatClock(AT, 'America/New_York')).toBe('9:42 AM');
    expect(formatClock(AT)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('NotFoundView', () => {
  it('shows the address back and goes back to the map, with no logo under the top bar', () => {
    const onBack = vi.fn();
    render(<NotFoundView backdrop={region} address="/water/mascoma-lake-north" onBack={onBack} />);
    expect(screen.getByRole('heading', { name: 'Not on the map' })).toBeInTheDocument();
    expect(screen.getByText('/water/mascoma-lake-north')).toBeInTheDocument();
    expect(screen.queryByAltText('Gli')).toBeNull();
    expect(
      screen.getByText(/U\.S\. Census Bureau · Water: OpenStreetMap contributors/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the map' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('OfflineView', () => {
  it('says a blank map says nothing about the ice, and when it last tried', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <OfflineView backdrop={region} lastTriedAt={null} onRetry={onRetry} />,
    );
    expect(screen.getByText(/says nothing about the ice/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    rerender(<OfflineView backdrop={region} lastTriedAt={AT} onRetry={onRetry} />);
    expect(screen.getByText('Retrying every 30 s')).toBeInTheDocument();
    expect(screen.getAllByAltText('Gli').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('OfflinePlate', () => {
  it('says how old the page is, or that it may be out of date', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<OfflinePlate since={LOCAL_MIDDAY} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('What’s on screen is from 12:42 PM.');
    rerender(<OfflinePlate since={null} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('What’s on screen may be out of date.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('SplashView', () => {
  it('holds on the seven-cell loader, named for a reader', () => {
    render(<SplashView backdrop={region} />);
    const loader = screen.getByRole('progressbar', { name: 'Loading' });
    expect(loader.querySelectorAll('[data-slot="cell"]')).toHaveLength(7);
  });
});
