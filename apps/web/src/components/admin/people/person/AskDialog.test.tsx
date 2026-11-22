import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { AskDialog } from './AskDialog';

const base = {
  open: true,
  onOpenChange: () => {},
  title: 'Hide this report?',
  description: 'Closes every open flag on it.',
  confirm: 'Hide',
  reason: true,
  onConfirm: vi.fn(async () => 'landed' as const),
};

test('the reason takes the cap it is given — the server’s', async () => {
  render(<AskDialog {...base} maxLength={2000} />);
  expect(await screen.findByRole('textbox')).toHaveAttribute('maxlength', '2000');
});

test('without a cap, as People’s callers draw it, there is none', async () => {
  render(<AskDialog {...base} />);
  expect(await screen.findByRole('textbox')).not.toHaveAttribute('maxlength');
});
