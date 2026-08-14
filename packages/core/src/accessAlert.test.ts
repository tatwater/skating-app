import { describe, expect, test } from 'vitest';
import {
  ACCESS_ALERT_RESOLVE_VOTES,
  ACCESS_ALERT_STATUSES,
  ACCESS_ALERT_TTL_MS,
  type AccessAlertRecord,
  type AccessAlertVote,
  accessAlertExpiryFor,
  accessAlertIsLive,
  deriveAccessAlertLifecycle,
} from './accessAlert';
import { seasonEndMs, seasonOf } from './season';

const JAN = Date.UTC(2027, 0, 15);
const SEASON_END = seasonEndMs(seasonOf(JAN));

function alert(over: Partial<AccessAlertRecord> = {}): AccessAlertRecord {
  return { status: 'active', createdAt: JAN, expiresAt: JAN + ACCESS_ALERT_TTL_MS, ...over };
}

function vote(
  userId: string,
  verdict: 'still_blocked' | 'open',
  observedAt: number,
): AccessAlertVote {
  return { userId, verdict, observedAt };
}

describe('accessAlertExpiryFor', () => {
  test('a mid-winter alert lapses on the plain TTL', () => {
    expect(accessAlertExpiryFor(JAN, SEASON_END)).toBe(JAN + ACCESS_ALERT_TTL_MS);
  });

  /**
   * The seasonal rule is not negotiable: a closure asserted in June with thirty days on the clock
   * would otherwise reach into a season nobody has looked at yet.
   */
  test('an alert late in the season is cut off at the season boundary, not the TTL', () => {
    const lateSpring = SEASON_END - 3 * 24 * 60 * 60 * 1000;
    expect(accessAlertExpiryFor(lateSpring, SEASON_END)).toBe(SEASON_END);
    expect(accessAlertExpiryFor(lateSpring, SEASON_END)).toBeLessThan(
      lateSpring + ACCESS_ALERT_TTL_MS,
    );
  });

  test('the earlier of the two bounds always wins, whichever it is', () => {
    for (const offsetDays of [0, 5, 20, 29, 31, 90]) {
      const at = SEASON_END - offsetDays * 24 * 60 * 60 * 1000;
      expect(accessAlertExpiryFor(at, SEASON_END)).toBe(
        Math.min(at + ACCESS_ALERT_TTL_MS, SEASON_END),
      );
    }
  });
});

describe('accessAlertIsLive', () => {
  /** The founder's exemption, stated as a test so it cannot be tidied away. */
  test('an official pin is live regardless of the clock or a missing expiry', () => {
    const pinned = alert({ status: 'official', expiresAt: undefined });
    expect(accessAlertIsLive(pinned, JAN)).toBe(true);
    expect(accessAlertIsLive(pinned, JAN + 10 * ACCESS_ALERT_TTL_MS)).toBe(true);
    expect(accessAlertIsLive(pinned, SEASON_END + ACCESS_ALERT_TTL_MS)).toBe(true);
  });

  test('an active alert is live until its expiry passes', () => {
    const live = alert();
    expect(accessAlertIsLive(live, JAN + 1)).toBe(true);
    expect(accessAlertIsLive(live, JAN + ACCESS_ALERT_TTL_MS - 1)).toBe(true);
  });

  /**
   * The sweep's schedule must never be a visible behaviour: a row past its expiry stops annotating
   * the moment it is past, not the moment a cron happens to run.
   */
  test('an active row past its expiry is already dead before the sweep reaches it', () => {
    expect(accessAlertIsLive(alert(), JAN + ACCESS_ALERT_TTL_MS + 1)).toBe(false);
  });

  test.each(['expired', 'resolved', 'retracted'] as const)('a %s alert is never live', (status) => {
    expect(accessAlertIsLive(alert({ status, expiresAt: JAN + ACCESS_ALERT_TTL_MS }), JAN)).toBe(
      false,
    );
  });

  test('every status is covered by the liveness rule', () => {
    for (const status of ACCESS_ALERT_STATUSES) {
      expect(typeof accessAlertIsLive(alert({ status }), JAN)).toBe('boolean');
    }
  });
});

