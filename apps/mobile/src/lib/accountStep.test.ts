import {
  CONSENT_REFUSAL_MESSAGES,
  DATE_OF_BIRTH_MESSAGES,
  DISPLAY_NAME_MAX_LENGTH,
  normalizeUsername,
  ONBOARDING_COPY,
} from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  type AccountDraft,
  accountStepView,
  digitsOnly,
  EMPTY_ACCOUNT_DRAFT,
  usernameField,
  usernameQuery,
} from './accountStep';

// Pinned (D243): 24 November 2026, noon UTC.
const NOW = Date.UTC(2026, 10, 24, 12);
const none = new Set<string>();

describe('usernameField', () => {
  it('says nothing for an empty field, and waits while typing', () => {
    expect(usernameField('', '', undefined, none)).toBe('empty');
    expect(usernameField('   ', '   ', undefined, none)).toBe('empty');
    expect(usernameField('kdono', 'kdon', undefined, none)).toBe('checking');
  });

  it('calls a malformed name out once the typing pauses', () => {
    expect(usernameField('ab', 'ab', undefined, none)).toBe('invalid');
    expect(usernameField('_kate', '_kate', undefined, none)).toBe('invalid');
  });

  it('reads the check for this exact name only', () => {
    const check = { username: 'kdonovan', available: true };
    expect(usernameField('KDonovan ', 'KDonovan ', check, none)).toBe('available');
    expect(usernameField('kdonovan2', 'kdonovan2', check, none)).toBe('checking');
    expect(usernameField('kdonovan', 'kdonovan', undefined, none)).toBe('checking');
    expect(
      usernameField('kdonovan', 'kdonovan', { ...check, available: false, reason: 'taken' }, none),
    ).toBe('taken');
    expect(
      usernameField(
        'kdonovan',
        'kdonovan',
        { ...check, available: false, reason: 'invalid' },
        none,
      ),
    ).toBe('invalid');
    expect(usernameField('kdonovan', 'kdonovan', { ...check, current: true }, none)).toBe(
      'available',
    );
  });

  it('remembers a name an acceptance was refused for, ahead of the live check', () => {
    const check = { username: 'kdonovan', available: true };
    expect(usernameField('kdonovan', 'kdonovan', check, new Set(['kdonovan']))).toBe('taken');
  });
});

describe('usernameQuery', () => {
  it('asks only about a well-formed name, in its stored form', () => {
    expect(usernameQuery('')).toBeNull();
    expect(usernameQuery('ab')).toBeNull();
    expect(usernameQuery(' KDonovan ')).toBe('kdonovan');
  });
});

describe('accountStepView', () => {
  const kate: AccountDraft = {
    displayName: '  Kate   Donovan ',
    username: 'KDonovan',
    dob: { month: 11, day: '2', year: '1988' },
  };

  it('composes the account when every field is right', () => {
    const view = accountStepView(kate, 'available', NOW);
    expect(view.messages).toEqual({});
    expect(view.account).toEqual({
      displayName: 'Kate Donovan',
      username: 'kdonovan',
      dateOfBirth: Date.UTC(1988, 10, 2),
    });
  });

  it('is silent and off for an empty form', () => {
    const view = accountStepView(EMPTY_ACCOUNT_DRAFT, 'empty', NOW);
    expect(view.messages).toEqual({});
    expect(view.account).toBeNull();
    expect(view.dob).toBe('incomplete');
  });

  it('says under 18 in amber and keeps Continue off (board 11.2)', () => {
    const view = accountStepView(
      { ...kate, dob: { month: 3, day: '14', year: '2010' } },
      'available',
      NOW,
    );
    expect(view.dob).toBe('underage');
    expect(view.messages.dob).toBe(DATE_OF_BIRTH_MESSAGES.underage);
    expect(view.account).toBeNull();
  });

  it('turns 18 on the birthday itself, at the pinned clock', () => {
    const view = accountStepView(
      { ...kate, dob: { month: 11, day: '24', year: '2008' } },
      'available',
      NOW,
    );
    expect(view.dob).toBeNull();
    expect(view.account).not.toBeNull();
    const dayBefore = accountStepView(
      { ...kate, dob: { month: 11, day: '25', year: '2008' } },
      'available',
      NOW,
    );
    expect(dayBefore.dob).toBe('underage');
  });

  it('calls out an impossible date', () => {
    const view = accountStepView(
      { ...kate, dob: { month: 2, day: '31', year: '1990' } },
      'available',
      NOW,
    );
    expect(view.messages.dob).toBe(DATE_OF_BIRTH_MESSAGES.invalid);
  });

  it('says what is wrong with the username, and holds Continue until it is free', () => {
    expect(accountStepView(kate, 'invalid', NOW).messages.username).toBe(
      CONSENT_REFUSAL_MESSAGES.username_invalid,
    );
    expect(accountStepView(kate, 'taken', NOW).messages.username).toBe(
      ONBOARDING_COPY.account.usernameTaken(normalizeUsername(kate.username)),
    );
    expect(accountStepView(kate, 'checking', NOW).account).toBeNull();
  });

  it('calls out a name too long to store', () => {
    const view = accountStepView(
      { ...kate, displayName: 'K'.repeat(DISPLAY_NAME_MAX_LENGTH + 1) },
      'available',
      NOW,
    );
    expect(view.nameOk).toBe(false);
    expect(view.messages.name).toBe(CONSENT_REFUSAL_MESSAGES.name_invalid);
    expect(view.account).toBeNull();
  });
});

describe('digitsOnly', () => {
  it('keeps digits up to the length', () => {
    expect(digitsOnly('1a9-8 8x', 4)).toBe('1988');
    expect(digitsOnly('123', 2)).toBe('12');
  });
});
