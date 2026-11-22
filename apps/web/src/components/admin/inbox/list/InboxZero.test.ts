import { zonedInstantOnDayOf, zonedParts } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { byLane, dayLine, eventsOf, floorLocalHour, span } from './InboxZero';
import { NOW, ZERO_TODAY } from './inboxFixtures';

const H = 3_600_000;
const clock = (at: number) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    at,
  );

describe('Inbox zero’s day', () => {
  it('says the time, the count and the median wait from filing to decision', () => {
    expect(dayLine(ZERO_TODAY, NOW, clock)).toBe(
      'As of 12:00, 22 decided today, a median of 1.5 days from filing to decision.',
    );
  });

  it('takes the middle two for an even count, and says a floor once capped', () => {
    const today = {
      ...ZERO_TODAY,
      decided: [
        { at: NOW, filedAt: NOW - 1 * H, lane: 'safety' as const, decision: 'dismissed' as const },
        { at: NOW, filedAt: NOW - 3 * H, lane: 'safety' as const, decision: 'dismissed' as const },
      ],
      decidedCapped: true,
    };
    expect(dayLine(today, NOW, clock)).toBe(
      'As of 12:00, 2+ decided today, a median of 2 hours from filing to decision.',
    );
  });

  it('says a quiet day plainly', () => {
    expect(dayLine({ ...ZERO_TODAY, decided: [] }, NOW, clock)).toBe(
      'As of 12:00, nothing decided today.',
    );
  });

  it('raises the line on a filing and lowers it on a decision', () => {
    const events = eventsOf(ZERO_TODAY);
    expect(events.filter((e) => e.delta === 1)).toHaveLength(2);
    expect(events.filter((e) => e.delta === -1)).toHaveLength(22);
  });

  it('spans from the first event’s hour (never before midnight) to the next hour', () => {
    const { from, to } = span(ZERO_TODAY, NOW);
    expect(from).toBeGreaterThanOrEqual(ZERO_TODAY.since);
    // A whole hour on the reader's clock, whatever the zone (St John's and India sit at :30).
    expect(new Date(from).getMinutes()).toBe(0);
    expect(to).toBe(NOW);
    const empty = span({ ...ZERO_TODAY, filed: [], decided: [] }, NOW + 30 * 60_000);
    expect(empty.to - empty.from).toBeGreaterThanOrEqual(H);
  });

  it('counts each lane’s decisions in the lanes’ order', () => {
    expect(byLane(ZERO_TODAY).map((l) => l.count)).toEqual([1, 3, 8, 4, 1, 3, 2]);
  });
});

describe('the lanes a viewer sees on the zero page', () => {
  it('leaves Support out for a viewer without its read — never a zero for them', () => {
    expect(byLane(ZERO_TODAY, false).map((l) => l.lane)).not.toContain('support');
    expect(byLane(ZERO_TODAY, true).map((l) => l.lane)).toContain('support');
  });
});

describe('the chart’s span on the reader’s clock (fast-check)', () => {
  // Whole-hour, half-hour and 45-minute offsets, a far-east and a far-west one, and two zones whose
  // DST changes fall inside the instants drawn (New York 8 Mar and 1 Nov 2026; Adelaide 5 Apr).
  const ZONES = [
    'UTC',
    'America/New_York',
    'America/St_Johns',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'Australia/Adelaide',
    'Etc/GMT-14',
    'Etc/GMT+11',
  ] as const;
  const H = 3_600_000;
  // Through 2026, so both of New York's changes and Adelaide's fall in the range.
  const instant = fc.integer({ min: Date.UTC(2026, 0, 2), max: Date.UTC(2026, 11, 30) });

  it('starts on a whole local hour at or before the first event, never before the day began', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        instant,
        fc.array(fc.integer({ min: 0, max: 23 * 60 }), { maxLength: 6 }),
        (zone, nowMs, minutes) => {
          const since = zonedInstantOnDayOf(nowMs, 0, zone);
          const events = minutes.map((m) => since + m * 60_000).filter((at) => at <= nowMs);
          const today = {
            ...ZERO_TODAY,
            since,
            filed: [],
            decided: events.map((at) => ({
              at,
              filedAt: at - H,
              lane: 'safety' as const,
              decision: 'dismissed' as const,
            })),
          };
          const { from, to } = span(today, nowMs, zone);
          const start = zonedParts(from, zone);
          // A whole local hour — or the day's own start, local midnight, itself whole.
          expect(start.minute).toBe(0);
          expect(start.second).toBe(0);
          expect(from).toBeGreaterThanOrEqual(since);
          for (const at of events) expect(from).toBeLessThanOrEqual(at);
          // Within an hour of the first thing drawn, unless the day's start held it.
          const first = Math.min(nowMs - 8 * H, ...events);
          if (from > since) expect(first - from).toBeLessThan(H);
          // It ends on a whole local hour at or after now, at least an hour on.
          expect(zonedParts(to, zone).minute).toBe(0);
          expect(to).toBeGreaterThanOrEqual(nowMs);
          expect(to - from).toBeGreaterThanOrEqual(H);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('floors an instant to the whole local hour that holds it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), instant, (zone, at) => {
        const floored = floorLocalHour(at, zone);
        expect(floored).toBeLessThanOrEqual(at);
        expect(at - floored).toBeLessThan(H);
        expect(zonedParts(floored, zone).minute).toBe(0);
        expect(zonedParts(floored, zone).hour).toBe(zonedParts(at, zone).hour);
      }),
      { numRuns: 400 },
    );
  });
});