describe('deriveAccessAlertLifecycle', () => {
  test('with no votes the alert keeps its original clock', () => {
    const out = deriveAccessAlertLifecycle(alert(), [], SEASON_END);
    expect(out.status).toBe('active');
    expect(out.expiresAt).toBe(accessAlertExpiryFor(JAN, SEASON_END));
    expect(out.confirmCount).toBe(0);
    expect(out.denyCount).toBe(0);
  });

  test('a confirmation resets the clock from the observation, not the assertion', () => {
    const later = JAN + 20 * 24 * 60 * 60 * 1000;
    const out = deriveAccessAlertLifecycle(
      alert(),
      [vote('a', 'still_blocked', later)],
      SEASON_END,
    );
    expect(out.expiresAt).toBe(accessAlertExpiryFor(later, SEASON_END));
    expect(out.lastConfirmedAt).toBe(later);
    expect(out.confirmCount).toBe(1);
  });

  test('a long closure stays up all winter on rolling confirmations', () => {
    const day = 24 * 60 * 60 * 1000;
    let row = alert();
    const votes: AccessAlertVote[] = [];
    for (let i = 1; i <= 4; i++) {
      votes.push(vote(`skater-${i}`, 'still_blocked', JAN + i * 25 * day));
      const out = deriveAccessAlertLifecycle(row, votes, SEASON_END);
      row = { status: out.status, createdAt: row.createdAt, expiresAt: out.expiresAt };
      expect(accessAlertIsLive(row, JAN + i * 25 * day)).toBe(true);
    }
  });

  test('enough denials resolve it, and one is not enough', () => {
    const one = deriveAccessAlertLifecycle(alert(), [vote('a', 'open', JAN + 1)], SEASON_END);
    expect(one.status).toBe('active');

    const two = deriveAccessAlertLifecycle(
      alert(),
      [vote('a', 'open', JAN + 1), vote('b', 'open', JAN + 2)],
      SEASON_END,
    );
    expect(two.status).toBe('resolved');
    expect(two.denyCount).toBe(ACCESS_ALERT_RESOLVE_VOTES);
  });

  /** Distinct users' *latest* votes — the invariant that makes an offline replay idempotent. */
  test('one skater voting twice counts once, and the later verdict wins', () => {
    const out = deriveAccessAlertLifecycle(
      alert(),
      [vote('a', 'open', JAN + 1), vote('a', 'still_blocked', JAN + 2), vote('b', 'open', JAN + 3)],
      SEASON_END,
    );
    expect(out.denyCount).toBe(1);
    expect(out.confirmCount).toBe(1);
    expect(out.status).toBe('active');
  });

  test('replaying the same vote set changes nothing', () => {
    const votes = [vote('a', 'still_blocked', JAN + 5)];
    const first = deriveAccessAlertLifecycle(alert(), votes, SEASON_END);
    const second = deriveAccessAlertLifecycle(alert(), [...votes, ...votes], SEASON_END);
    expect(second).toEqual(first);
  });

  test.each(['official', 'retracted'] as const)('votes never move a %s alert', (status) => {
    const out = deriveAccessAlertLifecycle(
      alert({ status, expiresAt: undefined }),
      [vote('a', 'open', JAN + 1), vote('b', 'open', JAN + 2), vote('c', 'open', JAN + 3)],
      SEASON_END,
    );
    expect(out.status).toBe(status);
    expect(out.denyCount).toBe(3);
  });

  test('a confirmation revives an expired alert; silence leaves it expired', () => {
    const expired = alert({ status: 'expired' });
    expect(deriveAccessAlertLifecycle(expired, [], SEASON_END).status).toBe('expired');
    expect(
      deriveAccessAlertLifecycle(expired, [vote('a', 'still_blocked', JAN + 40)], SEASON_END)
        .status,
    ).toBe('active');
  });

  /**
   * The counts are reported for every status, including the settled ones — a moderator looking at a
   * pinned alert should still see that four people confirmed it.
   */
  test('counts are derived even when the status is immovable', () => {
    const out = deriveAccessAlertLifecycle(
      alert({ status: 'official', expiresAt: undefined }),
      [vote('a', 'still_blocked', JAN + 1), vote('b', 'still_blocked', JAN + 2)],
      SEASON_END,
    );
    expect(out.confirmCount).toBe(2);
    expect(out.lastConfirmedAt).toBe(JAN + 2);
    expect(out.expiresAt).toBeUndefined();
  });
});
