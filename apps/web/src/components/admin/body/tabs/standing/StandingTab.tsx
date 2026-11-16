import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type RemovalReason, standingOf } from '@skating/core';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useMemo } from 'react';

import {
  isFailed,
  type Loadable,
  read,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';
import { sendFor, useBodyHold } from '../../frame/currentBody';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody, useTickingNow } from '../tabParts';
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
    savedPutInsCapped: r.savedPutInsCapped,
    putInKeeps: r.putInKeeps,
  };
}

const NOT_RECORDED: RetentionFacts = {
  lastActivity: null,
  curatedBoost: null,
  favorites: null,
  savedPutIns: null,
  putInKeeps: null,
};

/**
 * The retention read's four answers as the lanes take them: on its way (`undefined`), failed
 * (`'error'`), settled with no such body (every fact not recorded, never zero), or its facts.
 */
export function retentionOf(got: Loadable<Retention | null>): RetentionFacts | 'error' | undefined {
  if (got === undefined) return undefined;
  if (isFailed(got)) return 'error';
  return got === null ? NOT_RECORDED : retentionFacts(got);
}

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
  const hold = useBodyHold();
  // The instant the lanes start from, moved on hourly: the finest thing they draw is a day.
  const now = useTickingNow(3_600_000);
  const retentionRead = got.retention;
  const retention = useMemo(() => retentionOf(retentionRead), [retentionRead]);

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

  // The form waits on the write; a refusal off this console (`false`) was said there, and this form
  // went with it.
  const write = async (run: () => Promise<unknown>, title: string): Promise<void> => {
    await sendFor(hold, {
      body: bodyId,
      write: run,
      receipt: (subject) => announce({ title, target, subject }),
      what: title,
    });
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
