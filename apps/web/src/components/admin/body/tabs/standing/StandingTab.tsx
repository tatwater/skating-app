import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type RemovalReason, standingOf } from '@skating/core';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { isFailed, read, useConsoleReadSet } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody } from '../tabParts';
import { StandingTabView } from './StandingTabView';
import type { RetentionFacts } from './standingModel';

/**
 * Body › Standing, wired: the body's standing from `waterBodies.get`, what keeps it active from
 * `standing.retentionForBody` — the newest use by the rollover's own rule, the map boost and when
 * it was set, favorites (counted to 1,000, a floor past that) and saved put-ins (D245) — and the
 * three writes the old editor's Standing card made: `standing.setStanding` (`body.standing`),
 * `waterBodies.remove` and `waterBodies.restore` (`body.remove`), each announced to the shell's
 * Undo, which offers the server's undo when there is one.
 *
 * Each read is keyed on its values; a failed one says so in its place with *Try again*, and a
 * retention read on its way holds the lanes' place — never drawn as nothing keeping the body.
 */
export function StandingTab(props: BodyTabProps) {
  return <StandingReads {...props} />;
}

type Retention = NonNullable<FunctionReturnType<typeof api.standing.retentionForBody>>;

/** The retention read as the lanes take it: absent facts are none, never unread. */
export function retentionFacts(r: Retention): RetentionFacts {
  return {
    lastActivity: r.lastActivity,
    curatedBoost: r.curatedBoost,
    favorites: r.favorites,
    favoritesCapped: r.favoritesCapped,
    savedPutIns: r.savedPutIns,
  };
}

const NOT_RECORDED: RetentionFacts = {
  lastActivity: null,
  curatedBoost: null,
  favorites: null,
  savedPutIns: null,
};

function StandingReads({ bodyId: id }: BodyTabProps) {
  const bodyId = id as Id<'waterBodies'>;
  const {
    reads: got,
    retry,
    pending,
  } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId: bodyId }),
    retention: read(api.standing.retentionForBody, { waterBodyId: bodyId }),
  });
  const setStanding = useMutation(api.standing.setStanding);
  const remove = useMutation(api.waterBodies.remove);
  const restore = useMutation(api.waterBodies.restore);
  const { can } = useRole();
  const { announce } = useUndo();
  const now = useHourClock();
  const retentionRead = got.retention;
  const retention = useMemo(
    () =>
      retentionRead === undefined
        ? undefined
        : isFailed(retentionRead)
          ? ('error' as const)
          : retentionRead === null
            ? // No such body on the server: every fact is not recorded, never zero.
              NOT_RECORDED
            : retentionFacts(retentionRead),
    [retentionRead],
  );

  const result = got.body;
  if (result === undefined) {
    return (
      <TabBody aria-busy="true">
        {/* The tab's note, mounted from the first state, so a failure's words are announced. */}
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
        <LoadingSection lines={4} />
        <LoadingSection lines={3} />
      </TabBody>
    );
  }
  if (isFailed(result)) {
    return (
      <TabBody>
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
      </TabBody>
    );
  }
  if (result === null || !result.available) {
    return (
      <StandingTabView
        standing={{ standing: 'unlisted' }}
        activeSince={null}
        retention={undefined}
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

  return (
    <StandingTabView
      standing={standingOf(body)}
      activeSince={body.activatedAt ?? null}
      retention={retention}
      onRetry={retry}
      retryPending={pending}
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

/**
 * The Standing tab's registration in the frame's registry. It draws nothing on the map of its own
 * (its board's one hover plate, a GNIS town, is the frame's own mark), so it has no `map`.
 */
export const STANDING_TAB: BodyTabRegistration = { Wiring: StandingTab };

/** The instant the lanes start from, moved on hourly: the coarsest thing they draw is a day. */
function useHourClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
