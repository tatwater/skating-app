import { describe, expect, it } from 'vitest';
import {
  PROD_CONVEX_DEPLOYMENT,
  PROFILE_REVEAL_ALL,
  profileRevealEnabled,
  REVEAL_MARKER,
  revealBelowQuorum,
  revealEmptySections,
  revealPlaceholder,
} from './profileReveal';

describe('profileRevealEnabled', () => {
  /**
   * The guard that makes the flag survivable. A flag whose only protection is "remember to turn it
   * off" is a flag that ships on — and the thing it would ship is a one-person opinion rendered as a
   * consensus mark, which is precisely what D86's quorum exists to prevent.
   */
  it('is OFF against production, whatever the constant says', () => {
    expect(profileRevealEnabled(`https://${PROD_CONVEX_DEPLOYMENT}.convex.cloud`)).toBe(false);
  });

  it('follows the constant everywhere else', () => {
    expect(profileRevealEnabled('https://agile-bee-397.convex.cloud')).toBe(PROFILE_REVEAL_ALL);
    expect(profileRevealEnabled(undefined)).toBe(PROFILE_REVEAL_ALL);
    expect(profileRevealEnabled('https://placeholder.convex.cloud')).toBe(PROFILE_REVEAL_ALL);
  });

  it('matches the prod deployment anywhere in the URL, not just as a prefix', () => {
    expect(profileRevealEnabled(`https://${PROD_CONVEX_DEPLOYMENT}.convex.site/http`)).toBe(false);
  });
});

describe('the two bypasses are separate', () => {
  /**
   * Separate predicates rather than one boolean, so a future change that wants empty sections shown
   * somewhere cannot silently acquire the below-quorum bypass with it. Greppable individually.
   */
  it('are distinct functions, both gated on the same input', () => {
    expect(revealEmptySections(true)).toBe(true);
    expect(revealBelowQuorum(true)).toBe(true);
    expect(revealEmptySections(false)).toBe(false);
    expect(revealBelowQuorum(false)).toBe(false);
  });
});

describe('revealPlaceholder', () => {
  it('names what is absent and marks itself as a dev artifact', () => {
    expect(revealPlaceholder('depth')).toBe(`No depth recorded ${REVEAL_MARKER}`);
  });

  it('carries the marker, so nothing revealed can be mistaken for real content', () => {
    expect(revealPlaceholder('forecast')).toContain(REVEAL_MARKER);
  });
});
