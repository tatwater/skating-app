import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { personNameClass } from '@/components/PersonName';

import { PersonLockup } from './person-lockup';

describe('PersonLockup', () => {
  it('names the person once, by their real name, the handle beside it', () => {
    render(<PersonLockup name="Rob Tremblay" handle="rtremblay" />);
    expect(screen.getByText('Rob Tremblay')).toBeInTheDocument();
    expect(screen.getByText('@rtremblay', { exact: false })).toBeInTheDocument();
    // The face is hidden beside the written name, so a reader hears the name once.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps the name, the handle and the face out of analytics, whatever its size', () => {
    for (const size of ['sm', 'md', 'row', 'head'] as const) {
      const { container, unmount } = render(
        <PersonLockup name="Rob Tremblay" handle="rtremblay" size={size} />,
      );
      const masked = [...container.querySelectorAll(`.${personNameClass}`)];
      expect(masked.some((el) => el.textContent === 'Rob Tremblay')).toBe(true);
      expect(masked.some((el) => el.textContent === '@rtremblay')).toBe(true);
      expect(container.querySelector('[data-slot="avatar"]')).toHaveClass(personNameClass);
      unmount();
    }
  });

  it('marks what was searched in the name and the handle', () => {
    const { container } = render(<PersonLockup name="Jamie Moreau" handle="jm_ice" mark="mor" />);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Mor']);
    render(<PersonLockup name="Pat Lacasse" handle="mascoma_pat" mark="mascoma" size="row" />);
    expect(screen.getByText('mascoma').tagName).toBe('MARK');
  });

  it('makes the name a heading at the level asked, for the person a page is about', () => {
    render(<PersonLockup name="Rob Tremblay" handle="rtremblay" size="head" nameAs="h2" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Rob Tremblay');
    // Its start-aligned column sizes it to its content: held to the column, a long name truncates
    // rather than running past the pane (and scrolling it sideways at phone width).
    expect(heading).toHaveClass('max-w-full', 'truncate');
  });

  it('takes each size’s face, and a photo when given', () => {
    const face = (size: 'sm' | 'md' | 'row' | 'head') => {
      const { container, unmount } = render(
        <PersonLockup name="A B" size={size} src="https://example.test/a.png" />,
      );
      const avatar = container.querySelector('[data-slot="avatar"]');
      const out = avatar?.getAttribute('data-size');
      unmount();
      return out;
    };
    expect([face('sm'), face('md'), face('row'), face('head')]).toEqual(['sm', 'sm', 'md', 'xl']);
  });

  it('links the handle when given a page, and draws no handle without one', () => {
    const { rerender } = render(<PersonLockup name="Rob Tremblay" handle="rtremblay" href="#p" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#p');
    rerender(<PersonLockup name="Teagan" size="md" />);
    expect(document.querySelector('[data-slot="person-handle"]')).toBeNull();
  });
});
