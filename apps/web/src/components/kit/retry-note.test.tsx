import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RetryNote } from './retry-note';

describe('RetryNote', () => {
  it('is a live region already in the page, which the failure’s words are put into', () => {
    const { rerender } = render(<RetryNote onRetry={() => {}}>{null}</RetryNote>);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    rerender(<RetryNote onRetry={() => {}}>The history couldn’t be read</RetryNote>);
    // The same element: the region was mounted before its words arrived.
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('The history couldn’t be read');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('runs the read again from Try again, and holds while the fresh answer is on its way', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RetryNote onRetry={onRetry}>Couldn’t read the asks</RetryNote>);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <RetryNote onRetry={onRetry} pending>
        Couldn’t read the asks
      </RetryNote>,
    );
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'pending');
  });

  it('empty, is out of its parent’s flow (no gap of a flex parent), and back in it with words', () => {
    const { rerender } = render(<RetryNote onRetry={() => {}}>{null}</RetryNote>);
    const region = screen.getByRole('status');
    expect(region).toHaveClass('absolute');
    rerender(<RetryNote onRetry={() => {}}>The history couldn’t be read</RetryNote>);
    expect(region).not.toHaveClass('absolute');
  });

  it('draws no button when nothing can retry', () => {
    render(<RetryNote>The archive couldn’t be read</RetryNote>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps focus in the note when the read recovers and the words go', () => {
    const { rerender } = render(<RetryNote onRetry={() => {}}>Couldn’t read the bays</RetryNote>);
    act(() => screen.getByRole('button', { name: 'Try again' }).focus());
    rerender(<RetryNote onRetry={() => {}}>{null}</RetryNote>);
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });
});
