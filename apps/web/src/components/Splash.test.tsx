import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./skater/RegionBackdrop', () => ({
  RegionBackdrop: ({ className }: { className?: string }) => (
    <img alt="" data-testid="region" className={className} />
  ),
}));

import { Splash } from './Splash';

describe('Splash', () => {
  it('is the cell loader on the region, without the corner logo', () => {
    render(<Splash />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByTestId('region')).toHaveClass('object-cover');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
