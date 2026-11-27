import type { ReactElement } from 'react';

import { Tag } from '@/components/kit/badge';
import { Lanes } from '@/components/kit/lanes';

import type { LaneTailView } from './machineryTypes';
import {
  CORPUS,
  LANES_LABEL,
  LOCAL_TAG,
  laneTailWords,
  PIPELINES_GROUP,
} from './words/machineryWords';

/**
 * **Machinery's sidebar** (board 6.2's lanes), on the kit's `Lanes` as Corpus's is: one group,
 * *Pipelines*, and in it only the pages that are built — today *Corpus*, with its *Local* tag (it
 * runs on the operator's machine, not on Convex) and its tail, the newest run's word: *stalled* or
 * *failed* in red, *late*, *waiting* or *no heartbeat* in amber, *running* lit, else *ok* and how
 * long ago. A tail no read gives is absent, never a guess. No *Health*, no *Cost ledger*, no other
 * pipeline until each page lands; no tooltips (this is navigation).
 *
 * Routing is the caller's: `link` returns the router's link for a lane.
 */

/** The lanes 8a builds, in the sidebar's order. */
export const MACHINERY_LANES = [{ id: 'corpus', label: CORPUS, where: LOCAL_TAG }] as const;
export type MachineryLaneId = (typeof MACHINERY_LANES)[number]['id'];

export type MachineryLanesProps = {
  /** Each lane's tail, as `machineryRuns.lanes` answers; absent while it loads or failed. */
  tails: Readonly<Partial<Record<MachineryLaneId, LaneTailView>>>;
  selected: MachineryLaneId;
  /** The tails' clock (an *ok* lane says how long ago). */
  now: number;
  /** The router's link for a lane. */
  link?: (id: MachineryLaneId) => ReactElement;
  onSelect?: (id: MachineryLaneId) => void;
};

export function MachineryLanes({ tails, selected, now, link, onSelect }: MachineryLanesProps) {
  return (
    <Lanes
      label={LANES_LABEL}
      selected={selected}
      {...(onSelect !== undefined && {
        onSelect: (id: string) => onSelect(id as MachineryLaneId),
      })}
      {...(link !== undefined && { link: (lane) => link(lane.id as MachineryLaneId) })}
      groups={[
        {
          label: PIPELINES_GROUP,
          lanes: MACHINERY_LANES.map((l) => {
            const tail = tails[l.id];
            const words = tail === undefined ? null : laneTailWords(tail.state, tail.at, now);
            return {
              id: l.id,
              label: l.label,
              tail: <Tag>{l.where}</Tag>,
              ...(words !== null && { count: words.word, countTone: words.tone }),
            };
          }),
        },
      ]}
    />
  );
}
