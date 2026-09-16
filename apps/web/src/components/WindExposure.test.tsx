import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WindExposure } from './WindExposure';

/** A rose that leans north-west, with a fetch profile long enough to earn the exposure clause. */
const ROSE = [
  0.2, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
];
const FETCH = Array.from({ length: 16 }, () => 5_000);

describe('WindExposure', () => {
  it('says the rose is the cell’s on a plain body (N9 kickoff call 6)', () => {
    render(<WindExposure body={{ windRose: ROSE, fetchProfileM: FETCH }} />);
    expect(
      screen.getByText('Wind climate is the 2 km grid cell’s, not this water’s own.'),
    ).toBeTruthy();
  });

  it('adds the fetch clause for a bay, whose rose is the parent’s and whose fetch is its own', () => {
    render(<WindExposure body={{ windRose: ROSE, fetchProfileM: FETCH }} scope="subArea" />);
    expect(screen.getByText(/fetch is measured from this bay’s own outline\.$/)).toBeTruthy();
  });

  it('renders nothing without a rose, caption included', () => {
    const { container } = render(<WindExposure body={{ fetchProfileM: FETCH }} />);
    expect(container.innerHTML).toBe('');
  });
});
