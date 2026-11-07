import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakes, resetFakes, router } from './testMocks';

vi.mock('@tanstack/react-router', () => router);
vi.mock('./RegionBackdrop', () => ({
  RegionBackdrop: ({ className }: { className?: string }) => (
    <img alt="" data-testid="region" className={className} />
  ),
}));

import { NotFoundScreen } from './NotFoundScreen';
import { OfflinePlate, OfflineScreen } from './OfflineScreen';

beforeEach(() => resetFakes());

describe('NotFoundScreen', () => {
  it('shows the path back, runs the region under the top bar, and goes home', () => {
    fakes.location = { pathname: '/water/mascoma-lake-north', searchStr: '?q=private' };
    render(<NotFoundScreen />);
    expect(screen.getByText('/water/mascoma-lake-north')).toBeInTheDocument();
    expect(screen.queryByText(/private/)).toBeNull();
    expect(screen.getByTestId('region').className).toContain('-top-(--size-top)');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the map' }));
    expect(fakes.push).toHaveBeenCalledWith('/');
  });
});

describe('OfflineScreen', () => {
  it('is the first-load screen on the region, and re-exports the plate', () => {
    const onRetry = vi.fn();
    render(<OfflineScreen lastTriedAt={null} onRetry={onRetry} />);
    expect(screen.getByTestId('region')).toHaveClass('object-cover');
    expect(OfflinePlate).toBeTypeOf('function');
  });
});
