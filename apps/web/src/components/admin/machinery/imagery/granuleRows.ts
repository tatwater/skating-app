import { shortAge } from '@/lib/ages';

import type { RunChip } from '../corpus/runRows';
import {
  capturedAtOf,
  dayClock,
  type GranuleRowView,
  type GranuleStatus,
  granuleAgeFrom,
  granuleTitle,
} from './imageryModel';
import * as W from './imageryWords';

/**
 * **A granule's row, as the list draws it** (board 6.4's middle column) — pure, from the server's
 * row and the page's clock:
 *
 * - **The state chip** by status: *failed* red (it won't go again without a person), *cutting* lit
 *   (a Machine is on it), *queued*, *empty* and *landed* quiet.
 * - **The attempts chip** once a granule has had more than one, or has failed.
 * - **The sub-line** says what the row knows: the capture, and for a cut on a Machine how long it's
 *   been up; a queued one waits for a machine (never a next-run time: the pump's phase can't be
 *   read, ruling 17); an empty cut says the cutter's own reason, never cloud; a failed one its last
 *   error.
 * - **The age**: since it settled, was spawned, or was queued.
 */
export type GranuleRowModel = {
  id: string;
  title: string;
  state: RunChip;
  attempts: RunChip | null;
  sub: string;
  age: string;
};

const STATE_TONE: Record<GranuleStatus, RunChip['tone']> = {
  failed: 'bad',
  spawned: 'lit',
  queued: 'default',
  empty: 'default',
  landed: 'ok',
};

export function granuleRowModel(
  row: GranuleRowView,
  now: number,
  timeZone?: string,
): GranuleRowModel {
  const capturedAt = capturedAtOf(row);
  const captured =
    capturedAt === null ? W.captured(row.capturedAt) : W.captured(dayClock(capturedAt, timeZone));
  let sub: string;
  switch (row.status) {
    case 'empty':
      sub = W.nothingToCut(row.emptyReason);
      break;
    case 'spawned':
      sub =
        row.spawnedAt === null
          ? captured
          : `${captured} · ${W.machineUp(shortAge(now - row.spawnedAt))}`;
      break;
    case 'queued':
      sub = `${captured} · ${W.WAITING_FOR_MACHINE}`;
      break;
    case 'failed':
      sub = row.lastError === null ? captured : `${captured} · ${row.lastError}`;
      break;
    case 'landed':
      sub = `${captured} · ${W.FRAME_LANDED}`;
      break;
  }
  return {
    id: row.id,
    title: granuleTitle(row),
    state: { label: W.STATUS_WORDS[row.status], tone: STATE_TONE[row.status] },
    attempts:
      row.attempts > 1 || (row.status === 'failed' && row.attempts > 0)
        ? { label: W.attemptsWords(row.attempts), tone: 'default' }
        : null,
    sub,
    age: shortAge(now - granuleAgeFrom(row)),
  };
}
