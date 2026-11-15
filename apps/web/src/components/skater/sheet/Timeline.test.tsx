import { caretLabel, timelineModel } from '@skating/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { property } from '@/lib/sheetStore.propertyRuns';
import { Timeline } from './Timeline';

const TZ = 'America/New_York';
const local = (h: number, m = 0) => Date.UTC(2026, 0, 10, h + 5, m);
const sun = { sunriseMs: local(7, 12), sunsetMs: local(16, 31) };

describe('Timeline', () => {
  it('draws the day: sunrise and sunset, the start and end carets, now, and the hour labels', () => {
    const model = timelineModel({
      timeZone: TZ,
      nowMs: local(18, 40),
      endMs: local(16, 12),
      startMs: local(14, 5),
      sun,
    });
    render(<Timeline model={model} onSetEnd={() => {}} onSetStart={() => {}} />);
    expect(screen.getByText('SUNRISE 7:12')).toBeInTheDocument();
    expect(screen.getByText('SUNSET 4:31')).toBeInTheDocument();
    expect(screen.getByText('NOW 6:40')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'End time' })).toHaveTextContent('END 4:12');
    expect(screen.getByRole('slider', { name: 'Start time' })).toHaveTextContent('START 2:05');
    expect(screen.getByRole('slider', { name: 'End time' })).toHaveAttribute(
      'aria-valuetext',
      'Saturday 4:12 PM',
    );
    expect(screen.getByText('NOON')).toBeInTheDocument();
  });

  it('a track’s end is exact and does not drag', () => {
    const model = timelineModel({ timeZone: TZ, nowMs: local(18), endMs: local(16, 12), sun });
    render(<Timeline model={model} onSetEnd={() => {}} endLocked />);
    expect(screen.getByRole('button', { name: 'END 4:12' })).toBeInTheDocument();
  });

  it('a tap on a ladder tick chooses that half hour as the end (D192)', () => {
    const onSetEnd = vi.fn();
    const model = timelineModel({
      timeZone: TZ,
      nowMs: local(16, 12),
      sun,
      ladder: [
        { ms: local(16, 12), pinned: true },
        { ms: local(15, 30), pinned: false },
      ],
    });
    render(<Timeline model={model} onSetEnd={onSetEnd} />);
    const ticks = screen.getAllByRole('button', { name: /End about/ });
    expect(ticks[1]).toHaveAccessibleName('End about 3:30');
    expect(ticks).toHaveLength(2);
    fireEvent.click(ticks[1] as HTMLElement);
    expect(onSetEnd).toHaveBeenCalledWith(local(15, 30));
  });

  describe('the carets', () => {
    const model = timelineModel({
      timeZone: TZ,
      nowMs: local(18, 40),
      endMs: local(16, 12),
      startMs: local(14, 5),
      sun,
    });
    afterEach(() => vi.restoreAllMocks());
    /** The ruler is a thousand pixels wide in this test, from x = 0. */
    const rulerOf = () =>
      vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ left: 0, width: 1000 } as DOMRect);

    it('a click that does not move commits nothing — a press on the label is not an edit', () => {
      rulerOf();
      const onSetEnd = vi.fn();
      const onSetStart = vi.fn();
      render(<Timeline model={model} onSetEnd={onSetEnd} onSetStart={onSetStart} />);
      const end = screen.getByRole('slider', { name: 'End time' });
      fireEvent.pointerDown(end, { clientX: 640, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 640, pointerId: 1 });
      expect(onSetEnd).not.toHaveBeenCalled();
      expect(onSetStart).not.toHaveBeenCalled();
    });

    it('a drag commits on release, clamped: the start stays a minute before the end, the end never passes now', () => {
      rulerOf();
      const onSetEnd = vi.fn();
      const onSetStart = vi.fn();
      render(<Timeline model={model} onSetEnd={onSetEnd} onSetStart={onSetStart} />);
      const start = screen.getByRole('slider', { name: 'Start time' });
      fireEvent.pointerDown(start, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(start, { clientX: 1000, pointerId: 1 });
      // The label follows the handle with the minute a release there saves.
      expect(start).toHaveTextContent('START 4:11');
      fireEvent.pointerUp(start, { clientX: 1000, pointerId: 1 });
      expect(onSetStart).toHaveBeenCalledWith(local(16, 11));
      const end = screen.getByRole('slider', { name: 'End time' });
      fireEvent.pointerDown(end, { clientX: 600, pointerId: 1 });
      fireEvent.pointerMove(end, { clientX: 1000, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 1000, pointerId: 1 });
      expect(onSetEnd).toHaveBeenCalledWith(local(18, 40));
    });

    it('the end dragged onto the start stops a minute after it — never a zero-minute skate', () => {
      rulerOf();
      const onSetEnd = vi.fn();
      render(<Timeline model={model} onSetEnd={onSetEnd} onSetStart={() => {}} />);
      const end = screen.getByRole('slider', { name: 'End time' });
      fireEvent.pointerDown(end, { clientX: 600, pointerId: 1 });
      fireEvent.pointerMove(end, { clientX: 0, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 0, pointerId: 1 });
      expect(onSetEnd).toHaveBeenCalledWith(local(14, 6));
    });
  });

  describe('the ghost start caret — placing a start that does not exist yet', () => {
    const model = timelineModel({ timeZone: TZ, nowMs: local(18, 40), endMs: local(16, 12), sun });
    afterEach(() => vi.restoreAllMocks());
    const rulerOf = () =>
      vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ left: 0, width: 1000 } as DOMRect);

    it('waits an hour before the end, and dragging it places the start', () => {
      rulerOf();
      const onSetStart = vi.fn();
      render(<Timeline model={model} onSetEnd={() => {}} onSetStart={onSetStart} />);
      const ghost = screen.getByRole('slider', { name: 'Place the start, drag to set' });
      fireEvent.pointerDown(ghost, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(ghost, { clientX: 300, pointerId: 1 });
      const shown = ghost.textContent;
      fireEvent.pointerUp(ghost, { clientX: 300, pointerId: 1 });
      expect(onSetStart).toHaveBeenCalledTimes(1);
      const placed = onSetStart.mock.calls[0]?.[0] as number;
      expect(shown).toBe(caretLabel('start', placed, TZ));
      expect(placed).toBeLessThan(local(16, 12));
      expect(placed % 60_000).toBe(0);
    });

    it('a press that does not move places nothing', () => {
      rulerOf();
      const onSetStart = vi.fn();
      render(<Timeline model={model} onSetEnd={() => {}} onSetStart={onSetStart} />);
      const ghost = screen.getByRole('slider', { name: 'Place the start, drag to set' });
      fireEvent.pointerDown(ghost, { clientX: 500, pointerId: 1 });
      fireEvent.pointerUp(ghost, { clientX: 500, pointerId: 1 });
      expect(onSetStart).not.toHaveBeenCalled();
    });

    it('absent once a start exists, without a setter, or without an end', () => {
      const withStart = timelineModel({
        timeZone: TZ,
        nowMs: local(18, 40),
        endMs: local(16, 12),
        startMs: local(14, 5),
        sun,
      });
      const { rerender } = render(
        <Timeline model={withStart} onSetEnd={() => {}} onSetStart={() => {}} />,
      );
      const name = 'Place the start, drag to set';
      expect(screen.queryByRole('slider', { name })).not.toBeInTheDocument();
      rerender(<Timeline model={model} onSetEnd={() => {}} />);
      expect(screen.queryByRole('slider', { name })).not.toBeInTheDocument();
      const noEnd = timelineModel({ timeZone: TZ, nowMs: local(18, 40), sun });
      rerender(<Timeline model={noEnd} onSetEnd={() => {}} onSetStart={() => {}} />);
      expect(screen.queryByRole('slider', { name })).not.toBeInTheDocument();
    });
  });

  it('a ladder tick at or before the start is drawn but not offered', () => {
    const onSetEnd = vi.fn();
    const model = timelineModel({
      timeZone: TZ,
      nowMs: local(16, 30),
      endMs: local(16, 12),
      startMs: local(15, 30),
      sun,
      ladder: [
        { ms: local(16, 0), pinned: false },
        { ms: local(15, 30), pinned: false },
        { ms: local(15, 0), pinned: false },
      ],
    });
    render(<Timeline model={model} onSetEnd={onSetEnd} onSetStart={() => {}} />);
    expect(screen.getByRole('button', { name: 'End about 4:00' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'End about 3:30' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End about 3:00' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'End about 3:00' }));
    expect(onSetEnd).not.toHaveBeenCalled();
  });

  it('shows the other Reports of the day as labeled spans', () => {
    const model = timelineModel({
      timeZone: TZ,
      nowMs: local(18),
      endMs: local(16, 12),
      sun,
      others: [{ id: 'm', label: '1 · MASCOMA', startMs: local(12, 40), endMs: local(13, 30) }],
    });
    render(<Timeline model={model} />);
    expect(screen.getByText('1 · MASCOMA')).toBeInTheDocument();
  });

  describe('the label follows the handle', () => {
    afterEach(() => vi.restoreAllMocks());
    const rulerOf = () =>
      vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ left: 0, width: 1000 } as DOMRect);

    /** The sheet's loop: a commit rebuilds the model, as `InstrumentPane` does through the store. */
    function Live({
      zone,
      endMs,
      startMs,
      nowMs,
    }: {
      zone: string;
      endMs: number;
      startMs?: number;
      nowMs: number;
    }) {
      const [end, setEnd] = useState(endMs);
      const [start, setStart] = useState(startMs);
      const model = timelineModel({
        timeZone: zone,
        nowMs,
        endMs: end,
        ...(start !== undefined ? { startMs: start } : {}),
        sun: null,
      });
      return <Timeline model={model} onSetEnd={setEnd} onSetStart={setStart} />;
    }

    it('a pointer drag shows each minute as it passes, the one its release saves', () => {
      rulerOf();
      render(<Live zone={TZ} endMs={local(16, 12)} startMs={local(14, 5)} nowMs={local(18, 40)} />);
      const end = screen.getByRole('slider', { name: 'End time' });
      fireEvent.pointerDown(end, { clientX: 600, pointerId: 1 });
      for (const x of [610, 655, 702, 731]) {
        fireEvent.pointerMove(end, { clientX: x, pointerId: 1 });
        const during = end.textContent;
        const valuetext = end.getAttribute('aria-valuetext');
        expect(during).toMatch(/^END \d{1,2}:\d{2}$/);
        expect(valuetext).toContain(during?.slice(4) ?? '');
      }
      const during = end.textContent;
      fireEvent.pointerUp(end, { clientX: 731, pointerId: 1 });
      expect(screen.getByRole('slider', { name: 'End time' }).textContent).toBe(during);
    });

    it('arrows step a minute, pages a quarter hour, Home and End go to the bounds — the label each step', () => {
      render(<Live zone={TZ} endMs={local(16, 12)} startMs={local(14, 5)} nowMs={local(18, 40)} />);
      const end = () => screen.getByRole('slider', { name: 'End time' });
      fireEvent.keyDown(end(), { key: 'ArrowRight' });
      expect(end()).toHaveTextContent('END 4:13');
      expect(end()).toHaveAttribute('aria-valuetext', 'Saturday 4:13 PM');
      fireEvent.keyDown(end(), { key: 'ArrowDown' });
      fireEvent.keyDown(end(), { key: 'ArrowLeft' });
      expect(end()).toHaveTextContent('END 4:11');
      fireEvent.keyDown(end(), { key: 'PageUp' });
      expect(end()).toHaveTextContent('END 4:26');
      fireEvent.keyDown(end(), { key: 'PageDown' });
      fireEvent.keyDown(end(), { key: 'ArrowUp' });
      expect(end()).toHaveTextContent('END 4:12');
      fireEvent.keyDown(end(), { key: 'End' });
      expect(end()).toHaveTextContent('END 6:40');
      fireEvent.keyDown(end(), { key: 'Home' });
      expect(end()).toHaveTextContent('END 2:06');
      fireEvent.keyDown(end(), { key: 'Tab' });
      expect(end()).toHaveTextContent('END 2:06');
      const start = screen.getByRole('slider', { name: 'Start time' });
      fireEvent.keyDown(start, { key: 'ArrowRight' });
      // A minute before the end at most: the step that would cross it stays put.
      expect(screen.getByRole('slider', { name: 'Start time' })).toHaveTextContent('START 2:05');
    });

    it('the ghost start steps from where it waits, and a locked end takes no keys', () => {
      const onSetStart = vi.fn();
      const onSetEnd = vi.fn();
      const model = timelineModel({
        timeZone: TZ,
        nowMs: local(18, 40),
        endMs: local(16, 12),
        sun,
      });
      const { rerender } = render(
        <Timeline model={model} onSetEnd={onSetEnd} onSetStart={onSetStart} />,
      );
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Place the start, drag to set' }), {
        key: 'ArrowLeft',
      });
      expect(onSetStart).toHaveBeenCalledWith(local(15, 11));
      rerender(<Timeline model={model} onSetEnd={onSetEnd} endLocked />);
      const locked = screen.getByRole('button', { name: 'END 4:12' });
      fireEvent.keyDown(locked, { key: 'ArrowLeft' });
      expect(onSetEnd).not.toHaveBeenCalled();
    });

    it('the label sits in a fixed box of tabular figures, so changing digits shift nothing', () => {
      render(<Live zone={TZ} endMs={local(9, 59)} nowMs={local(18, 40)} />);
      const label = screen.getByRole('slider', { name: 'End time' }).firstElementChild;
      expect(label?.className).toMatch(/tabular-nums/);
      expect(label?.className).toMatch(/min-w-\[11ch\]/);
    });

    /** Days where the clock does something: an ordinary one, a DST change, and a ruler over midnight. */
    const DAYS = [
      {
        zone: 'America/New_York',
        end: Date.UTC(2026, 0, 10, 21, 12),
        now: Date.UTC(2026, 0, 10, 23, 40),
      },
      // Spring forward: 2 AM local does not exist on 8 March 2026.
      {
        zone: 'America/New_York',
        end: Date.UTC(2026, 2, 8, 8, 10),
        now: Date.UTC(2026, 2, 8, 9, 30),
      },
      // Near midnight at both ends of the date line.
      {
        zone: 'Etc/GMT-14',
        end: Date.UTC(2026, 0, 10, 10, 20),
        now: Date.UTC(2026, 0, 10, 10, 50),
      },
      {
        zone: 'Etc/GMT+11',
        end: Date.UTC(2026, 0, 11, 10, 40),
        now: Date.UTC(2026, 0, 11, 11, 30),
      },
    ];

    property(
      'the label during a drag is the label after release at the same position, in any zone',
      () =>
        fc.asyncProperty(
          fc.constantFrom(...DAYS),
          fc.constantFrom<'end' | 'start'>('end', 'start'),
          fc.integer({ min: 0, max: 1000 }),
          async (day, kind, x) => {
            cleanup();
            vi.restoreAllMocks();
            rulerOf();
            render(
              <Live
                zone={day.zone}
                endMs={day.end}
                startMs={day.end - 3_600_000}
                nowMs={day.now}
              />,
            );
            const caret = screen.getByRole('slider', {
              name: kind === 'end' ? 'End time' : 'Start time',
            });
            fireEvent.pointerDown(caret, { clientX: 500, pointerId: 1 });
            fireEvent.pointerMove(caret, { clientX: x, pointerId: 1 });
            const during = caret.textContent;
            const valuetext = caret.getAttribute('aria-valuetext');
            fireEvent.pointerUp(caret, { clientX: x, pointerId: 1 });
            const after = screen.getByRole('slider', {
              name: kind === 'end' ? 'End time' : 'Start time',
            });
            expect(after.textContent).toBe(during);
            expect(after.getAttribute('aria-valuetext')).toBe(valuetext);
          },
        ),
      { numRuns: 60, timeoutMs: 20_000 },
    );
  });
});
