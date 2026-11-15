import { fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  anyMark,
  type DayStrip,
  DayStrips,
  dayParts,
  MIN_MARK,
  roomAbove,
  stripStep,
} from './day-strips';

const strip = (values: (number | null)[], marks?: number[]): DayStrip => ({
  key: 's',
  label: '2025–26',
  values,
  ...(marks !== undefined ? { marks } : {}),
});

describe('DayStrips', () => {
  it('draws a known bar and a mark per first report on it; nothing on a quiet or future day', () => {
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
        caption="A mark is a first report"
      />,
    );
    const days = [...container.querySelectorAll<SVGGElement>('[data-slot="day-strip-day"]')];
    expect(days.map((d) => [d.dataset.day, d.dataset.known, d.dataset.marks])).toEqual([
      ['0', '2', '1'],
      ['2', '0', '3'],
    ]);
    // A day whose only entries are marks carries them, and no known bar.
    expect(days[1]?.querySelector('[data-slot="day-strip-bar"]')).toBeNull();
    expect(days[1]?.querySelectorAll('[data-slot="day-strip-mark"]')).toHaveLength(3);
    // A mark never stands without the words that say what it is.
    expect(container.querySelector('[data-slot="day-strips-caption"]')?.textContent).toBe(
      'A mark is a first report',
    );
    expect(days[0]?.querySelector('title')?.textContent).toBe('day 0');
    expect(container.querySelector('[data-slot="day-strip-ahead"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="day-strip-today"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="day-strip-opens"]')).not.toBeNull();
  });

  it('on a step too small for blocks, a day’s marks are one bar that counts them all', () => {
    const { container } = render(
      <DayStrips strips={[strip([10, 0], [30, 0])]} months={[]} days={2} />,
    );
    const marks = container.querySelectorAll<SVGRectElement>('[data-slot="day-strip-mark"]');
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
    const mark = container.querySelector<SVGRectElement>('[data-slot="day-strip-mark"]');
    expect(Number(mark?.getAttribute('height'))).toBe(MIN_MARK);
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

  it('never draws a day’s unknown part, but keeps its words on a target a pointer finds', () => {
    const { container } = render(
      <DayStrips
        strips={[
          {
            ...strip([1, 0, 0], [0, 0, 0]),
            unknown: [2, 3, 0],
            dayTitle: (i) => `day ${i}`,
          },
        ]}
        months={[]}
        days={3}
      />,
    );
    const days = [...container.querySelectorAll<SVGGElement>('[data-slot="day-strip-day"]')];
    expect(days.map((d) => [d.dataset.day, d.dataset.known, d.dataset.unknown])).toEqual([
      ['0', '1', '2'],
      ['1', '0', '3'],
    ]);
    // No tower: the unknown-only day has no bar and no mark, only its words.
    expect(days[1]?.querySelector('[data-slot="day-strip-bar"]')).toBeNull();
    expect(days[1]?.querySelector('[data-slot="day-strip-mark"]')).toBeNull();
    expect(days[1]?.querySelector('[data-slot="day-strip-target"]')).not.toBeNull();
    expect(days[1]?.querySelector('title')?.textContent).toBe('day 1');
    expect(container.querySelectorAll('[data-slot="day-strip-mark"]')).toHaveLength(0);
    // A tall unknown part never shrinks the step: it isn't drawn.
    expect(stripStep({ ...strip([1, 0]), unknown: [400, 0] })).toBe(3);
  });

  it('draws no caption without a mark, and none on a day that has not happened', () => {
    const { container } = render(
      <DayStrips strips={[strip([1, 2, null], [0, 0, 4])]} months={[]} days={3} caption="c" />,
    );
    expect(anyMark([strip([1, 2, null], [0, 0, 4])])).toBe(false);
    expect(container.querySelector('[data-slot="day-strip-mark"]')).toBeNull();
    expect(container.querySelector('[data-slot="day-strips-caption"]')).toBeNull();
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
        (values, marks) => {
          const s = strip(values, marks);
          const step = stripStep(s);
          expect(step).toBeGreaterThan(0);
          expect(step).toBeLessThanOrEqual(3);
          values.forEach((v, i) => {
            const p = dayParts(s, i);
            if (v === null) expect(p).toBeNull();
            else {
              expect(p?.known).toBe(v);
              expect(p?.marks).toBe(marks[i]);
              // The tallest day fits the strip's room.
              expect(((p?.known ?? 0) + (p?.marks ?? 0)) * step).toBeLessThanOrEqual(24 + 1e-9);
            }
          });
        },
      ),
    );
  });

  it('draws the caption whenever a mark is drawn, and every mark it is given (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.nat(8), { nil: null }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(4), { minLength: 12, maxLength: 12 }),
        (values, marks) => {
          const { container, unmount } = render(
            <DayStrips strips={[strip(values, marks)]} months={[]} days={12} caption="c" />,
          );
          const drawn = [
            ...container.querySelectorAll<SVGRectElement>('[data-slot="day-strip-mark"]'),
          ].reduce((n, m) => n + Number(m.dataset.count ?? 1), 0);
          const given = values.reduce<number>(
            (n, v, i) => n + (v === null ? 0 : (marks[i] ?? 0)),
            0,
          );
          expect(drawn).toBe(given);
          expect(container.querySelector('[data-slot="day-strips-caption"]') !== null).toBe(
            given > 0,
          );
          unmount();
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('DayStrips — every day a pointer can read, readable without one', () => {
  // A seeded winter: a capped day (its words a floor), a quiet day, days not yet happened.
  const words = (i: number) =>
    i === 1 ? 'At least 50 reported on the lake' : i === 0 ? '2 reported on the lake' : 'Quiet';
  const strips: DayStrip[] = [
    {
      key: 'now',
      label: '2026–27',
      values: [2, 50, 0, null],
      unknown: [0, 0, 1, 0],
      dayTitle: (i) => (i >= 3 ? 'Not yet' : words(i)),
      today: 2,
    },
    {
      key: 'last',
      label: '2025–26',
      values: [1, 0, 0, 0],
      dayTitle: () => '1 reported on the lake',
    },
  ];
  const label = (i: number) => ['1 Oct', '2 Oct', '3 Oct', '4 Oct'][i] ?? '';
  const view = () => (
    <DayStrips strips={strips} months={[]} days={4} dayLabel={label} name="Hazard reports" />
  );

  it('tells a reader each day a pointer can find, by date and strip, in the pointer’s words', () => {
    render(view());
    const table = screen.getByRole('table', { name: 'Hazard reports by day' });
    const rows = [...table.querySelectorAll('tbody tr')].map((r) =>
      [...r.children].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['1 Oct', '2 reported on the lake', '1 reported on the lake'],
      ['2 Oct', 'At least 50 reported on the lake', '1 reported on the lake'],
      ['3 Oct', 'Quiet', '1 reported on the lake'],
    ]);
    // The picture points at its table.
    expect(screen.getByRole('img').getAttribute('aria-details')).toBe(table.id);
  });

  it('a day not yet recorded reads as such, never as zero', () => {
    render(
      <DayStrips
        strips={[{ key: 'a', label: 'A', values: [1, null] }]}
        months={[]}
        days={2}
        dayLabel={label}
      />,
    );
    const slider = screen.getByRole('slider');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveAttribute('aria-valuetext', '2 Oct, A: Not recorded');
  });

  it('one tab stop walks the days with the arrows, Home and End, and the strips with ↑↓', () => {
    render(view());
    const slider = screen.getByRole('slider', { name: 'Hazard reports' });
    expect(slider).toHaveAttribute('tabindex', '0');
    // It opens on today.
    expect(slider).toHaveAttribute('aria-valuetext', '3 Oct, 2026–27: Quiet');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '2 Oct, 2026–27: At least 50 reported on the lake',
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(slider).toHaveAttribute('aria-valuetext', '1 Oct, 2025–26: 1 reported on the lake');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveAttribute('aria-valuenow', '3');
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(slider).toHaveAttribute('aria-valuetext', '4 Oct, 2026–27: Not yet');
  });
});
