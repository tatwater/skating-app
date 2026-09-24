import { timelineModel } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByRole('button', { name: 'END 4:12, drag to change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'START 2:05, drag to change' })).toBeInTheDocument();
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
      const end = screen.getByRole('button', { name: /^END 4:12/ });
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
      const start = screen.getByRole('button', { name: /^START 2:05/ });
      fireEvent.pointerDown(start, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(start, { clientX: 1000, pointerId: 1 });
      expect(screen.getByRole('button', { name: /^START …/ })).toBeInTheDocument();
      fireEvent.pointerUp(start, { clientX: 1000, pointerId: 1 });
      expect(onSetStart).toHaveBeenCalledWith(local(16, 11));
      const end = screen.getByRole('button', { name: /^END 4:12/ });
      fireEvent.pointerDown(end, { clientX: 600, pointerId: 1 });
      fireEvent.pointerMove(end, { clientX: 1000, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 1000, pointerId: 1 });
      expect(onSetEnd).toHaveBeenCalledWith(local(18, 40));
    });

    it('the end dragged onto the start stops a minute after it — never a zero-minute skate', () => {
      rulerOf();
      const onSetEnd = vi.fn();
      render(<Timeline model={model} onSetEnd={onSetEnd} onSetStart={() => {}} />);
      const end = screen.getByRole('button', { name: /^END 4:12/ });
      fireEvent.pointerDown(end, { clientX: 600, pointerId: 1 });
      fireEvent.pointerMove(end, { clientX: 0, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 0, pointerId: 1 });
      expect(onSetEnd).toHaveBeenCalledWith(local(14, 6));
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
});
