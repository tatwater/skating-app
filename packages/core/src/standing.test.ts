import { describe, expect, test } from 'vitest';
import { MIN_VISIBLE_ZOOM_FLOOR, minVisibleZoomFor } from './display';
import { seasonStartMs } from './season';
import {
  DORMANT_MIN_VISIBLE_ZOOM,
  describeStanding,
  INACTIVE_SEASONS,
  inactivityCutoffMs,
  isActive,
  isReachable,
  reactivatesOnEvidence,
  retainsActive,
  type StandingInput,
  standingOf,
  standingReasonLabel,
} from './standing';

const T = Date.parse('2026-09-16T12:00:00Z');
const clean = (extra: Partial<StandingInput> = {}): StandingInput => ({
  dedupStatus: 'clean',
  ...extra,
});

describe('standingOf — one precedence order', () => {
  test('a plain canonical body is active', () => {
    expect(standingOf(clean())).toEqual({ standing: 'active' });
    expect(isActive(clean())).toBe(true);
    expect(isReachable(clean())).toBe(true);
  });

  test('pending / approved user bodies and dedup suspects are active (D37 auto-visible)', () => {
    expect(standingOf(clean({ reviewStatus: 'pending' })).standing).toBe('active');
    expect(standingOf(clean({ reviewStatus: 'approved' })).standing).toBe('active');
    expect(standingOf(clean({ dedupStatus: 'near_certain' })).standing).toBe('active');
  });

  test('rejected and merged are unlisted — no standing of their own', () => {
    expect(standingOf(clean({ reviewStatus: 'rejected' }))).toEqual({ standing: 'unlisted' });
    expect(standingOf({ dedupStatus: 'merged' })).toEqual({ standing: 'unlisted' });
    expect(isReachable({ dedupStatus: 'merged' })).toBe(false);
  });

  test('removed carries its D48 reason and outranks everything below it', () => {
    const body = clean({
      removedAt: T,
      removalReason: 'landowner_request',
      publicAccess: { verdict: 'none', decidedAt: T - 1 },
      dormant: { since: T - 2, reason: 'inactive' },
    });
    expect(standingOf(body)).toEqual({
      standing: 'removed',
      since: T,
      reason: 'landowner_request',
    });
  });

  test('a removal with no recorded reason reads as “other” rather than throwing', () => {
    expect(standingOf(clean({ removedAt: T }))).toEqual({
      standing: 'removed',
      since: T,
      reason: 'other',
    });
  });

  test('unlisted outranks removed — a merged row is not “removed”, reads follow the survivor', () => {
    expect(standingOf({ dedupStatus: 'merged', removedAt: T })).toEqual({ standing: 'unlisted' });
  });

  test('a `none` ruling is dormancy, and outranks the stored dormant reason', () => {
    const body = clean({
      publicAccess: { verdict: 'none', decidedAt: T },
      dormant: { since: T - 5, reason: 'inactive' },
    });
    expect(standingOf(body)).toEqual({ standing: 'dormant', since: T, reason: 'no_public_access' });
    expect(isActive(body)).toBe(false);
    expect(isReachable(body)).toBe(true);
  });

  test('an `open` ruling is not dormancy', () => {
    expect(standingOf(clean({ publicAccess: { verdict: 'open', decidedAt: T } })).standing).toBe(
      'active',
    );
  });

  test('the stored dormant field carries its reason and note', () => {
    const body = clean({ dormant: { since: T, reason: 'moderator', note: 'Drained in 2024' } });
    expect(standingOf(body)).toEqual({
      standing: 'dormant',
      since: T,
      reason: 'moderator',
      note: 'Drained in 2024',
    });
  });
});

describe('reactivatesOnEvidence — machines undo machines, people undo people', () => {
  test('inactive and not_in_campaign come back on a report or a track', () => {
    expect(reactivatesOnEvidence(clean({ dormant: { since: T, reason: 'inactive' } }))).toBe(true);
    expect(reactivatesOnEvidence(clean({ dormant: { since: T, reason: 'not_in_campaign' } }))).toBe(
      true,
    );
  });

  test('a moderator dormancy, a `none` ruling and a removal do not', () => {
    expect(reactivatesOnEvidence(clean({ dormant: { since: T, reason: 'moderator' } }))).toBe(
      false,
    );
    expect(reactivatesOnEvidence(clean({ publicAccess: { verdict: 'none', decidedAt: T } }))).toBe(
      false,
    );
    expect(reactivatesOnEvidence(clean({ removedAt: T }))).toBe(false);
  });

  test('an active body has nothing to reactivate', () => {
    expect(reactivatesOnEvidence(clean())).toBe(false);
  });
});

