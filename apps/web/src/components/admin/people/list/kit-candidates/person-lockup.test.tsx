import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { personNameClass } from '@/components/PersonName';

import { PersonLockup } from './person-lockup';

describe('PersonLockup', () => {
  it('names the person once, by their real name, with the handle beside it', () => {
    render(<PersonLockup name="Rob Tremblay" handle="rtremblay" />);
    expect(screen.getByText('Rob Tremblay')).toBeInTheDocument();
    expect(screen.getByText('@rtremblay')).toBeInTheDocument();
    // The face is hidden beside the written name, so a reader hears the name once.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('makes the handle the link to the profile, in a new tab, only when given one', () => {
    const { rerender } = render(<PersonLockup name="Rob Tremblay" handle="rtremblay" />);
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<PersonLockup name="Rob Tremblay" handle="rtremblay" href="/u/rtremblay" />);
    const link = screen.getByRole('link', { name: '@rtremblay' });
    expect(link).toHaveAttribute('href', '/u/rtremblay');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps the name, the handle and the face out of analytics', () => {
    const { container } = render(<PersonLockup name="Rob Tremblay" handle="rtremblay" />);
    const masked = [...container.querySelectorAll(`.${personNameClass}`)];
    expect(masked.some((el) => el.textContent === 'Rob Tremblay')).toBe(true);
    expect(masked.some((el) => el.textContent === '@rtremblay')).toBe(true);
    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass(personNameClass);
  });

  it('marks what was searched in the name and the handle', () => {
    const { container } = render(
      <PersonLockup name="Jamie Moreau" handle="jm_ice" mark="mor" size="sm" />,
    );
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Mor']);
    render(<PersonLockup name="Pat Lacasse" handle="mascoma_pat" mark="mascoma" />);
    expect(screen.getByText('mascoma').tagName).toBe('MARK');
  });

  it('takes the small face in a line of text, the lockup’s face in a row', () => {
    const { container, rerender } = render(<PersonLockup name="A B" handle="ab" size="sm" />);
    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute('data-size', 'sm');
    rerender(<PersonLockup name="A B" handle="ab" src="https://example.test/a.png" />);
    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute('data-size', 'md');
  });
});
