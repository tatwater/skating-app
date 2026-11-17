import { render, within } from '@testing-library/react';
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

import { FAILED_READ } from '../../reads/readFailureFixtures';
import { stubLayout } from '../list/testLayout';
import { StaffStrip } from './PersonStrips';
import { NOW, SARAH_PAGE, SARAH_STATS, SEASON } from './personFixtures';
import type { StaffStatsRead } from './personModel';
import { WORDS } from './personWords';

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

describe('who undid a staffer’s decisions', () => {
  const ref = (userId: string, displayName: string) => ({
    userId: userId as never,
    displayName,
    username: displayName.toLowerCase(),
    profileImageUrl: null,
    count: 1,
  });
  const STATS: StaffStatsRead = {
    ...SARAH_STATS,
    decisions: {
      ...SARAH_STATS.decisions,
      undoneByOthers: {
        count: 5,
        capped: false,
        by: [ref('u1', 'Ada Quill'), ref('u2', 'Bo Lindqvist')],
        byMore: 1,
      },
    },
  };
  const cell = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-fact="decisions"]') as HTMLElement;
  /** What a reader hears of the sub-line: a circle's initials are hidden from them. */
  const heard = (root: HTMLElement) => {
    const sub = cell(root).querySelector('[data-slot="stat-sub"]')?.cloneNode(true) as HTMLElement;
    for (const hidden of sub.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return sub.textContent;
  };

  it('names them in circles, masked from analytics, and counts the rest', () => {
    const { container } = render(
      <StaffStrip person={SARAH_PAGE} stats={STATS} season={SEASON} now={NOW} />,
    );
    const sub = cell(container).querySelector('[data-slot="stat-sub"]') as HTMLElement;
    expect(heard(container)).toBe('5 later undone by Ada, Bo and 1 more');
    const people = [...sub.querySelectorAll('[data-slot="person-lockup"]')];
    expect(people).toHaveLength(2);
    for (const p of people) {
      expect(p.querySelector('[data-slot="person-name"] .ph-no-capture')).not.toBeNull();
      expect(p.querySelector('[data-slot="avatar"]')).not.toBeNull();
    }
    expect(sub).not.toHaveTextContent('@');
  });

  it('joins two with “and”, and one stands alone', () => {
    const two: StaffStatsRead = {
      ...STATS,
      decisions: {
        ...STATS.decisions,
        undoneByOthers: { ...STATS.decisions.undoneByOthers, byMore: 0 },
      },
    };
    const { container, rerender } = render(
      <StaffStrip person={SARAH_PAGE} stats={two} season={SEASON} now={NOW} />,
    );
    expect(heard(container)).toBe('5 later undone by Ada and Bo');
    const one: StaffStatsRead = {
      ...STATS,
      decisions: {
        ...STATS.decisions,
        undoneByOthers: { count: 1, capped: false, by: [ref('u1', 'Ada Quill')], byMore: 0 },
      },
    };
    rerender(<StaffStrip person={SARAH_PAGE} stats={one} season={SEASON} now={NOW} />);
    expect(heard(container)).toBe('1 later undone by Ada');
  });

  it('keeps its four answers apart: on its way, failed, not recorded, named', () => {
    const draw = (stats: Parameters<typeof StaffStrip>[0]['stats']) => {
      const { container, unmount } = render(
        <StaffStrip person={SARAH_PAGE} stats={stats} season={SEASON} now={NOW} />,
      );
      const c = cell(container);
      const said = {
        loading: c?.getAttribute('aria-busy') === 'true',
        failed: c !== null && within(c).queryByText(WORDS.couldNotRead) !== null,
        none: c === null,
        named: c?.querySelector('[data-slot="person-lockup"]') != null,
      };
      unmount();
      return said;
    };
    expect(draw(undefined)).toEqual({ loading: true, failed: false, none: false, named: false });
    expect(draw(FAILED_READ)).toEqual({ loading: false, failed: true, none: false, named: false });
    // Not on staff after all: the staff reads answer `null`, and there is no strip to name anyone in.
    expect(draw(null)).toEqual({ loading: false, failed: false, none: true, named: false });
    expect(draw(STATS)).toEqual({ loading: false, failed: false, none: false, named: true });
  });
});
