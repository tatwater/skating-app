/**
 * **The caller's clock, held near the server's** — for a read that takes the page's clock as an
 * argument.
 *
 * A Convex query is cached on the rows it reads, and an answer that turns on the time (a job falling
 * late, a new day's window, a scan ranged through today) is a change in the clock, not in any row:
 * without the clock as an argument, a read cached earlier keeps its old answer until some row it read
 * moves. So the page sends its clock, rounded to what the answer turns on (the minute, the day), and
 * the server reads at that clock — held within `slackMs` of its own, so a skewed client can't move the
 * answer by more than the slack. A missing or non-finite clock reads the server's.
 */
export function callerNow(asked: number | undefined, serverNow: number, slackMs: number): number {
  if (asked === undefined || !Number.isFinite(asked)) return serverNow;
  return Math.min(Math.max(asked, serverNow - slackMs), serverNow + slackMs);
}
