import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type RemovalReason, standingOf } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';

import { StandingTabView } from './StandingTabView';
import type { RetentionFacts } from './standingModel';

/**
 * Body › Standing, wired: the body's standing from `waterBodies.get`, its saved put-ins from
 * `putIns.listForBody` (D245: a stored, unsuppressed launch — every marker that is a row), and the
 * three writes the old editor's Standing card made — `standing.setStanding` (`body.standing`),
 * `waterBodies.remove` and `waterBodies.restore` (`body.remove`) — each announced to the shell's
 * Undo, which offers the server's undo when there is one.
 *
 * Favorites and the last use have no read yet (a seam request): those lanes are *Not recorded
 * yet*, never zero.
 */
export function StandingTab({ bodyId }: { bodyId: Id<'waterBodies'> }) {
  const result = useQuery(api.waterBodies.get, { waterBodyId: bodyId });
  const putIns = useQuery(api.putIns.listForBody, { waterBodyId: bodyId });
  const setStanding = useMutation(api.standing.setStanding);
  const remove = useMutation(api.waterBodies.remove);
  const restore = useMutation(api.waterBodies.restore);
  const { can } = useRole();
  const { announce } = useUndo();
  const now = useHourClock();

  if (result === undefined) return null;
  if (result === null || !result.available) {
    return (
      <StandingTabView
        standing={{ standing: 'unlisted' }}
        activeSince={null}
        retention={null}
        now={now}
        canSetStanding={false}
        canRemove={false}
      />
    );
  }
  const body = result.body;
  const target = { targetType: 'waterbody' as const, targetId: bodyId };

  const write = async (run: () => Promise<unknown>, title: string) => {
    try {
      await run();
    } catch (err) {
      throw new Error(errorText(err));
    }
    await announce({ title, target });
  };

  const retention: RetentionFacts = {
    lastActivity: null,
    curatedBoost:
      body.curatedBoost === undefined ? undefined : { value: body.curatedBoost, at: null },
    favorites: null,
    savedPutIns: putIns === undefined ? null : putIns.filter((m) => m.id !== undefined).length,
  };

  return (
    <StandingTabView
      standing={standingOf(body)}
      activeSince={body.activatedAt ?? null}
      retention={retention}
      now={now}
      canSetStanding={can('body.standing')}
      canRemove={can('body.remove')}
      onSetDormant={(note) =>
        write(
          () =>
            setStanding({
              waterBodyId: bodyId,
              standing: 'dormant',
              ...(note !== '' ? { note } : {}),
            }),
          'Set dormant',
        )
      }
      onSetActive={() =>
        write(
          () => setStanding({ waterBodyId: bodyId, standing: 'active' }),
          'Back on the active map',
        )
      }
      onRemove={(reason: RemovalReason) =>
        write(() => remove({ waterBodyId: bodyId, reason }), 'Removed from the map')
      }
      onRestore={() => write(() => restore({ waterBodyId: bodyId }), 'Restored to the map')}
    />
  );
}

/** The instant the lanes start from, moved on hourly: the coarsest thing they draw is a day. */
function useHourClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