describe('the dormant rung', () => {
  test('sits past the D49 floor, so browsing never reaches it', () => {
    expect(DORMANT_MIN_VISIBLE_ZOOM).toBeGreaterThan(MIN_VISIBLE_ZOOM_FLOOR);
  });

  test('minVisibleZoomFor: active bodies keep their scored bucket, others land on the rung', () => {
    expect(minVisibleZoomFor(1, true)).toBeLessThan(MIN_VISIBLE_ZOOM_FLOOR);
    expect(minVisibleZoomFor(0, true)).toBe(MIN_VISIBLE_ZOOM_FLOOR);
    expect(minVisibleZoomFor(1, false)).toBe(DORMANT_MIN_VISIBLE_ZOOM);
    expect(minVisibleZoomFor(0, false)).toBe(DORMANT_MIN_VISIBLE_ZOOM);
  });
});

describe('the retention rule', () => {
  const season = 2029; // the rollover into '29/'30 looks back at '26/'27 … '28/'29

  test('the cutoff is the start of the season INACTIVE_SEASONS back', () => {
    expect(INACTIVE_SEASONS).toBe(3);
    expect(inactivityCutoffMs(season)).toBe(seasonStartMs(2026));
  });

  test('activity inside the window retains; at the cutoff retains; before it does not', () => {
    const cutoff = inactivityCutoffMs(season);
    expect(retainsActive({ lastActivityAt: cutoff, favorited: false }, season)).toBe(true);
    expect(retainsActive({ lastActivityAt: cutoff + 1, favorited: false }, season)).toBe(true);
    expect(retainsActive({ lastActivityAt: cutoff - 1, favorited: false }, season)).toBe(false);
  });

  test('never skated does not retain', () => {
    expect(retainsActive({ favorited: false }, season)).toBe(false);
  });

  test('a positive curated boost or any favorite retains regardless of activity', () => {
    expect(retainsActive({ curatedBoost: 0.3, favorited: false }, season)).toBe(true);
    expect(retainsActive({ favorited: true }, season)).toBe(true);
  });

  test('a zero or negative boost is not a decision to keep', () => {
    expect(retainsActive({ curatedBoost: 0, favorited: false }, season)).toBe(false);
    expect(retainsActive({ curatedBoost: -0.2, favorited: false }, season)).toBe(false);
  });
});

describe('copy', () => {
  test('active has nothing to explain', () => {
    expect(describeStanding({ standing: 'active' })).toBeNull();
  });

  test('each dormancy reason gets a plain sentence', () => {
    expect(describeStanding({ standing: 'dormant', since: T, reason: 'inactive' })).toBe(
      'No one has reported skating here in the last 3 seasons, so it isn’t on the active map.',
    );
    expect(describeStanding({ standing: 'dormant', since: T, reason: 'not_in_campaign' })).toBe(
      'This water no longer meets the size and type rules for the active map.',
    );
    expect(describeStanding({ standing: 'dormant', since: T, reason: 'no_public_access' })).toBe(
      'A moderator found no public access, so it isn’t on the active map.',
    );
  });

  test('a moderator dormancy shows the note when there is one', () => {
    expect(describeStanding({ standing: 'dormant', since: T, reason: 'moderator' })).toBe(
      'A moderator set this lake inactive.',
    );
    expect(
      describeStanding({ standing: 'dormant', since: T, reason: 'moderator', note: 'Drained' }),
    ).toBe('A moderator set this lake inactive: Drained');
  });

  test('a removal names its reason — including a landowner request (founder call)', () => {
    expect(describeStanding({ standing: 'removed', since: T, reason: 'landowner_request' })).toBe(
      'Removed from the map at the landowner’s request.',
    );
    expect(describeStanding({ standing: 'removed', since: T, reason: 'duplicate' })).toBe(
      'Removed from the map as a duplicate of another lake.',
    );
  });

  test('every reason has an admin label', () => {
    for (const reason of [
      'inactive',
      'not_in_campaign',
      'moderator',
      'no_public_access',
      'landowner_request',
      'unskateable',
      'junk',
      'duplicate',
      'other',
    ] as const) {
      expect(standingReasonLabel(reason).length).toBeGreaterThan(0);
    }
  });
});
