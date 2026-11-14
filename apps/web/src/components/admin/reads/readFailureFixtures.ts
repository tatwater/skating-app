import type { ReadFailure } from './consoleReads';

/**
 * Test and story support: a failed read, as the console's read layer hands one back. Fixture-named,
 * so the guard keeps it out of anything the app mounts.
 */
export const FAILED_READ: ReadFailure = { failed: true, pending: false, retry: () => {} };

/** A failed read whose *Try again* is `retry` (a spy, in a test or a story). */
export function failedRead(retry: () => void = () => {}, pending = false): ReadFailure {
  return { failed: true, pending, retry };
}
