/**
 * How long a person's free text may be, decided at the write (B01, the read-budget inventory).
 *
 * Each of these fields was uncapped, so every read of its rows had to be charged as a whole document.
 * No client sets a limit on any of them (the web and phone apps write none of them with a
 * `maxLength`), so the caps are the founder-approved defaults. A write past one is refused with a
 * message a person can act on; rows already longer stay as they are.
 */

/**
 * An access alert's note: a sentence about a gate, not an essay. Unlike the caps below, the alert
 * writer has always cut a longer note to this rather than refused it, and still does.
 */
export const ACCESS_ALERT_NOTE_MAX_CHARS = 500;
/** A photo's caption. */
export const PHOTO_CAPTION_MAX_CHARS = 500;
/** The note a person adds to a flag. */
export const FLAG_NOTE_MAX_CHARS = 1_000;
/** An offline write's retry key: the apps send a UUID, about 36 characters. */
export const IDEMPOTENCY_KEY_MAX_CHARS = 128;

/**
 * What a person is told when their text is past its cap, or `null` when it fits. `what` names the
 * field the way the person knows it ("The caption", "The note"). Counted in characters as
 * JavaScript counts them, as every other cap in the app is.
 */
export function tooLongMessage(what: string, text: string | undefined, max: number): string | null {
  if (text === undefined || text.length <= max) return null;
  return `${what} is ${text.length.toLocaleString('en-US')} characters. Shorten it to ${max.toLocaleString('en-US')} or fewer.`;
}
