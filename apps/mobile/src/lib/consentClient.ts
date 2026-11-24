/**
 * What the phone tells the consent functions about itself, and how it reads their refusals (B03
 * §9.5). Pure, so the rules are tested without a device.
 */

import { CONSENT_REFUSAL_FALLBACK, consentRefusalMessage } from '@skating/core';
import { ConvexError } from 'convex/values';

/** The record's client-reported surface. The phone is one of two; anything else reads as Android. */
export function consentSurface(os: string): 'android' | 'ios' {
  return os === 'ios' ? 'ios' : 'android';
}

/**
 * An honest, short description of this app for the record's `userAgent` (stored labeled as
 * client-reported): "Gli/0.0.1 (android 35)". No device model, nothing that names the person.
 */
export function appUserAgent(os: string, osVersion: string | number, appVersion: string): string {
  return `Gli/${appVersion} (${os} ${osVersion})`;
}

/** A refusal as the toast needs it: its code, when it has one, and its words. */
export interface Refusal {
  code: string | null;
  message: string;
  /** `username_cooldown` only: when a rename is allowed again. */
  unlocksAt?: number;
}

const UNSHOWN = new Set(['Not authenticated']);

/**
 * The toast's words for anything a mutation threw. The consent functions send
 * `ConvexError({ code, message })` and the message is shown; a code with no message falls back to
 * core's words. A plain-string `ConvexError` (the profile gate's "Account is suspended") is already
 * a sentence for a person, and is shown as it is — except "Not authenticated", which only means the
 * session lapsed mid-call. Anything else (a network failure, a server bug) gets the fallback: its
 * text is for logs, not people.
 */
export function readRefusal(error: unknown): Refusal {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === 'string') {
      return { code: null, message: UNSHOWN.has(data) ? CONSENT_REFUSAL_FALLBACK : data };
    }
    if (data !== null && typeof data === 'object') {
      const { code, message, unlocksAt } = data as {
        code?: unknown;
        message?: unknown;
        unlocksAt?: unknown;
      };
      const known = typeof code === 'string' ? code : null;
      return {
        code: known,
        message:
          typeof message === 'string' && message.trim() !== ''
            ? message
            : consentRefusalMessage(known ?? undefined),
        ...(typeof unlocksAt === 'number' ? { unlocksAt } : {}),
      };
    }
  }
  return { code: null, message: CONSENT_REFUSAL_FALLBACK };
}

/** The acceptance's refusals that are about the Account step's fields, not the terms. */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set([
  'account_required',
  'underage',
  'name_invalid',
  'username_invalid',
  'username_taken',
  'username_cooldown',
]);

/** Whether a refusal sends a new account back to the Account step to fix a field. */
export function isAccountRefusal(code: string | null): boolean {
  return code !== null && ACCOUNT_REFUSALS.has(code);
}
