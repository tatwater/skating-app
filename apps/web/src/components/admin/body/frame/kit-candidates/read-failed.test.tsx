import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReadFailed } from './read-failed';

describe('ReadFailed', () => {
  it('says what couldn’t be read as a note, and runs the read again on Try again', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ReadFailed onRetry={onRetry}>The history couldn’t be read</ReadFailed>);
    expect(screen.getByRole('note')).toHaveTextContent('The history couldn’t be read');
    expect(screen.getByRole('note')).toHaveAttribute('data-tone', 'default');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps its own slot whatever the caller passes, and takes the caller’s other attributes', () => {
    const { container } = render(
      <ReadFailed onRetry={() => {}} data-for="history" className="mt-3">
        x
      </ReadFailed>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-slot', 'read-failed');
    expect(root).toHaveAttribute('data-for', 'history');
    expect(root.className).toContain('mt-3');
  });
});
