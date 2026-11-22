import { describe, expect, it } from 'vitest';
import { byLane, dayLine, eventsOf, span } from './InboxZero';
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
