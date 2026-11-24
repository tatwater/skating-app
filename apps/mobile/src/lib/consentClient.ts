/**
 * What the phone tells the consent functions about itself, and how it reads their refusals (B03
 * §9.5). Pure, so the rules are tested without a device.
 */

import { CONSENT_REFUSAL_FALLBACK, consentRefusalMessage, isCannotActRefusal } from '@skating/core';
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
  /**
   * The profile gate's own refusal: this account can't act right now (suspended, or locked out).
   * Said in the server's words, and nothing else: no route follows it (B03 §9.17).
   */
  cannotAct?: true;
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
      return {
        code: null,
        message: UNSHOWN.has(data) ? CONSENT_REFUSAL_FALLBACK : data,
        ...(isCannotActRefusal(data) ? { cannotAct: true as const } : {}),
      };
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

/**
 * A welcome step's own write failed (`setHome`, `updateProfile`): the profile gate's can't-act
 * refusal keeps the server's words, as from any way-in call; anything else is the step's `notSaved`
 * line.
 */
export function readSaveRefusal(error: unknown, notSaved: string): Refusal {
  const refusal = readRefusal(error);
  return refusal.cannotAct ? refusal : { code: null, message: notSaved };
}
