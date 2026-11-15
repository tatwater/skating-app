import { render } from '@testing-library/react';
import type { RefObject } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stands in for the measure, with its timing: "fits" once it has seen the strip's box when it
// looked — so a strip whose box mounted after the measure's one look would stay unmeasured.
vi.mock('../../shell/columnsFit', async () => {
  const { useLayoutEffect, useState } = await import('react');
  return {
    useColumnsFit: (ref: RefObject<HTMLElement | null>) => {
      const [seen, setSeen] = useState(false);
      useLayoutEffect(() => setSeen(ref.current !== null), [ref]);
      return seen;
    },
  };
});

import { stubLayout } from '../list/testLayout';
import { StaffStrip } from './PersonStrips';
import { NOW, SARAH_PAGE, SARAH_STATS, SEASON } from './personFixtures';

beforeAll(stubLayout);

const grid = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-slot="staff-strip"] > [data-slot="stat-grid"]');

describe('the staff strip', () => {
  it('is measured whenever it is drawn — also once its reads stop answering "not staff"', () => {
    const { container, rerender } = render(
      <StaffStrip person={SARAH_PAGE} stats={null} season={SEASON} now={NOW} />,
    );
    expect(grid(container)).toBeNull();
    rerender(<StaffStrip person={SARAH_PAGE} stats={SARAH_STATS} season={SEASON} now={NOW} />);
    // Measured as fitting: the board's one row, the trend a quarter wider.
    expect(grid(container)?.style.gridTemplateColumns).toBe(
      'repeat(4, minmax(0, 1fr)) minmax(0, 1.25fr)',
    );
  });
});
