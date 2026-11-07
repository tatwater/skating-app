import { describe, expect, it } from 'vitest';
import {
  type AuthFailure,
  classifyClerkError,
  FAILURE_COPY,
  failurePlace,
  formatCooldown,
  isPlausibleEmail,
  ticketFromSearch,
  withoutTicket,
} from './authFlow';

const FAILURES = Object.keys(FAILURE_COPY) as AuthFailure[];

describe('classifyClerkError', () => {
  it.each([
    [{ errors: [{ code: 'form_identifier_not_found' }] }, 'unknown_email'],
    [{ errors: [{ code: 'form_identifier_exists' }] }, 'email_taken'],
    [{ errors: [{ code: 'form_code_incorrect' }] }, 'wrong_code'],
    [{ errors: [{ code: 'verification_expired' }] }, 'expired_code'],
    [{ errors: [{ code: 'verification_failed' }] }, 'too_many_tries'],
    [{ errors: [{ code: 'too_many_requests' }] }, 'rate_limited'],
    [{ errors: [{ code: 'captcha_invalid' }] }, 'captcha'],
    [{ errors: [{ code: 'verification_already_verified' }] }, 'incomplete'],
    [{ code: 'form_param_format_invalid' }, 'invalid_email'],
  ] as const)('reads the code off %j', (error, failure) => {
    expect(classifyClerkError(error)).toBe(failure);
  });

  it.each([
    null,
    undefined,
    'form_code_incorrect',
    new Error('network'),
    { errors: [] },
    { errors: [null] },
    { errors: [{ code: 42 }] },
    { code: 'something_new' },
    // An inherited key is not a known code.
    { code: 'toString' },
  ])('calls anything else unreachable: %j', (error) => {
    expect(classifyClerkError(error)).toBe('unreachable');
  });

  it('never says anything an error carried: every outcome is a constant from the vocabulary', () => {
    const email = ['kate', 'example.com'].join('@');
    const codes = [...Object.keys(FAILURE_COPY), 'form_code_incorrect', 'x', '', email];
    for (const code of codes) {
      const failure = classifyClerkError({
        errors: [{ code, message: `${code} for ${email}`, meta: { emailAddress: email } }],
      });
      expect(FAILURES).toContain(failure);
      expect(FAILURE_COPY[failure]).not.toContain(email);
    }
  });
});

describe('failurePlace', () => {
  it('puts each failure under its field, or on its own line', () => {
    expect(failurePlace('unknown_email')).toBe('email');
    expect(failurePlace('email_taken')).toBe('email');
    expect(failurePlace('invalid_email')).toBe('email');
    expect(failurePlace('wrong_code')).toBe('code');
    expect(failurePlace('expired_code')).toBe('code');
    expect(failurePlace('too_many_tries')).toBe('code');
    for (const f of ['rate_limited', 'captcha', 'incomplete', 'ticket', 'unreachable'] as const) {
      expect(failurePlace(f)).toBe('form');
    }
  });
});

describe('the copy', () => {
  it('says nothing about the ice (D3) and uses the boards’ words for the wrong code', () => {
    expect(FAILURE_COPY.wrong_code).toBe(
      'That code doesn’t match. Check the newest email from Gli, or send a new code.',
    );
    for (const line of Object.values(FAILURE_COPY)) {
      expect(line).not.toMatch(/\bsafe\b|skateable|good to go|all clear/i);
    }
  });
});

describe('isPlausibleEmail', () => {
  it.each(['kate@example.com', '  kate.d+gli@mail.example.org  '])('takes %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(true);
  });
  it.each(['', 'kate', 'kate@', 'kate@example', 'ka te@example.com', '@example.com'])(
    'waits on %j',
    (email) => {
      expect(isPlausibleEmail(email)).toBe(false);
    },
  );
});

describe('formatCooldown', () => {
  it('reads as a clock', () => {
    expect(formatCooldown(30)).toBe('0:30');
    expect(formatCooldown(4)).toBe('0:04');
    expect(formatCooldown(75)).toBe('1:15');
  });
});

describe('the sign-in token', () => {
  it('is read off the query, and absent when there is none or it is empty', () => {
    expect(ticketFromSearch('?__clerk_ticket=tok_1')).toBe('tok_1');
    expect(ticketFromSearch('?a=1&__clerk_ticket=tok_2')).toBe('tok_2');
    expect(ticketFromSearch('')).toBeNull();
    expect(ticketFromSearch('?__clerk_ticket=')).toBeNull();
  });

  it('is dropped from the URL, keeping everything else', () => {
    expect(withoutTicket({ pathname: '/sign-in', search: '?__clerk_ticket=t', hash: '' })).toBe(
      '/sign-in',
    );
    expect(
      withoutTicket({ pathname: '/sign-in', search: '?a=1&__clerk_ticket=t', hash: '#x' }),
    ).toBe('/sign-in?a=1#x');
  });
});
