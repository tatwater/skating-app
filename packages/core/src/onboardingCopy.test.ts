import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_REFUSAL_CODES,
  ADDRESS_FIELD_COPY,
  CONSENT_RECORD_RETENTION,
  CONSENT_REFUSAL_FALLBACK,
  CONSENT_REFUSAL_MESSAGES,
  consentRefusalMessage,
  DATE_OF_BIRTH_MESSAGES,
  firstName,
  formatCardDay,
  formatVersionDay,
  isAccountRefusal,
  KNOW_BEFORE_YOU_GO_NAME,
  ONBOARDING_COPY,
  onboardingStepLabel,
  questionsLastAnswered,
  receiptLine,
  seasonCardLede,
  termsUnchangedSince,
} from './onboardingCopy';

/** Every string in a nested copy object. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const ALL = [
  ...strings(ONBOARDING_COPY),
  ONBOARDING_COPY.account.usernameTaken('ada_l'),
  ...strings(ADDRESS_FIELD_COPY),
  CONSENT_RECORD_RETENTION,
  ...Object.values(CONSENT_REFUSAL_MESSAGES),
  ...Object.values(DATE_OF_BIRTH_MESSAGES),
  CONSENT_REFUSAL_FALLBACK,
];

describe('the copy', () => {
  it('calls the questions Know Before You Go, in title case, wherever it names them', () => {
    expect(KNOW_BEFORE_YOU_GO_NAME).toBe('Know Before You Go');
    expect(ONBOARDING_COPY.next.kicker).toBe('Next: Know Before You Go');
    for (const s of ALL) expect(s).not.toMatch(/know before you go/);
    for (const s of ALL) expect(s.toLowerCase()).not.toContain('ground rules');
  });

  it('uses curly apostrophes, US spellings, and no decision numbers or section signs', () => {
    for (const s of ALL) {
      expect(s).not.toMatch(/'/);
      expect(s).not.toMatch(/\bD\d+\b|§/);
      expect(s).not.toMatch(/colour|recognis|organis|centre|licence/i);
    }
  });

  it('never says or implies the ice is safe (D3)', () => {
    for (const s of ALL) expect(s).not.toMatch(/\bsafe\b|good to go|skateable|all.clear/i);
  });

  it('has the agree line as drawn, with the Privacy Notice as its link', () => {
    const { before, link, after } = ONBOARDING_COPY.terms.agree;
    expect(`${before}${link}${after}`).toBe(
      'I have read and agree to the Terms of Use and the Privacy Notice.',
    );
  });

  it('numbers the five steps', () => {
    expect(onboardingStepLabel(2)).toBe('2 of 5');
    expect(
      [
        ONBOARDING_COPY.account,
        ONBOARDING_COPY.terms,
        ONBOARDING_COPY.questions,
        ONBOARDING_COPY.home,
        ONBOARDING_COPY.profile,
      ].map((s) => s.step),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the season card', () => {
  it('greets by first name, or without one', () => {
    expect(firstName('  Kate  Donovan ')).toBe('Kate');
    expect(firstName('')).toBe('');
    expect(seasonCardLede('Kate Donovan')).toBe(
      'Welcome back, Kate. Every skater answers the same seven questions at the start of each winter. You know these, and it takes about a minute.',
    );
    expect(seasonCardLede(' ')).toMatch(/^Welcome back\. Every skater/);
  });

  it('dates the terms row from the version, as a calendar date', () => {
    expect(formatVersionDay('2026-11-16')).toBe('Nov 16, 2026');
    expect(termsUnchangedSince('2026-11-24')).toBe('Unchanged since Nov 24, 2026');
    expect(() => formatVersionDay('Nov 16')).toThrow();
  });

  it('dates the questions row in the skater’s own zone', () => {
    // 03:00 UTC on 17 November is still the 16th in New York.
    const at = Date.UTC(2026, 10, 17, 3);
    expect(questionsLastAnswered(at, 'America/New_York')).toBe('Last answered Nov 16, 2026');
    expect(formatCardDay(at, 'UTC')).toBe('Nov 17, 2026');
  });
});

describe('receiptLine', () => {
  it('shows the sent-to line while the copy is pending or sent', () => {
    for (const copy of ['pending', 'sent'] as const) {
      expect(receiptLine(copy, 'kate@example.com')).toEqual({
        kind: 'sent',
        before: 'A copy of the terms you accepted has been sent to ',
        email: 'kate@example.com',
        after: '.',
      });
    }
  });

  it('says so when the copy is known not to have gone, or there is no address', () => {
    const notSent = { kind: 'not_sent', text: ONBOARDING_COPY.receipt.notSent };
    expect(receiptLine('not_sent', 'kate@example.com')).toEqual(notSent);
    expect(receiptLine('sent', null)).toEqual(notSent);
    expect(receiptLine('pending', '')).toEqual(notSent);
  });
});

describe('consentRefusalMessage', () => {
  it('has words for every code, and a fallback for one it does not know', () => {
    expect(consentRefusalMessage('terms_not_read')).toBe(CONSENT_REFUSAL_MESSAGES.terms_not_read);
    expect(consentRefusalMessage('underage')).toBe('You must be at least 18 to use Gli.');
    expect(consentRefusalMessage('something_new')).toBe(CONSENT_REFUSAL_FALLBACK);
    expect(consentRefusalMessage('toString')).toBe(CONSENT_REFUSAL_FALLBACK);
    expect(consentRefusalMessage(undefined)).toBe(CONSENT_REFUSAL_FALLBACK);
  });

  it('states the username rule with the real limits', () => {
    expect(CONSENT_REFUSAL_MESSAGES.username_invalid).toBe(
      'Use 3 to 30 letters, numbers, and underscores, starting and ending with a letter or number.',
    );
    expect(CONSENT_REFUSAL_MESSAGES.name_invalid).toContain('50');
  });
});

describe('the lines both apps share beyond the boards', () => {
  it('names the taken handle the one way', () => {
    expect(ONBOARDING_COPY.account.usernameTaken('ada_l')).toBe(
      '@ada_l is taken. Try another one.',
    );
  });

  it('says what the record keeps, for six years past the deletion, and then that it goes (D297)', () => {
    for (const fact of [
      'six years after your account is deleted',
      'name, email, and date of birth you gave',
      'which terms you accepted and when',
      'when you answered Know Before You Go',
      'we delete it too',
      'Privacy Notice',
    ]) {
      expect(CONSENT_RECORD_RETENTION).toContain(fact);
    }
  });
});

describe('isAccountRefusal', () => {
  it('sends the Account fields’ refusals back to the Account step, and nothing else', () => {
    for (const code of ACCOUNT_REFUSAL_CODES) expect(isAccountRefusal(code)).toBe(true);
    expect([...ACCOUNT_REFUSAL_CODES].sort()).toEqual(
      [
        'account_required',
        'name_invalid',
        'underage',
        'username_cooldown',
        'username_invalid',
        'username_taken',
      ].sort(),
    );
    for (const code of Object.keys(CONSENT_REFUSAL_MESSAGES)) {
      if (!ACCOUNT_REFUSAL_CODES.has(code as never)) expect(isAccountRefusal(code)).toBe(false);
    }
    expect(isAccountRefusal(null)).toBe(false);
    expect(isAccountRefusal(undefined)).toBe(false);
    expect(isAccountRefusal('something_new')).toBe(false);
  });
});
