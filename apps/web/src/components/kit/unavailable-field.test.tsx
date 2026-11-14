import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { stubJsdomAnimations } from '@/components/admin/body/tabs/jsdomStubs';
import { Input } from '@/components/kit/input';
import { UnavailableField } from './unavailable-field';

beforeAll(stubJsdomAnimations);

describe('UnavailableField', () => {
  it('is reachable, says it is unavailable, and keeps the field inside inert', () => {
    render(
      <UnavailableField what="Filing a survey comes later." label="A survey">
        <Input aria-label="A survey" disabled />
      </UnavailableField>,
    );
    const group = screen.getByRole('group', { name: 'A survey' });
    expect(group).toHaveAttribute('aria-disabled', 'true');
    expect(group).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('says Not available yet on a press, and on ⏎ or Space from the keyboard', async () => {
    toasts.length = 0;
    render(
      <UnavailableField what="Filing a survey comes later." label="A survey">
        <Input aria-label="A survey" disabled />
      </UnavailableField>,
    );
    const group = screen.getByRole('group', { name: 'A survey' });
    await userEvent.click(group);
    group.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await userEvent.keyboard('a');
    expect(toasts).toEqual([
      { title: 'Not available yet', description: 'Filing a survey comes later.' },
      { title: 'Not available yet', description: 'Filing a survey comes later.' },
      { title: 'Not available yet', description: 'Filing a survey comes later.' },
    ]);
  });
});
