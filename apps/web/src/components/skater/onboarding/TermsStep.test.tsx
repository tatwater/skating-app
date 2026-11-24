import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

import { TermsStep } from './TermsStep';

beforeAll(() => {
  // Base UI waits on an element's animations before it unmounts; jsdom has none to wait on.
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [] });
  }
  Element.prototype.scrollTo ??= () => {};
});

function step(read: boolean, resetKey = 0) {
  return (
    <TermsStep
      step={null}
      read={read}
      armed={false}
      busy={false}
      resetKey={resetKey}
      email={null}
      onEnd={() => {}}
      onRecord={() => {}}
      onSignOut={() => {}}
    />
  );
}

describe('the agreement box', () => {
  it('is cleared when the reading is re-locked, and stays clear when it unlocks again', async () => {
    const user = userEvent.setup();
    const { rerender } = render(step(true));
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    // `terms_not_read`: the end is re-armed and the box locks.
    rerender(step(false));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    // The end is recorded again: the box unlocks, unticked — the skater ticks it again.
    rerender(step(true));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Record acceptance' })).toBeDisabled();
  });

  it('is cleared when the reading starts again from the top', async () => {
    const user = userEvent.setup();
    const { rerender } = render(step(true, 0));
    await user.click(screen.getByRole('checkbox'));
    rerender(step(true, 1));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('keeps a tick while the reading stands', async () => {
    const user = userEvent.setup();
    const { rerender } = render(step(true));
    await user.click(screen.getByRole('checkbox'));
    rerender(step(true));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Record acceptance' })).toBeEnabled();
  });
});
