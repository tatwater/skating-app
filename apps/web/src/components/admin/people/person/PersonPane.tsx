import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { useRole } from '@/lib/useRole';

import { isFailed, read, useConsoleReadSet } from '../../reads/consoleReads';
import { actionLabel } from '../../shell/actionLabels';
import { useMinuteNow } from '../../shell/presence';
import { useUndo } from '../../shell/undo';
import { type LinkTo, personHref } from './PersonFeeds';
import { PersonView } from './PersonView';
import type { PersonRead } from './personModel';
import { usePersonWrites } from './usePersonWrites';

/**
 * **The person page, wired** — the detail pane for one person, standing alone in its route or beside
 * the People list. It takes the person's id and the path back to the list, runs the page's reads
 * through the console's one read layer (each loading, failed or answered on its own; one retry
 * registry; Sentry once per failure) and its writes through one action hook, and hands both to
 * `PersonView`.
 *
 * - **Reads**: `people.person` and `people.reportTrend` (`people.read`); `people.history`,
 *   `people.staffStats`, `people.staffSeason` and `people.decisions` (`audit.read`, skipped
 *   without it). Every one is asked at once — none waits on another's answer — and the two staff
 *   reads answer `null` for a skater, so the page never depends on the order they land in.
 * - **The clock**: the reads are asked at the minute the person was opened, held while the page
 *   stays open (a new minute never restarts a subscription); the words on the page ("1 day left")
 *   read the live minute.
 * - **An id of the wrong shape** never reaches a query: it is *No such person* at once.
 */
export type PersonPaneProps = {
  /** The person's id, from the route. */
  userId: string;
  /** Where the page's way back goes (the People list, with its lane). */
  returnTo?: string;
  className?: string;
};

/** A Convex id's shape, so a hand-edited URL never reaches a query as junk. */
const ID_SHAPE = /^[0-9a-z]{30,34}$/;

/** How many decisions a page asks for first, and the most a page may hold. */
const DECISIONS_FIRST = 25;
const DECISIONS_MOST = 100;
/** History's rows (the read's default). */
const HISTORY_ROWS = 50;

export function PersonPane({ userId, returnTo, className }: PersonPaneProps) {
  const { can, userId: viewerId } = useRole();
  const live = useMinuteNow();
  const held = useHeldClock(userId);
  const [decisionRows, setDecisionRows] = useState(DECISIONS_FIRST);
  const valid = ID_SHAPE.test(userId);
  const id = userId as Id<'profiles'>;
  const audit = can('audit.read');
  const people = can('people.read');

  const { reads } = useConsoleReadSet({
    person: valid && people ? read(api.people.person, { userId: id, now: held }) : null,
    trend: valid && people ? read(api.people.reportTrend, { userId: id, now: held }) : null,
    history: valid && audit ? read(api.people.history, { userId: id, limit: HISTORY_ROWS }) : null,
    staffStats: valid && audit ? read(api.people.staffStats, { userId: id, now: held }) : null,
    staffSeason: valid && audit ? read(api.people.staffSeason, { userId: id, now: held }) : null,
    decisions:
      valid && audit ? read(api.people.decisions, { userId: id, limit: decisionRows }) : null,
  });

  const person = reads.person;
  const loaded =
    person === undefined || person === null || isFailed(person) ? null : (person as PersonRead);
  const onAct = usePersonWrites(
    loaded === null
      ? null
      : {
          userId: loaded.userId,
          displayName: loaded.displayName,
          defaultBountyLimit: loaded.rights.defaultBountyLimit,
        },
    live,
  );
  const { undo } = useUndo();
  const back = returnTo ?? personHref({ kind: 'people' });
  const linkTo: LinkTo = (to) => <Link to={to.kind === 'people' ? back : personHref(to)} />;

  return (
    <PersonView
      // A malformed id, or a viewer without the read, is no such person to this page.
      person={!valid || !people ? null : person}
      trend={reads.trend}
      history={audit ? reads.history : 'not-shown'}
      staffStats={reads.staffStats}
      staffSeason={reads.staffSeason}
      decisions={reads.decisions}
      now={live}
      viewerId={viewerId ?? null}
      linkTo={linkTo}
      onAct={onAct}
      onUndo={(row) =>
        undo({
          actionId: row.id,
          needsReason: row.undo.state === 'available' && row.undo.needsReason,
          what: actionLabel(row.action, row.targetType),
        })
      }
      {...(decisionRows < DECISIONS_MOST && {
        onMoreDecisions: () => setDecisionRows((n) => Math.min(DECISIONS_MOST, n * 2)),
      })}
      {...(className !== undefined && { className })}
    />
  );
}

/** The minute `key` was opened, held while it stays open; a new key takes the minute it opens at. */
function useHeldClock(key: string): number {
  const [clock, setClock] = useState(() => ({ key, at: minute(Date.now()) }));
  if (clock.key !== key) {
    const next = { key, at: minute(Date.now()) };
    setClock(next);
    return next.at;
  }
  return clock.at;
}

const minute = (at: number) => Math.floor(at / 60_000) * 60_000;
