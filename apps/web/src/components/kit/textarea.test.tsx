import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Textarea } from './textarea';

describe('Textarea', () => {
  it('is the boxed field by default', () => {
    render(<Textarea aria-label="Reason" />);
    const box = screen.getByRole('textbox', { name: 'Reason' });
    expect(box).toHaveAttribute('data-variant', 'box');
    expect(box.className).toContain('border-line2');
    expect(box.className).toContain('px-(--space-2_5)');
  });

  it('sits on one rule, with no inset, as the underline', () => {
    render(<Textarea aria-label="Story" variant="underline" />);
    const line = screen.getByRole('textbox', { name: 'Story' });
    expect(line).toHaveAttribute('data-variant', 'underline');
    expect(line.className).toContain('border-b');
    expect(line.className).toContain('px-0');
    expect(line.className).toContain('focus:shadow-[0_1px_0_0_var(--fg)]');
  });
});
