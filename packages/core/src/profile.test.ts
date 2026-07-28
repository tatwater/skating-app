import { describe, expect, it } from 'vitest';
import {
  BIO_MAX_LENGTH,
  canSetProfilePublic,
  DATA_EXPORT_TTL_DAYS,
  DELETION_GRACE_DAYS,
  DEPARTED_CONTENT_MAX_AGE_DAYS,
  DISPLAY_NAME_MAX_LENGTH,
  isValidBio,
  isValidDisplayName,
  isValidTownLabel,
  isValidUsername,
  normalizeBio,
  normalizeDisplayName,
  normalizeTownLabel,
  normalizeUsername,
  TOWN_LABEL_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from './profile';

describe('normalizeUsername', () => {
  it('trims and lowercases so handles are case-insensitive', () => {
    expect(normalizeUsername('  Ada  ')).toBe('ada');
    expect(normalizeUsername('ADA_99')).toBe('ada_99');
  });
});

describe('isValidUsername', () => {
  it('accepts a well-formed normalized handle', () => {
    expect(isValidUsername('ada')).toBe(true);
    expect(isValidUsername('ada_lovelace99')).toBe(true);
    expect(isValidUsername('a'.repeat(USERNAME_MIN_LENGTH))).toBe(true);
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
  });

  it('rejects out-of-bounds lengths', () => {
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects disallowed characters and edge underscores', () => {
    expect(isValidUsername('ada lovelace')).toBe(false); // space
    expect(isValidUsername('adá')).toBe(false); // non-ascii
    expect(isValidUsername('Ada')).toBe(false); // uppercase (not normalized)
    expect(isValidUsername('_ada')).toBe(false); // leading underscore
    expect(isValidUsername('ada_')).toBe(false); // trailing underscore
    expect(isValidUsername('___')).toBe(false); // all underscores
  });
});

describe('normalizeDisplayName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeDisplayName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(normalizeDisplayName('Ada')).toBe('Ada');
  });
});

describe('isValidDisplayName', () => {
  it('accepts any non-empty name within bounds', () => {
    expect(isValidDisplayName('A')).toBe(true);
    expect(isValidDisplayName('Ada Lovelace')).toBe(true);
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH))).toBe(true);
  });

  it('rejects an empty name or one past the length bound', () => {
    expect(isValidDisplayName('')).toBe(false);
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('normalizeBio / isValidBio', () => {
  it('trims outer whitespace, preserving inner formatting', () => {
    expect(normalizeBio('  loves black ice\n\nADK ')).toBe('loves black ice\n\nADK');
  });

  it('allows an empty bio (optional) and rejects over-long', () => {
    expect(isValidBio('')).toBe(true);
    expect(isValidBio('a'.repeat(BIO_MAX_LENGTH))).toBe(true);
    expect(isValidBio('a'.repeat(BIO_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('normalizeTownLabel / isValidTownLabel', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeTownLabel('  Norwich,   VT ')).toBe('Norwich, VT');
  });

  it('allows an empty label (optional) and rejects over-long', () => {
    expect(isValidTownLabel('')).toBe(true);
    expect(isValidTownLabel('a'.repeat(TOWN_LABEL_MAX_LENGTH))).toBe(true);
    expect(isValidTownLabel('a'.repeat(TOWN_LABEL_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('canSetProfilePublic (minors forced private, D13/D41)', () => {
  const now = Date.UTC(2026, 0, 1);
  const yearsAgo = (n: number) => Date.UTC(2026 - n, 0, 1);

  it('lets an adult go public', () => {
    expect(canSetProfilePublic(yearsAgo(20), now)).toBe(true);
    expect(canSetProfilePublic(yearsAgo(18), now)).toBe(true);
  });

  it('forbids a minor going public', () => {
    expect(canSetProfilePublic(yearsAgo(16), now)).toBe(false);
    expect(canSetProfilePublic(yearsAgo(17), now)).toBe(false);
  });
});

/**
 * Three deletion windows that all read "30 days" in the copy and are three independent numbers in the
 * code. These assertions exist so that changing one is a deliberate act with a failing test attached,
 * rather than a quiet behavior change nobody notices — which is precisely how the shipped bugs in this
 * area happened.
 */
describe('deletion window invariants (D62)', () => {
  it('keeps the ghost-window sweep reachable: content age <= grace', () => {
    // Above the grace period no sweep tick ever finds anything due, so every account would reach
    // finalization with its prose intact and the promise in LEAVING_PROFILE_NOTICE — "deleted once
    // they're 30 days old" — would only be kept at the very end. Finalization itself is unconditional
    // (`lib/contentPurge`'s `final` mode), so this bounds *when*, never *whether*.
    expect(DEPARTED_CONTENT_MAX_AGE_DAYS).toBeLessThanOrEqual(DELETION_GRACE_DAYS);
  });

  it('keeps an export fetchable for as long as the account that could fetch it', () => {
    // A bundle whose TTL expired before finalization is one the person can no longer reach by any
    // route: `myExports` needs a sign-in, and after day 30 there isn't one. Founder call 2026-07-27,
    // and the reason the TTL moved from 7 days to 30.
    expect(DATA_EXPORT_TTL_DAYS).toBeGreaterThanOrEqual(DELETION_GRACE_DAYS);
  });
});
