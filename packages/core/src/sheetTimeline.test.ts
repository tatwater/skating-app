import { describe, expect, it } from 'vitest';
import {
  clockLabel,
  floorToLocalHour,
  MIN_SPAN_MS,
  timelineFraction,
  timelineModel,
  timelineMsAt,
} from './sheetTimeline';

const TZ = 'America/New_York';
// 2026-01-10, EST (UTC-5).
const local = (h: number, m = 0) => Date.UTC(2026, 0, 10, h + 5, m);
const HOUR = 3600_000;
const sun = { sunriseMs: local(7, 12), sunsetMs: local(16, 31) };

describe('timelineModel', () => {
  it('spans the daylight plus an hour each side, on whole local hours', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(18),
      endMs: local(16, 12),
      startMs: local(14, 5),
      sun,
    });
    expect(m.fromMs).toBe(local(6));
    // Now at 6 PM + half an hour, floored to the hour and one on: 7 PM.
    expect(m.toMs).toBe(local(19));
    expect(m.ticks[0]?.label).toBe('6 AM');
    expect(m.ticks.map((t) => t.label)).toContain('NOON');
    expect(m.ticks.find((t) => t.ms === local(13))?.label).toBe('1 PM');
    expect(m.ticks.find((t) => t.ms === local(14))?.label).toBe('2');
  });

  it('marks sunrise, sunset, start, end and now with their clock labels', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(18, 40),
      endMs: local(16, 12),
      startMs: local(14, 5),
      sun,
    });
    const kinds = m.marks.map((k) => k.kind);
    expect(kinds).toEqual(['sunrise', 'sunset', 'start', 'end', 'now']);
    expect(m.marks.find((k) => k.kind === 'end')?.label).toBe('END 4:12');
    expect(m.marks.find((k) => k.kind === 'sunset')?.label).toBe('SUNSET 4:31');
    expect(m.marks.find((k) => k.kind === 'now')?.label).toBe('NOW 6:40');
    const end = m.marks.find((k) => k.kind === 'end') as { fraction: number };
    const start = m.marks.find((k) => k.kind === 'start') as { fraction: number };
    expect(end.fraction).toBeGreaterThan(start.fraction);
    expect(m.spans[0]).toMatchObject({ id: 'mine', mine: true });
  });

  it('leaves now off the ruler when the sheet is resumed another day', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(10) + 24 * HOUR,
      endMs: local(16, 12),
      sun,
    });
    expect(m.marks.map((k) => k.kind)).not.toContain('now');
    expect(m.toMs).toBe(local(18));
  });

  it('is never shorter than the minimum span, even with no sun and no start', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(16, 12),
      endMs: local(16, 12),
      sun: null,
    });
    expect(m.toMs - m.fromMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
    expect(m.fromMs % HOUR).toBe(0);
  });

  it('draws the other Reports of the day as spans and their photos dim, and drops another day', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(18),
      endMs: local(16, 12),
      startMs: local(14, 5),
      sun,
      others: [
        { id: 'mascoma', label: '1 · Mascoma', startMs: local(12, 40), endMs: local(13, 30) },
        { id: 'yesterday', label: 'x', endMs: local(13) - 24 * HOUR },
      ],
      photos: [
        { id: 'p1', takenAtMs: local(15), mine: true, placed: true },
        { id: 'p2', takenAtMs: local(13), mine: false, placed: false },
        { id: 'p3', takenAtMs: local(13) - 24 * HOUR, mine: false, placed: false },
      ],
    });
    expect(m.spans.map((s) => s.id)).toEqual(['mine', 'mascoma']);
    expect(m.photos.map((p) => p.id)).toEqual(['p1', 'p2']);
    const p1 = m.photos[0] as { fraction: number };
    const p2 = m.photos[1] as { fraction: number };
    expect(p1.fraction).toBeGreaterThan(p2.fraction);
  });

  it('places the ladder ticks, labeled in the zone, and stretches to the earliest of them', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(16, 12),
      sun: null,
      ladder: [
        { ms: local(16, 12), pinned: true },
        { ms: local(13), pinned: false },
      ],
    });
    expect(m.fromMs).toBeLessThanOrEqual(local(12, 30));
    expect(m.ladder).toHaveLength(2);
    expect(m.ladder[0]?.fraction).toBeGreaterThan(m.ladder[1]?.fraction as number);
    expect(m.ladder.map((l) => l.label)).toEqual(['4:12', '1:00']);
  });

  it('drops a ladder from another day — a draft resumed tomorrow keeps yesterday as its ruler', () => {
    const tomorrow = 24 * HOUR;
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(18, 40) + tomorrow,
      endMs: local(14),
      sun,
      ladder: [
        { ms: local(18, 40) + tomorrow, pinned: true },
        { ms: local(18, 30) + tomorrow, pinned: false },
      ],
    });
    expect(m.ladder).toEqual([]);
    expect(m.toMs).toBe(local(18));
  });

  it('caps the ruler at a day', () => {
    const m = timelineModel({
      timeZone: TZ,
      nowMs: local(23),
      endMs: local(22),
      sun,
      photos: [{ id: 'p', takenAtMs: local(-30), mine: true, placed: false }],
    });
    expect(m.toMs - m.fromMs).toBeLessThanOrEqual(24 * HOUR);
  });
});

describe("the ruler's arithmetic", () => {
  const model = { fromMs: local(6), toMs: local(18) };
  it('maps instants to fractions and back, to the minute, clamped', () => {
    expect(timelineFraction(model, local(12))).toBeCloseTo(0.5);
    expect(timelineFraction(model, local(3))).toBe(0);
    expect(timelineFraction(model, local(22))).toBe(1);
    expect(timelineMsAt(model, 0.5)).toBe(local(12));
    expect(timelineMsAt(model, -1)).toBe(local(6));
    expect(timelineMsAt(model, 2)).toBe(local(18));
    // A fraction between minutes rounds to one.
    expect(timelineMsAt(model, 0.5 + 0.4 / (12 * 60)) % 60_000).toBe(0);
  });
  it('floors to the local hour and labels the clock without the period', () => {
    expect(floorToLocalHour(local(14, 37), TZ)).toBe(local(14));
    expect(clockLabel(local(16, 12), TZ)).toBe('4:12');
    expect(clockLabel(local(0, 5), TZ)).toBe('12:05');
  });
});
