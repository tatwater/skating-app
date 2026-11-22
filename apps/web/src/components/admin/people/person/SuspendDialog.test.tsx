import { AUDIT_REASON_MAX } from '@skating/core';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { SuspendDialog } from './SuspendDialog';

const base = {
  open: true,
  onOpenChange: () => {},
  name: 'Ada Lindqvist',
  extend: false,
  until: null,
  now: Date.UTC(2026, 10, 21, 12),
  timeZone: 'America/New_York',
  onConfirm: vi.fn(async () => 'landed' as const),
};

test('the reason takes the cap it is given — the server’s, as the Inbox passes it', async () => {
  render(<SuspendDialog {...base} maxLength={AUDIT_REASON_MAX} />);
  expect(await screen.findByRole('textbox')).toHaveAttribute('maxlength', String(AUDIT_REASON_MAX));
});

test('without a cap, as People’s own page draws it, there is none', async () => {
  render(<SuspendDialog {...base} />);
  expect(await screen.findByRole('textbox')).not.toHaveAttribute('maxlength');
});
