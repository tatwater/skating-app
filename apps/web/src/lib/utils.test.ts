import { describe, expect, it } from 'vitest';

import { cn, tokenMergeTheme } from './utils';

describe('cn', () => {
  it('keeps a token font size and a token color together', () => {
    // tailwind-merge alone reads `text-kick` as a color and drops it.
    expect(cn('text-kick text-fg1')).toBe('text-kick text-fg1');
  });

  it('still resolves real conflicts between token classes', () => {
    expect(cn('text-fg1', 'text-bad')).toBe('text-bad');
    expect(cn('h-btn', 'h-btn-sm')).toBe('h-btn-sm');
    expect(cn('tracking-head', 'tracking-label')).toBe('tracking-label');
    expect(cn('shadow-ring', 'shadow-focus')).toBe('shadow-focus');
  });

  it('merges conditional inputs', () => {
    expect(cn('px-2', false, undefined, ['py-1'])).toBe('px-2 py-1');
  });
});

describe('tokenMergeTheme', () => {
  it('groups every Tailwind-wired token by namespace', () => {
    const theme = tokenMergeTheme();
    expect(theme.text).toContain('kick');
    expect(theme.color).toContain('fg1');
    expect(theme.spacing).toEqual(expect.arrayContaining(['btn', 'hit-x', 'gutter']));
    expect(theme['font-weight']).toContain('semibold');
    expect(theme.ease).toContain('standard');
  });

  it('reads `--font-weight-*` as a weight, not a family, and skips unwired tokens', () => {
    const theme = tokenMergeTheme([
      { tailwindVar: '--font-weight-medium' },
      { tailwindVar: '--font-sans' },
      { tailwindVar: '--unknown-thing' },
      {},
    ]);
    expect(theme['font-weight']).toEqual(['medium']);
    expect(theme.font).toEqual(['sans']);
    expect(Object.values(theme).flat()).toHaveLength(2);
  });
});

it('keeps text-trim next to a text color or size class (kit.css utility, not a color)', () => {
  expect(cn('text-trim', 'text-fg1')).toBe('text-trim text-fg1');
  expect(cn('text-fg1', 'text-trim')).toBe('text-fg1 text-trim');
  expect(cn('text-trim', 'text-kick')).toBe('text-trim text-kick');
  expect(cn('text-trim', 'text-trim')).toBe('text-trim');
});
