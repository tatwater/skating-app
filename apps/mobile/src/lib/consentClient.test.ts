import { CONSENT_REFUSAL_FALLBACK, CONSENT_REFUSAL_MESSAGES } from '@skating/core';
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { appUserAgent, consentSurface, readRefusal } from './consentClient';

describe('consentSurface', () => {
  it('names the two phones', () => {
    expect(consentSurface('ios')).toBe('ios');
    expect(consentSurface('android')).toBe('android');
    expect(consentSurface('windows')).toBe('android');
  });
});

describe('appUserAgent', () => {
  it('says the app, its version and the OS, nothing more', () => {
    expect(appUserAgent('android', 35, '0.0.1')).toBe('Gli/0.0.1 (android 35)');
    expect(appUserAgent('ios', '18.2', '1.2.0')).toBe('Gli/1.2.0 (ios 18.2)');
  });
});

describe('readRefusal', () => {
  it('shows a consent refusal’s own message and keeps its code', () => {
    const e = new ConvexError({ code: 'username_taken', message: 'Taken, sorry.' });
    expect(readRefusal(e)).toEqual({ code: 'username_taken', message: 'Taken, sorry.' });
  });

  it('falls back to core’s words when the message is missing or blank', () => {
    expect(readRefusal(new ConvexError({ code: 'terms_not_read' }))).toEqual({
      code: 'terms_not_read',
      message: CONSENT_REFUSAL_MESSAGES.terms_not_read,
    });
    expect(readRefusal(new ConvexError({ code: 'terms_changed', message: ' ' })).message).toBe(
      CONSENT_REFUSAL_MESSAGES.terms_changed,
    );
    expect(readRefusal(new ConvexError({ code: 'brand_new_code' })).message).toBe(
      CONSENT_REFUSAL_FALLBACK,
    );
    expect(readRefusal(new ConvexError({ message: 42 }))).toEqual({
      code: null,
      message: CONSENT_REFUSAL_FALLBACK,
    });
  });

  it('carries the cooldown’s unlock time', () => {
    const e = new ConvexError({ code: 'username_cooldown', message: 'Later.', unlocksAt: 1234 });
    expect(readRefusal(e)).toEqual({
      code: 'username_cooldown',
      message: 'Later.',
      unlocksAt: 1234,
    });
  });

  it('shows a profile gate’s sentence, but not a lapsed session’s', () => {
    expect(readRefusal(new ConvexError('Account is suspended'))).toEqual({
      code: null,
      message: 'Account is suspended',
    });
    expect(readRefusal(new ConvexError('Not authenticated')).message).toBe(
      CONSENT_REFUSAL_FALLBACK,
    );
  });

  it('never shows a non-Convex error’s text', () => {
    expect(readRefusal(new Error('fetch failed: ECONNRESET')).message).toBe(
      CONSENT_REFUSAL_FALLBACK,
    );
    expect(readRefusal(undefined).message).toBe(CONSENT_REFUSAL_FALLBACK);
    expect(readRefusal(new ConvexError(null as unknown as string)).message).toBe(
      CONSENT_REFUSAL_FALLBACK,
    );
  });
});
