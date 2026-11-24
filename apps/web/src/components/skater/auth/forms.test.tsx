import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RegionBackdrop, RegionCredit } from '../RegionBackdrop';
import { FormLine, SystemCard, SystemStage } from './SystemStage';

describe('the stage', () => {
  it('states the skater surface, puts the form before the corners, and credits the picture', () => {
    const { container } = render(
      <SystemStage corner={<a href="/about">About Gli</a>}>
        <SystemCard foot={<span>Foot</span>}>
          <FormLine>Something to fix</FormLine>
        </SystemCard>
      </SystemStage>,
    );
    expect(container.firstElementChild).toHaveAttribute('data-surface', 'skater');
    const order = [...container.querySelectorAll('main, a')].map((el) => el.tagName);
    expect(order).toEqual(['MAIN', 'A']);
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something to fix');
    expect(screen.getAllByRole('img', { name: 'Gli' })).toHaveLength(2);
  });
});

describe('RegionBackdrop', () => {
  it('is one hidden-from-readers picture per theme, lazy so the hidden one is never fetched', () => {
    const { container } = render(<RegionBackdrop className="fixed" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.className).toContain('fixed');
    expect(root.className).not.toMatch(/(^| )absolute( |$)/);
    const imgs = [...root.querySelectorAll('img')];
    expect(imgs.map((img) => img.dataset.themePicture)).toEqual(['dark', 'light']);
    for (const img of imgs) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img.getAttribute('src')).toMatch(/region-(dark|light)/);
    }
  });

  it('carries its credit', () => {
    render(<RegionCredit className="absolute" />);
    expect(
      screen.getByText('State lines: U.S. Census Bureau · Water: OpenStreetMap contributors'),
    ).toBeInTheDocument();
  });
});
