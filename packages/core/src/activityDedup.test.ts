import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_DEDUP_START_WINDOW_MS,
  activitiesMatch,
  activityProviderRank,
  type DedupActivity,
  dedupActivities,
} from './activityDedup';

const T0 = Date.UTC(2026, 0, 10, 14, 0);
const MIN = 60 * 1000;

function act(over: Partial<DedupActivity> & { id: string }): DedupActivity {
  return { userId: 'u1', provider: 'native', startTime: T0, endTime: T0 + 60 * MIN, ...over };
}

describe('activitiesMatch (N8/B4a)', () => {
  it('matches overlapping recordings whose starts are inside the window', () => {
    const phone = act({ id: 'p' });
    const watch = act({
      id: 'w',
      provider: 'garmin',
      startTime: T0 + 4 * MIN,
      endTime: T0 + 58 * MIN,
    });
    expect(activitiesMatch(phone, watch)).toBe(true);
    expect(activitiesMatch(watch, phone)).toBe(true);
  });

  it('a start more than the window apart is a second skate, however long they overlap', () => {
    const a = act({ id: 'a', endTime: T0 + 180 * MIN });
    const b = act({
      id: 'b',
      provider: 'garmin',
      startTime: T0 + ACTIVITY_DEDUP_START_WINDOW_MS + 1,
    });
    expect(activitiesMatch(a, b)).toBe(false);
  });

  it('two non-overlapping recordings inside the window are two skates', () => {
    const a = act({ id: 'a', endTime: T0 + 2 * MIN });
    const b = act({ id: 'b', provider: 'garmin', startTime: T0 + 5 * MIN, endTime: T0 + 30 * MIN });
    expect(activitiesMatch(a, b)).toBe(false);
  });

  it('never matches across users, and never matches a row with itself', () => {
    const a = act({ id: 'a' });
    expect(activitiesMatch(a, act({ id: 'b', userId: 'u2' }))).toBe(false);
    expect(activitiesMatch(a, a)).toBe(false);
  });

  it('bodies must be compatible: equal, or one unresolved', () => {
    const a = act({ id: 'a', waterBodyId: 'morey' });
    expect(activitiesMatch(a, act({ id: 'b', provider: 'garmin', waterBodyId: 'morey' }))).toBe(
      true,
    );
    expect(activitiesMatch(a, act({ id: 'c', provider: 'garmin' }))).toBe(true);
    expect(activitiesMatch(a, act({ id: 'd', provider: 'garmin', waterBodyId: 'fairlee' }))).toBe(
      false,
    );
  });

  it('an end-less recording is an instant at its start', () => {
    const watch = act({ id: 'w', provider: 'garmin', startTime: T0 + 3 * MIN, endTime: undefined });
    expect(activitiesMatch(act({ id: 'p' }), watch)).toBe(true);
    // …and two instants only match if they coincide.
    expect(activitiesMatch(act({ id: 'x', endTime: undefined }), watch)).toBe(false);
  });
});

describe('the precedence ladder', () => {
  it('sorts on fidelity and displayability: native, watch, aggregator, strava, other', () => {
    expect(activityProviderRank('native')).toBeLessThan(activityProviderRank('garmin'));
    expect(activityProviderRank('coros')).toBeLessThan(activityProviderRank('apple_health'));
    expect(activityProviderRank('google_health_connect')).toBeLessThan(
      activityProviderRank('strava'),
    );
    expect(activityProviderRank('strava')).toBeLessThan(activityProviderRank('other'));
    expect(activityProviderRank('some_future_thing')).toBe(activityProviderRank('other'));
  });

  it('keeps the best copy as the winner and supersedes the rest, never merging', () => {
    const health = act({ id: 'h', provider: 'apple_health', startTime: T0 + 2 * MIN });
    const watch = act({ id: 'w', provider: 'garmin', startTime: T0 + 1 * MIN });
    const strava = act({ id: 's', provider: 'strava' });
    const { winners, superseded } = dedupActivities([health, strava, watch]);
    expect(winners.map((w) => w.id)).toEqual(['w']);
    expect(superseded.map((s) => [s.loser.id, s.winner.id])).toEqual([
      ['h', 'w'],
      ['s', 'w'],
    ]);
  });

  it('leaves distinct skates alone — a morning and an afternoon are two winners', () => {
    const morning = act({ id: 'm', startTime: T0, endTime: T0 + 60 * MIN });
    const afternoon = act({ id: 'a', startTime: T0 + 240 * MIN, endTime: T0 + 300 * MIN });
    const { winners, superseded } = dedupActivities([afternoon, morning]);
    expect(winners.map((w) => w.id)).toEqual(['m', 'a']);
    expect(superseded).toEqual([]);
  });

  it('with one provider, nothing is ever superseded (today’s reality)', () => {
    const a = act({ id: 'a' });
    const b = act({ id: 'b', startTime: T0 + 90 * MIN, endTime: T0 + 120 * MIN });
    expect(dedupActivities([a, b]).superseded).toEqual([]);
  });

  it('a chain resolves to the first winner: a loser is compared to winners, not to other losers', () => {
    // A (native, 0–60) ~ B (garmin, 8–70) ~ C (strava, 16–80), but A ≁ C (starts 16 min apart).
    const a = act({ id: 'a' });
    const b = act({ id: 'b', provider: 'garmin', startTime: T0 + 8 * MIN, endTime: T0 + 70 * MIN });
    const c = act({
      id: 'c',
      provider: 'strava',
      startTime: T0 + 16 * MIN,
      endTime: T0 + 80 * MIN,
    });
    const { winners, superseded } = dedupActivities([c, b, a]);
    expect(winners.map((w) => w.id)).toEqual(['a', 'c']);
    expect(superseded.map((s) => [s.loser.id, s.winner.id])).toEqual([['b', 'a']]);
  });
});
