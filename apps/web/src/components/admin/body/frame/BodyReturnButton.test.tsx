import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BodyReturnButton } from './BodyReturnButton';

// The top bar's slot is the console shell's; here the button draws in place.
vi.mock('../../shell/ConsoleShell', () => ({
  ConsoleTopStart: ({ children }: { children: ReactNode }) => children,
}));

describe('the Body console’s way back', () => {
  it('leads with a long left arrow that assistive tech never hears: the name stays its label', async () => {
    const onReturn = vi.fn();
    render(<BodyReturnButton onReturn={onReturn} />);
    // Exactly "Corpus": the arrow adds nothing to the accessible name.
    const button = screen.getByRole('button', { name: 'Corpus' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+Enter');
    const arrow = button.querySelector('svg[data-slot="return-arrow"]');
    expect(arrow).not.toBeNull();
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    expect(arrow?.getAttribute('data-icon')).toBe('arrow-left-long');
    // Before the label, inside the kit button's label span.
    const label = button.querySelector('[data-slot="label"]');
    expect(label?.firstElementChild).toBe(arrow);
    expect(label).toHaveTextContent(/^Corpus$/);
    await userEvent.setup().click(button);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
