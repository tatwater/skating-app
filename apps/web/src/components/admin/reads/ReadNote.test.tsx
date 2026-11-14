import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReadNote } from './ReadNote';

describe('ReadNote', () => {
  const failed = (pending = false) => ({ failed: true as const, pending, retry: vi.fn() });

  it('stays mounted and empty while its reads stand, and speaks when one fails', () => {
    const { rerender } = render(
      <ReadNote reads={[undefined, { ok: 1 }]}>The bays couldn’t be read</ReadNote>,
    );
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    const a = failed();
    rerender(<ReadNote reads={[a, { ok: 1 }]}>The bays couldn’t be read</ReadNote>);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('The bays couldn’t be read');
  });

  it('tries every failed read again, and is pending only while every one is', async () => {
    const a = failed();
    const b = failed(true);
    const { rerender } = render(<ReadNote reads={[a, b]}>Couldn’t read</ReadNote>);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(a.retry).toHaveBeenCalledTimes(1);
    expect(b.retry).toHaveBeenCalledTimes(1);
    rerender(<ReadNote reads={[failed(true), failed(true)]}>Couldn’t read</ReadNote>);
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeInTheDocument();
  });
});
