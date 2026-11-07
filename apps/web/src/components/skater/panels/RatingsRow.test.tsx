import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

vi.mock('convex/react', () => convexReact);

import { RatingsRow, RatingsRowView, writeError } from './RatingsRow';

beforeEach(resetFakes);

describe('RatingsRowView', () => {
  it('shows the helpful count, never an unhelpful one, and marks your own thumb', () => {
    render(<RatingsRowView helpful={6} mine="helpful" canRate onRate={vi.fn()} />);
    const helpful = screen.getByRole('button', { name: 'Helpful, 6' });
    expect(helpful).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Not helpful' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByText(/unhelpful/i)).toBeNull();
  });

  it('casts on a press, and is inert for the author, while loading, or mid-write', async () => {
    const onRate = vi.fn();
    const { rerender } = render(<RatingsRowView helpful={0} mine={null} canRate onRate={onRate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(onRate).toHaveBeenCalledWith('unhelpful');
    rerender(<RatingsRowView helpful={0} mine={null} canRate={false} onRate={onRate} />);
    expect(screen.getByRole('button', { name: 'Helpful, 0' })).toBeDisabled();
    rerender(<RatingsRowView helpful={0} mine={null} canRate loading onRate={onRate} />);
    expect(screen.getByRole('button', { name: 'Helpful, 0' })).toBeDisabled();
  });

  it('drops the words when compact, and Not helpful when asked', () => {
    render(
      <RatingsRowView
        helpful={4}
        mine={null}
        canRate
        compact
        withUnhelpful={false}
        onRate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Helpful, 4' })).not.toHaveTextContent('Helpful');
    expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();
  });

  it('says when a thumb didn’t land', () => {
    render(<RatingsRowView helpful={1} mine={null} canRate error="Not saved." onRate={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved.');
  });
});

describe('RatingsRow', () => {
  it('reads the summary and casts through ratings.rate, threading the bounty', async () => {
    fakes.queries.set('ratings:summaryForTarget', { helpful: 3, unhelpful: 1, mine: null });
    render(<RatingsRow targetType="report" targetId="r1" canRate bountyId="b1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpful, 3' }));
    expect(fakes.mutations.get('ratings:rate')).toHaveBeenCalledWith({
      targetType: 'report',
      targetId: 'r1',
      verdict: 'helpful',
      bountyId: 'b1',
    });
  });

  it('shows the server’s refusal', async () => {
    fakes.queries.set('ratings:summaryForTarget', { helpful: 0, unhelpful: 0, mine: null });
    fakes.mutations.set(
      'ratings:rate',
      vi.fn().mockRejectedValue(new ConvexError('You can’t rate your own')),
    );
    render(<RatingsRow targetType="hazard" targetId="h1" canRate compact withUnhelpful />);
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('You can’t rate your own');
  });

  it('holds its place while the counts load', () => {
    render(<RatingsRow targetType="report" targetId="r1" canRate />);
    expect(screen.getByRole('button', { name: 'Helpful, 0' })).toBeDisabled();
  });
});

describe('writeError', () => {
  it('prefers the server’s words', () => {
    expect(writeError(new ConvexError('Bounty is not open'), 'fallback')).toBe(
      'Bounty is not open',
    );
    expect(writeError(new Error('network'), 'fallback')).toBe('fallback');
  });
});
