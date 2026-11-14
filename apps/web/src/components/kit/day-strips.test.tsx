import { render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type DayStrip, DayStrips, dayParts, MIN_MARK, roomAbove, stripStep } from './day-strips';

const strip = (values: (number | null)[], unknown?: number[]): DayStrip => ({
  key: 's',
  label: '2025–26',
  values,
  ...(unknown !== undefined ? { unknown } : {}),
});

describe('DayStrips', () => {
  it('draws a known bar and a broken unknown stack on it; nothing on a quiet or future day', () => {
    const { container } = render(
      <DayStrips
        strips={[
          {
            ...strip([2, 0, 0, null], [1, 0, 3, 0]),
            dayTitle: (i) => `day ${i}`,
            today: 2,
            opens: 0,
            current: true,
          },
        ]}
        months={[{ at: 0, label: 'OCT' }]}
        days={4}
      />,
    );
    const days = [...container.querySelectorAll<SVGGElement>('[data-slot="day-strip-day"]')];
    expect(days.map((d) => [d.dataset.day, d.dataset.known, d.dataset.unknown])).toEqual([
      ['0', '2', '1'],
      ['2', '0', '3'],
    ]);
    // A day whose only entries are unknown still carries a mark, and no known bar.
    expect(days[1]?.querySelector('[data-slot="day-strip-bar"]')).toBeNull();
    expect(days[1]?.querySelectorAll('[data-slot="day-strip-unknown"]')).toHaveLength(3);
    expect(days[0]?.querySelector('title')?.textContent).toBe('day 0');
    expect(container.querySelector('[data-slot="day-strip-ahead"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="day-strip-today"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="day-strip-opens"]')).not.toBeNull();
  });

  it('on a step too small for blocks, a day’s unknown part is one bar that counts them all', () => {
    const { container } = render(
      <DayStrips strips={[strip([10, 0], [30, 0])]} months={[]} days={2} />,
    );
    const marks = container.querySelectorAll<SVGRectElement>('[data-slot="day-strip-unknown"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.dataset.count).toBe('30');
    const step = stripStep(strip([10, 0], [30, 0]));
    expect(Number(marks[0]?.getAttribute('height'))).toBeCloseTo(30 * step, 6);
  });

  it('beside a very tall day, a day with one hazard still draws a mark that can be seen', () => {
    const tall = strip([1, 400, 0], [0, 0, 1]);
    expect(stripStep(tall) * 1).toBeLessThan(MIN_MARK);
    const { container } = render(<DayStrips strips={[tall]} months={[]} days={3} />);
    const bars = container.querySelectorAll<SVGRectElement>('[data-slot="day-strip-bar"]');
    expect(Number(bars[0]?.getAttribute('height'))).toBe(MIN_MARK);
    const unknown = container.querySelector<SVGRectElement>('[data-slot="day-strip-unknown"]');
    expect(Number(unknown?.getAttribute('height'))).toBe(MIN_MARK);
  });

  it('the first strip’s tall day grows the drawing upward, never over what is above it', () => {
    expect(roomAbove([strip([1, 2])])).toBe(0);
    expect(roomAbove([])).toBe(0);
    // 8 on the kit's step of 3 is 24, ten more than the 14 above the first baseline.
    const tall = [strip([8, 0])];
    expect(roomAbove(tall)).toBeCloseTo(10, 6);
    const { container } = render(<DayStrips strips={tall} months={[]} days={2} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 -10 340 42');
    const bar = container.querySelector('[data-slot="day-strip-bar"]');
    expect(Number(bar?.getAttribute('y'))).toBeGreaterThanOrEqual(-10);
  });

  it('a reader hears each strip’s summary, or its known total', () => {
    render(
      <DayStrips
        strips={[
          { ...strip([1, 2]), summary: 'Two days' },
          { ...strip([1, 2]), key: 't', label: '2024–25' },
        ]}
        months={[]}
        days={2}
      />,
    );
    expect(screen.getByRole('img', { name: '2025–26: Two days; 2024–25: 3 in all' })).toBeVisible();
  });

  it('shrinks the step to fit a tall day, never the count (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.nat(60), { nil: null }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.nat(60), { minLength: 30, maxLength: 30 }),
        (values, unknown) => {
          const s = strip(values, unknown);
          const step = stripStep(s);
          expect(step).toBeGreaterThan(0);
          expect(step).toBeLessThanOrEqual(3);
          values.forEach((v, i) => {
            const p = dayParts(s, i);
            if (v === null) expect(p).toBeNull();
            else {
              expect(p?.known).toBe(v);
              expect(p?.unknown).toBe(unknown[i]);
              // The tallest day fits the strip's room.
              expect(((p?.known ?? 0) + (p?.unknown ?? 0)) * step).toBeLessThanOrEqual(24 + 1e-9);
            }
          });
        },
      ),
    );
  });
});
