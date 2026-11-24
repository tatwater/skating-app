import { consentRefusalMessage, isCannotActRefusal } from '@skating/core';
import { ConvexError } from 'convex/values';

import { markCannotAct } from '@/lib/entryHold';

import { toast } from '../../kit/toast';

/** A refusal as the way in reads it: its code (if it named one) and the words to say. */
export interface ConsentRefusal {
  code: string | undefined;
  message: string;
  /** The profile gate's own refusal: this account can't act right now (suspended, or locked out). */
  cannotAct: boolean;
}

/** Plain-string refusals that are no sentence for a skater: the session lapsed mid-call. */
const UNSHOWN = new Set(['Not authenticated']);

/**
 * What a consent mutation's failure says (B03 §9.5), as the phone reads it (`consentClient`). The
 * consent refusals arrive as `ConvexError({ code, message })` and the server's own message wins; a
 * refusal with a code and no words gets core's for that code. A plain-string `ConvexError` — the
 * profile gate's "Account is suspended" — is already a sentence for a person and is shown as it is,
 * except "Not authenticated", which only means the session lapsed. Anything else (a network
 * failure, Convex's redacted server error) gets core's fallback: its text is for logs, not people.
 */
export function readConsentRefusal(error: unknown): ConsentRefusal {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === 'string') {
      return {
        code: undefined,
        message: data.trim() === '' || UNSHOWN.has(data) ? consentRefusalMessage(undefined) : data,
        cannotAct: isCannotActRefusal(data),
      };
    }
    if (typeof data === 'object' && data !== null) {
      const code = (data as { code?: unknown }).code;
      const message = (data as { message?: unknown }).message;
      const named = typeof code === 'string' ? code : undefined;
      return {
        code: named,
        message:
          typeof message === 'string' && message.length > 0
            ? message
            : consentRefusalMessage(named),
        cannotAct: false,
      };
    }
  }
  return { code: undefined, message: consentRefusalMessage(undefined), cannotAct: false };
}

/**
 * Says a refusal the one way the skater app says one (D268): a toast, never a line on the form.
 * Returns what it read, so the caller can act on the code. The profile gate's own refusal — the
 * account can't act right now — also tells the gate (`markCannotAct`), which sends the skater to the
 * app instead of leaving them on a step every press of which is refused: a device clock ahead of
 * the server's can route a still-suspended account to the way in early.
 */
export function toastRefusal(error: unknown): ConsentRefusal {
  const refusal = readConsentRefusal(error);
  toast({ title: refusal.message, tone: 'bad' });
  if (refusal.cannotAct) markCannotAct();
  return refusal;
}

/** What a consent write reports about the browser it came from (stored labeled client-reported). */
export function clientReport(): { surface: 'web'; userAgent?: string } {
  const userAgent = typeof navigator === 'undefined' ? undefined : navigator.userAgent;
  return { surface: 'web', ...(userAgent ? { userAgent } : {}) };
}
