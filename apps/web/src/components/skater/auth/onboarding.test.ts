import { isValidUsername } from '@skating/core';
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { classifyUpsertError, suggestUsernames, usernameNeedsFixing } from './onboarding';

describe('classifyUpsertError', () => {
  it('draws the two username refusals in the field', () => {
    expect(classifyUpsertError(new ConvexError('Username is already taken'))).toEqual({
      kind: 'taken',
    });
    expect(
      classifyUpsertError(
        new ConvexError('Username must be 3–30 characters: letters, numbers, or underscores'),
      ),
    ).toEqual({ kind: 'badname' });
  });

  it('says any other refusal as the server put it', () => {
    expect(classifyUpsertError(new ConvexError('You must be at least 16 years old'))).toEqual({
      kind: 'message',
      message: 'You must be at least 16 years old',
    });
  });

  it('gives anything that is not a ConvexError the generic line, never its text', () => {
    expect(
      classifyUpsertError(new Error('[CONVEX M(profiles:upsertFromClerk)] Server Error')),
    ).toEqual({
      kind: 'message',
      message: 'Could not finish setting up your profile',
    });
  });
});

describe('usernameNeedsFixing', () => {
  it('flags a character that can never be in a username at once', () => {
    expect(usernameNeedsFixing('kate.d', false)).toBe(true);
    expect(usernameNeedsFixing('_kate', false)).toBe(true);
  });

  it('waits until the field is left for too short or a trailing underscore', () => {
    expect(usernameNeedsFixing('ka', false)).toBe(false);
    expect(usernameNeedsFixing('kate_', false)).toBe(false);
    expect(usernameNeedsFixing('ka', true)).toBe(true);
    expect(usernameNeedsFixing('kate_', true)).toBe(true);
  });

  it('never flags an empty field or a good one, and case does not count', () => {
    expect(usernameNeedsFixing('', true)).toBe(false);
    expect(usernameNeedsFixing('  ', true)).toBe(false);
    expect(usernameNeedsFixing('KDonovan', true)).toBe(false);
  });

  it('flags one past the length limit while typing', () => {
    expect(usernameNeedsFixing('a'.repeat(31), false)).toBe(true);
  });
});

describe('suggestUsernames', () => {
  it('offers the name run together, with an underscore, and the handle numbered', () => {
    expect(suggestUsernames('kdonovan', 'Kate Donovan')).toEqual([
      'katedonovan',
      'kate_donovan',
      'kdonovan2',
    ]);
  });

  it('falls back to the handle alone when the name gives nothing', () => {
    expect(suggestUsernames('kdonovan', '')).toEqual(['kdonovan2', 'kdonovan3', 'kdonovan_gli']);
    expect(suggestUsernames('kd', '李')).toEqual(['kd2', 'kd3', 'kd_gli']);
  });

  it.each([
    ['kdonovan', 'Kate Donovan'],
    ['a_b', 'A'],
    ['abc', 'Ab'],
    ['x'.repeat(29), 'Someone With A Very Long Name Indeed Longer Than Thirty'],
    ['kate9', '   '],
    ['zz', 'Zoë Ó Briain-Smith'],
  ])('only ever offers allowed handles other than %s, at most three', (taken, name) => {
    const offered = suggestUsernames(taken, name);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered).not.toContain(taken);
    for (const handle of offered) expect(isValidUsername(handle)).toBe(true);
  });
});
