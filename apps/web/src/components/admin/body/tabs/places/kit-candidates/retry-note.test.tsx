import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RetryNote } from './retry-note';

describe('RetryNote', () => {
  it('says what couldn’t be read, politely, and asks again on Try again', async () => {
    const onRetry = vi.fn();
    render(<RetryNote onRetry={onRetry}>Couldn’t read the asks.</RetryNote>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Couldn’t read the asks.');
    expect(screen.getByRole('note')).toHaveAttribute('data-tone', 'default');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('takes a tone and the caller’s props', () => {
    render(
      <RetryNote onRetry={() => {}} tone="bad" data-slot="mine" className="mt-1">
        Gone
      </RetryNote>,
    );
    expect(screen.getByRole('note')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByRole('status')).toHaveAttribute('data-slot', 'mine');
    expect(screen.getByRole('status').className).toContain('mt-1');
  });
});
