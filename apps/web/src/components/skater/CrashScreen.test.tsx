import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./RegionBackdrop', () => ({
  RegionBackdrop: ({ className }: { className?: string }) => (
    <img alt="" data-testid="region" className={className} />
  ),
}));

import { CrashScreen } from './CrashScreen';

describe('CrashScreen', () => {
  it('draws the board copy over the region and wires both buttons', () => {
    const onRetry = vi.fn();
    const onReload = vi.fn();
    render(<CrashScreen onRetry={onRetry} onReload={onReload} />);
    expect(screen.getByRole('heading', { name: 'Something broke' })).toBeInTheDocument();
    expect(screen.getByTestId('region')).toHaveClass('object-cover');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
  });
});
