import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AerialCredit } from './AerialCredit';

const CREDIT = 'Aerial · NAIP Jun 2023';
const words = () => screen.getByRole('status');

describe('the summer aerial’s credit', () => {
  it('in: the credit as it was, nothing to press', () => {
    render(<AerialCredit credit={CREDIT} state={{ load: 'loaded' }} />);
    expect(words()).toHaveTextContent(CREDIT);
    expect(words()).toHaveAttribute('data-state', 'loaded');
    expect(words()).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('loading: says so, still, with nothing to press', () => {
    render(<AerialCredit credit={CREDIT} state={{ load: 'loading' }} />);
    expect(words()).toHaveTextContent(`${CREDIT} · Loading…`);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed: Try again, described by the credit, runs the retry', async () => {
    const onRetry = vi.fn();
    render(<AerialCredit credit={CREDIT} state={{ load: 'failed', onRetry }} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toHaveAccessibleDescription(`${CREDIT} · Didn’t load`);
    await userEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('pending: Trying again…, focusable, and pressing it again does nothing', async () => {
    const onRetry = vi.fn();
    render(<AerialCredit credit={CREDIT} state={{ load: 'loading', onRetry, pending: true }} />);
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('when the photograph recovers and the button goes, focus stays on the credit', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AerialCredit credit={CREDIT} state={{ load: 'partial', onRetry }} />,
    );
    act(() => screen.getByRole('button').focus());
    rerender(<AerialCredit credit={CREDIT} state={{ load: 'loaded' }} />);
    expect(words()).toHaveFocus();
  });

  it('keeps focus on the credit where the browser blurs the button as it goes (Chromium)', () => {
    const { rerender } = render(
      <AerialCredit credit={CREDIT} state={{ load: 'partial', onRetry: vi.fn() }} />,
    );
    const button = screen.getByRole('button');
    act(() => button.focus());
    // Chromium's order, which jsdom doesn't make: a blur on the node that still holds focus, as
    // it is removed. Focus read from a blur would be lost here (`AerialCredit.stories` is the
    // real browser's proof).
    fireEvent.blur(button);
    fireEvent.focusOut(button);
    rerender(<AerialCredit credit={CREDIT} state={{ load: 'loaded' }} />);
    expect(words()).toHaveFocus();
  });

  it('a button that goes without focus on it leaves focus where it was', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">elsewhere</button>
        <AerialCredit credit={CREDIT} state={{ load: 'failed', onRetry }} />
      </>,
    );
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    act(() => screen.getByRole('button', { name: 'Try again' }).focus());
    act(() => elsewhere.focus());
    rerender(
      <>
        <button type="button">elsewhere</button>
        <AerialCredit credit={CREDIT} state={{ load: 'loaded' }} />
      </>,
    );
    expect(elsewhere).toHaveFocus();
  });
});
