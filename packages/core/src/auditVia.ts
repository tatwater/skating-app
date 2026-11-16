/**
 * What an audit row was done **through** (D256): the script or agent a person made a write with.
 *
 * When a script or an agent makes a write as a person, the person stays the actor, and the row
 * records the tool by name. The console reads it as "Teagan via seed-destinations". It is a label,
 * never a permission: nothing decides anything on it, so the most a forged one can do is mislabel the
 * forger's own row.
 *
 * One rule for its two readers: the script runner (`@skating/run-log`'s `convexRun`) refuses a name
 * that fails it before the call goes out, and the audit writer (`lib/audit.ts`) stores only a name
 * that passes it.
 */

/** The longest name a row records. Script names are a few words; this leaves room and no more. */
export const AUDIT_VIA_MAX_LENGTH = 40;

/** Lowercase letters and digits in hyphen-joined words: `seed-destinations`, `agent-b01`. */
const AUDIT_VIA_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `value` is a name an audit row may record as what it was done through. */
export function isAuditVia(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AUDIT_VIA_MAX_LENGTH &&
    AUDIT_VIA_PATTERN.test(value)
  );
}

/**
 * The longest reason an audit row takes (D261): 2,000 characters, counted as JavaScript counts a
 * string's length. Refused past it at the one place a reason enters the log (`lib/audit.writeAudit`),
 * so no writer is missed; rows written before the cap are left as they are.
 */
export const AUDIT_REASON_MAX = 2_000;

/** The refusal a reason past {@link AUDIT_REASON_MAX} gets, in words the page can show. */
export const AUDIT_REASON_TOO_LONG = `A reason can be at most ${AUDIT_REASON_MAX.toLocaleString('en-US')} characters.`;
