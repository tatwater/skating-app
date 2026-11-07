import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';
import { PersonName, personNameClass } from './PersonName';

/**
 * The class string itself is the contract with PostHog's SDK, so it is asserted literally rather
 * than through the constant — a typo in the constant would otherwise pass against itself, and
 * `ph-no-captures` or `ph-nocapture` masks nothing while looking right in a diff (D235).
 */
describe('PersonName', () => {
  it("carries PostHog's exact opt-out class", () => {
    render(<PersonName>Teagan</PersonName>);

    expect(screen.getByText('Teagan')).toHaveClass('ph-no-capture');
    expect(personNameClass).toBe('ph-no-capture');
  });

  it('keeps the caller’s own classes alongside the mask', () => {
    render(<PersonName className="truncate text-foreground">Teagan</PersonName>);

    const el = screen.getByText('Teagan');
    expect(el).toHaveClass('ph-no-capture');
    expect(el).toHaveClass('truncate');
    expect(el).toHaveClass('text-foreground');
  });

  it('renders the name as given', () => {
    render(<PersonName>@teagan</PersonName>);

    expect(screen.getByText('@teagan')).toBeInTheDocument();
  });
});

/**
 * An avatar carries the name twice over — as the image's `alt` and as the fallback initial — and
 * autocapture collects element attributes as well as text, so the mask has to be on the element
 * itself in both branches.
 */
describe('Avatar', () => {
  it('masks the image whose alt text is the person’s name', () => {
    render(<Avatar displayName="Teagan Atwater" imageUrl="https://img.example/a.png" />);

    expect(screen.getByAltText('Teagan Atwater')).toHaveClass('ph-no-capture');
  });

  it('masks the initial fallback when there is no image', () => {
    const { container } = render(<Avatar displayName="Teagan Atwater" />);

    const fallback = container.querySelector('div');
    expect(fallback).toHaveTextContent('T');
    expect(fallback).toHaveClass('ph-no-capture');
  });
});
