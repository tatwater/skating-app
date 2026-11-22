import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ClaimChip } from './claim-chip';

test('a claim chip says the claim as written, its tone a data attribute', () => {
  render(<ClaimChip tone="bad">3.5″ measured</ClaimChip>);
  const chip = screen.getByText('3.5″ measured');
  expect(chip).toHaveAttribute('data-slot', 'claim-chip');
  expect(chip).toHaveAttribute('data-tone', 'bad');
  expect(chip.className).not.toContain('uppercase');
});

test('a claim chip is gray at rest', () => {
  render(<ClaimChip>black ice</ClaimChip>);
  expect(screen.getByText('black ice')).toHaveAttribute('data-tone', 'default');
});
