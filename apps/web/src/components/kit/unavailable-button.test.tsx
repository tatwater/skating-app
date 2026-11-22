import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { stubJsdomAnimations } from '@/components/admin/body/tabs/jsdomStubs';
import {
  COMING_SOON,
  ComingSoonLink,
  NOT_YET,
  sayComingSoon,
  sayUnavailable,
  UnavailableButton,
} from './unavailable-button';

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  toasts.length = 0;
});

describe('UnavailableButton', () => {
  it('keeps "Not available yet" for a tool, with its sentence, when no title is given', async () => {
    render(
      <UnavailableButton what="Dropping a landmark comes later.">
        Drop a landmark
      </UnavailableButton>,
    );
    const button = screen.getByRole('button', { name: 'Drop a landmark' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-unavailable-title', NOT_YET);
    await userEvent.click(button);
    expect(toasts).toEqual([
      { title: 'Not available yet', description: 'Dropping a landmark comes later.' },
    ]);
  });

  it('says "Coming soon" on a press, and on ⏎ and Space, when titled so — and does nothing else', async () => {
    const onClick = vi.fn();
    render(
      // A caller's onClick can't be passed: the type refuses it, and a press only speaks.
      <ComingSoonLink {...({ onClick } as object)}>Open in Reports</ComingSoonLink>,
    );
    const link = screen.getByRole('button', { name: /Open in Reports/ });
    expect(link).toHaveAttribute('data-variant', 'link');
    expect(link).toHaveAttribute('data-size', 'xs');
    expect(link).toHaveTextContent('Open in Reports→');
    expect(link).not.toBeDisabled();
    await userEvent.click(link);
    link.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(toasts).toEqual([
      { title: 'Coming soon' },
      { title: 'Coming soon' },
      { title: 'Coming soon' },
    ]);
  });

  it('adds a sentence under "Coming soon" only when one is given', async () => {
    render(<ComingSoonLink what="Reports is the next mode.">History</ComingSoonLink>);
    await userEvent.click(screen.getByRole('button', { name: /History/ }));
    expect(toasts).toEqual([{ title: COMING_SOON, description: 'Reports is the next mode.' }]);
  });

  it('shows "Coming soon" on focus, with no empty body under the title', async () => {
    render(<ComingSoonLink>Open in Reports</ComingSoonLink>);
    await userEvent.tab();
    expect(await screen.findByText('Coming soon')).toHaveAttribute('data-slot', 'tooltip-title');
    expect(document.querySelector('[data-slot="tooltip-body"]')).toBeNull();
  });

  it('the key path: a pane binding the key says the same words', () => {
    sayComingSoon();
    sayUnavailable('Comes with the map tools.');
    expect(toasts).toEqual([
      { title: 'Coming soon' },
      { title: 'Not available yet', description: 'Comes with the map tools.' },
    ]);
  });
});
